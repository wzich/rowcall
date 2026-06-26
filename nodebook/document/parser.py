"""AST parser for strict Python Nodebook documents."""

from __future__ import annotations

import ast
import hashlib
import textwrap
from pathlib import Path
from typing import Any

from .models import (
    DocumentEdge,
    DocumentNode,
    ExecutableDocument,
    ParseResult,
    SourceRange,
    ValidationIssue,
)
from .validation import validate_document


def load_document(path: str | Path) -> ParseResult:
    document_path = Path(path).expanduser().resolve()
    return parse_source(document_path.read_text(), document_path)


def parse_source(source: str, document_path: str | Path) -> ParseResult:
    path = Path(document_path).expanduser().resolve()
    try:
        module = ast.parse(source, filename=str(path))
    except SyntaxError as error:
        issue = ValidationIssue(
            kind="invalid_python",
            message=error.msg,
            path=_path_for(error.lineno, error.offset),
        )
        return ParseResult(ok=False, document=None, issues=(issue,))

    lines = source.splitlines()
    issues: list[ValidationIssue] = []
    _validate_nodebook_imports(module, issues)
    decoded_nodes = _decode_nodes(module, lines, issues)
    edges = _decode_edges(module, decoded_nodes, issues)
    excluded = _excluded_source_lines(module, [node.function_def for node in decoded_nodes], lines)
    globals_code = _source_without_lines(lines, excluded).strip()
    nodes = tuple(_build_node(node, lines, globals_code) for node in decoded_nodes if node.node_id is not None and node.outputs is not None)

    document = ExecutableDocument(
        path=path,
        source=source,
        revision=hashlib.sha256(source.encode("utf-8")).hexdigest(),
        globals_code=globals_code,
        nodes=nodes,
        edges=tuple(edges),
    )
    validation = validate_document(document)
    all_issues = tuple([*issues, *validation.issues])
    document = ExecutableDocument(
        path=document.path,
        source=document.source,
        revision=document.revision,
        globals_code=document.globals_code,
        nodes=document.nodes,
        edges=document.edges,
        issues=all_issues,
        version=document.version,
    )
    return ParseResult(ok=len(all_issues) == 0, document=document, issues=all_issues)


class _DecodedNode:
    def __init__(
        self,
        function_def: ast.FunctionDef,
        node_id: str | None,
        outputs: tuple[str, ...] | None,
        invalid_decorator: bool,
    ) -> None:
        self.function_def = function_def
        self.node_id = node_id
        self.outputs = outputs
        self.invalid_decorator = invalid_decorator


def _decode_nodes(module: ast.Module, lines: list[str], issues: list[ValidationIssue]) -> list[_DecodedNode]:
    decoded: list[_DecodedNode] = []
    node_function_names: set[str] = set()

    for statement in module.body:
        if not isinstance(statement, ast.FunctionDef):
            continue
        metadata = _decode_node_decorator(statement, issues)
        if metadata is None:
            continue
        decoded.append(metadata)
        node_function_names.add(statement.name)

    for decoded_node in decoded:
        function_def = decoded_node.function_def
        node_id = decoded_node.node_id or function_def.name

        if decoded_node.invalid_decorator:
            issues.append(
                ValidationIssue(
                    kind="wrong_type",
                    message="Node decorators must provide keyword-only string id and list[str] outputs",
                    node_id=node_id,
                    path=_statement_path(function_def),
                )
            )

        _validate_function_shape(function_def, node_id, issues)
        _validate_node_decorators(function_def, node_id, issues)
        _validate_no_direct_node_calls(function_def, node_id, node_function_names, issues)

    return decoded


def _decode_node_decorator(function_def: ast.FunctionDef, issues: list[ValidationIssue]) -> _DecodedNode | None:
    for decorator in function_def.decorator_list:
        if not _is_node_decorator_syntax(decorator):
            continue
        if not _is_node_call(decorator):
            return _DecodedNode(function_def, None, None, True)

        node_id: str | None = None
        outputs: tuple[str, ...] | None = None
        invalid = False

        if decorator.args:
            invalid = True

        seen_keywords: set[str] = set()
        for keyword in decorator.keywords:
            if keyword.arg is None:
                invalid = True
                continue
            if keyword.arg in seen_keywords:
                invalid = True
            seen_keywords.add(keyword.arg)

            if keyword.arg == "id":
                node_id = _literal_string(keyword.value)
                if node_id is None:
                    invalid = True
            elif keyword.arg == "outputs":
                outputs = _literal_string_tuple(keyword.value)
                if outputs is None:
                    invalid = True
            else:
                invalid = True
                issues.append(
                    ValidationIssue(
                        kind="unsupported_python",
                        message=f"Unsupported node decorator argument '{keyword.arg}'",
                        node_id=node_id or function_def.name,
                        path=_path_for(keyword.value.lineno, keyword.value.col_offset + 1),
                    )
                )

        if node_id is None or outputs is None:
            invalid = True

        return _DecodedNode(function_def, node_id, outputs, invalid)

    return None


def _is_node_decorator_syntax(value: ast.AST) -> bool:
    return (isinstance(value, ast.Name) and value.id == "node") or _is_node_call(value)


def _is_node_call(value: ast.AST) -> bool:
    return isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "node"


def _validate_node_decorators(
    function_def: ast.FunctionDef,
    node_id: str,
    issues: list[ValidationIssue],
) -> None:
    node_decorators = [
        decorator
        for decorator in function_def.decorator_list
        if _is_node_decorator_syntax(decorator)
    ]
    if len(node_decorators) > 1:
        issues.append(
            ValidationIssue(
                kind="unsupported_python",
                message="Node functions must have exactly one @node(...) decorator",
                node_id=node_id,
                path=_statement_path(function_def),
            )
        )

    for decorator in function_def.decorator_list:
        if _is_node_decorator_syntax(decorator):
            continue
        issues.append(
            ValidationIssue(
                kind="unsupported_python",
                message="Node functions may not use decorators other than @node(...)",
                node_id=node_id,
                path=_statement_path(decorator),
            )
        )


def _literal_string(value: ast.AST | None) -> str | None:
    return value.value if isinstance(value, ast.Constant) and isinstance(value.value, str) else None


def _literal_string_tuple(value: ast.AST) -> tuple[str, ...] | None:
    if not isinstance(value, ast.List):
        return None
    result: list[str] = []
    for item in value.elts:
        text = _literal_string(item)
        if text is None:
            return None
        result.append(text)
    return tuple(result)


def _validate_function_shape(function_def: ast.FunctionDef, node_id: str, issues: list[ValidationIssue]) -> None:
    if function_def.args.vararg is not None or function_def.args.kwarg is not None:
        issues.append(
            ValidationIssue(
                kind="unsupported_python",
                message="Node functions may not use *args or **kwargs",
                node_id=node_id,
                path=_statement_path(function_def),
            )
        )

    if function_def.args.posonlyargs:
        issues.append(
            ValidationIssue(
                kind="unsupported_python",
                message="Node functions may not use positional-only parameters",
                node_id=node_id,
                path=_statement_path(function_def),
            )
        )

    for argument in [*function_def.args.args, *function_def.args.kwonlyargs]:
        if argument.arg.startswith("__nodebook_"):
            issues.append(
                ValidationIssue(
                    kind="unsupported_python",
                    message="Node parameter names may not start with __nodebook_",
                    node_id=node_id,
                    path=_path_for(argument.lineno, argument.col_offset + 1),
                )
            )


def _validate_no_direct_node_calls(
    function_def: ast.FunctionDef,
    node_id: str,
    function_names: set[str],
    issues: list[ValidationIssue],
) -> None:
    for child in ast.walk(function_def):
        if not isinstance(child, ast.Call):
            continue
        if not isinstance(child.func, ast.Name):
            continue
        if child.func.id not in function_names:
            continue
        if child.func.id == function_def.name:
            continue
        issues.append(
            ValidationIssue(
                kind="unsupported_python",
                message=(
                    f"Node function '{function_def.name}' calls node "
                    f"'{child.func.id}' directly. Add an explicit edge instead."
                ),
                node_id=node_id,
                path=_path_for(child.lineno, child.col_offset + 1),
            )
        )


def _validate_nodebook_imports(module: ast.Module, issues: list[ValidationIssue]) -> None:
    for statement in module.body:
        if not _is_nodebook_from_import(statement):
            continue
        for alias in statement.names:
            if alias.asname is None:
                continue
            issues.append(
                ValidationIssue(
                    kind="unsupported_python",
                    message="from nodebook imports may not use aliases",
                    path=_statement_path(statement),
                )
            )


def _decode_edges(
    module: ast.Module,
    nodes: list[_DecodedNode],
    issues: list[ValidationIssue],
) -> list[DocumentEdge]:
    ids_by_function = {
        node.function_def.name: node.node_id
        for node in nodes
        if node.node_id is not None
    }
    edges: list[DocumentEdge] = []

    for statement in module.body:
        call = statement.value if isinstance(statement, ast.Expr) else None
        if not _looks_like_depends_on_call(call):
            continue

        if not _is_depends_on_call(call):
            issues.append(
                ValidationIssue(
                    kind="unsupported_python",
                    message="depends_on declarations must be top-level child.depends_on(parent, ...) calls",
                    path=_statement_path(statement),
                )
            )
            continue

        downstream_name = call.func.value.id
        downstream_id = ids_by_function.get(downstream_name)
        if downstream_id is None:
            issues.append(
                ValidationIssue(
                    kind="missing_node_reference",
                    message=f"Edge references nonexistent downstream node {downstream_name}",
                    path=_statement_path(statement),
                )
            )
            continue

        if call.keywords:
            issues.append(
                ValidationIssue(
                    kind="unsupported_python",
                    message="depends_on declarations may not use keyword arguments",
                    node_id=downstream_id,
                    path=_statement_path(statement),
                )
            )

        if not call.args:
            issues.append(
                ValidationIssue(
                    kind="unsupported_python",
                    message="depends_on declarations must include at least one upstream node",
                    node_id=downstream_id,
                    path=_statement_path(statement),
                )
            )

        for argument in call.args:
            if not isinstance(argument, ast.Name):
                issues.append(
                    ValidationIssue(
                        kind="unsupported_python",
                        message="depends_on arguments must be node function names",
                        node_id=downstream_id,
                        path=_path_for(argument.lineno, argument.col_offset + 1),
                    )
                )
                continue
            upstream_id = ids_by_function.get(argument.id)
            if upstream_id is None:
                issues.append(
                    ValidationIssue(
                        kind="missing_node_reference",
                        message=f"Edge references nonexistent upstream node {argument.id}",
                        node_id=downstream_id,
                        path=_path_for(argument.lineno, argument.col_offset + 1),
                    )
                )
                continue

            edges.append(
                DocumentEdge(
                    from_node=upstream_id,
                    to_node=downstream_id,
                    source_range=_range_for(statement),
                )
            )

    return edges


def _looks_like_depends_on_call(value: ast.AST | None) -> bool:
    return isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute) and value.func.attr == "depends_on"


def _is_depends_on_call(value: ast.AST | None) -> bool:
    return (
        isinstance(value, ast.Call)
        and isinstance(value.func, ast.Attribute)
        and value.func.attr == "depends_on"
        and isinstance(value.func.value, ast.Name)
    )


def _build_node(node: _DecodedNode, lines: list[str], globals_code: str) -> DocumentNode:
    function_def = node.function_def
    outputs = node.outputs or ()
    parameters = _parameter_names(function_def)
    standard_return = _has_standard_generated_return(function_def, outputs)
    function_source = _extract_function_source(lines, function_def)
    display_code = _extract_display_code(lines, function_def, standard_return)
    runtime_code = _build_runtime_code(
        function_source=function_source,
        function_name=function_def.name,
        parameters=parameters,
        outputs=outputs,
    )
    return DocumentNode(
        id=node.node_id or function_def.name,
        function_name=function_def.name,
        outputs=outputs,
        parameters=parameters,
        source_range=_function_source_range(function_def, standard_return),
        function_source=function_source,
        display_code=display_code,
        runtime_code=runtime_code,
        custom_return=not standard_return,
        editable=standard_return,
    )


def _excluded_source_lines(module: ast.Module, node_defs: list[ast.FunctionDef], lines: list[str]) -> set[int]:
    excluded: set[int] = set()
    for function_def in node_defs:
        start = min([function_def.lineno] + [decorator.lineno for decorator in function_def.decorator_list])
        for line_number in range(start, (function_def.end_lineno or function_def.lineno) + 1):
            excluded.add(line_number)

    for statement in module.body:
        if _is_nodebook_from_import(statement) or (
            isinstance(statement, ast.Expr) and _looks_like_depends_on_call(statement.value)
        ):
            for line_number in range(statement.lineno, (statement.end_lineno or statement.lineno) + 1):
                excluded.add(line_number)

    for line_number, line in enumerate(lines, start=1):
        if line.strip() == "# NodeBook graph":
            excluded.add(line_number)

    return excluded


def _is_nodebook_from_import(statement: ast.stmt) -> bool:
    if isinstance(statement, ast.ImportFrom) and statement.module == "nodebook":
        return True
    return False


def _source_without_lines(lines: list[str], excluded_lines: set[int]) -> str:
    return "\n".join(line for index, line in enumerate(lines, start=1) if index not in excluded_lines)


def _extract_function_source(lines: list[str], function_def: ast.FunctionDef) -> str:
    start = function_def.lineno
    end = function_def.end_lineno or function_def.lineno
    return "\n".join(lines[start - 1 : end])


def _extract_display_code(lines: list[str], function_def: ast.FunctionDef, strip_standard_return: bool) -> str:
    body = function_def.body
    if strip_standard_return and body and isinstance(body[-1], ast.Return):
        body = body[:-1]
    if not body:
        return ""
    start = body[0].lineno
    end = body[-1].end_lineno or body[-1].lineno
    return textwrap.dedent("\n".join(lines[start - 1 : end])).strip("\n")


def _function_source_range(function_def: ast.FunctionDef, standard_return: bool) -> SourceRange:
    start = min([function_def.lineno] + [decorator.lineno for decorator in function_def.decorator_list])
    end = function_def.end_lineno or function_def.lineno
    decorator_line = next((decorator.lineno for decorator in function_def.decorator_list if _is_node_call(decorator)), None)
    body_start_line = None
    body_end_line = None
    return_line = None
    return_end_line = None
    indent = None
    if standard_return and function_def.body and isinstance(function_def.body[-1], ast.Return):
        return_statement = function_def.body[-1]
        body_start_line = function_def.body[0].lineno
        body_end_line = return_statement.lineno - 1
        return_line = return_statement.lineno
        return_end_line = return_statement.end_lineno or return_statement.lineno
        indent = " " * return_statement.col_offset

    return SourceRange(
        start_line=start,
        end_line=end,
        start_col=function_def.col_offset + 1,
        end_col=function_def.end_col_offset,
        decorator_line=decorator_line,
        body_start_line=body_start_line,
        body_end_line=body_end_line,
        return_line=return_line,
        return_end_line=return_end_line,
        indent=indent,
    )


def _range_for(statement: ast.stmt) -> SourceRange:
    return SourceRange(
        start_line=statement.lineno,
        end_line=statement.end_lineno or statement.lineno,
        start_col=statement.col_offset + 1,
        end_col=statement.end_col_offset,
    )


def _statement_path(statement: ast.AST) -> str:
    line = getattr(statement, "lineno", None)
    col = getattr(statement, "col_offset", None)
    return _path_for(line, (col + 1) if col is not None else None)


def _path_for(line: int | None, col: int | None) -> str:
    if line is None:
        return ""
    if col is None:
        return str(line)
    return f"{line}:{col}"


def _parameter_names(function_def: ast.FunctionDef) -> tuple[str, ...]:
    return tuple(argument.arg for argument in [*function_def.args.args, *function_def.args.kwonlyargs])


def _has_standard_generated_return(function_def: ast.FunctionDef, outputs: tuple[str, ...]) -> bool:
    if sum(isinstance(child, ast.Return) for child in ast.walk(function_def)) != 1:
        return False
    if not function_def.body:
        return False
    final_statement = function_def.body[-1]
    if not isinstance(final_statement, ast.Return):
        return False
    if not isinstance(final_statement.value, ast.Dict):
        return False

    keys: list[str] = []
    for key in final_statement.value.keys:
        text = _literal_string(key) if key is not None else None
        if text is None:
            return False
        keys.append(text)
    return tuple(keys) == outputs


def _build_runtime_code(
    *,
    function_source: str,
    function_name: str,
    parameters: tuple[str, ...],
    outputs: tuple[str, ...],
) -> str:
    parts = [function_source]
    parts.append(
        "\n".join(
            [
                f"__nodebook_parameters = {list(parameters)!r}",
                f"__nodebook_outputs = {list(outputs)!r}",
                "__nodebook_call_inputs = {",
                "    name: globals()[name]",
                "    for name in __nodebook_parameters",
                "}",
                f"__nodebook_result = {function_name}(**__nodebook_call_inputs)",
                "if not isinstance(__nodebook_result, dict):",
                "    raise TypeError('Node function must return a dict of declared outputs')",
                "__nodebook_missing_outputs = [",
                "    name for name in __nodebook_outputs",
                "    if name not in __nodebook_result",
                "]",
                "if __nodebook_missing_outputs:",
                "    raise NameError(",
                "        'Node function did not return declared outputs: '",
                "        + ', '.join(__nodebook_missing_outputs)",
                "    )",
                "for __nodebook_output_name in __nodebook_outputs:",
                "    globals()[__nodebook_output_name] = __nodebook_result[__nodebook_output_name]",
            ]
        )
    )
    return "\n\n".join(parts)
