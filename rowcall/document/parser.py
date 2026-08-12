"""AST parser for strict Python Rowcall documents."""

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


SUPPORTED_ROWCALL_FROM_IMPORTS = {"display", "node"}
_ROWCALL_NODE = "rowcall_node"
_ALIASED_ROWCALL_NODE = "aliased_rowcall_node"
_ROWCALL_MODULE = "rowcall_module"
_UNKNOWN_BINDING = "unknown"
_SUPPORTED_DECORATOR = "supported"
_UNSUPPORTED_BARE_DECORATOR = "unsupported_bare"
_UNSUPPORTED_ALIASED_DECORATOR = "unsupported_aliased"
_UNSUPPORTED_QUALIFIED_DECORATOR = "unsupported_qualified"
_WILDCARD_IMPORT_BINDING = "<wildcard import>"


def load_document(path: str | Path) -> ParseResult:
    document_path = Path(path).expanduser().resolve()
    return parse_source(document_path.read_text(), document_path)


def parse_source(
    source: str,
    document_path: str | Path,
) -> ParseResult:
    return _parse_source(source, document_path, validate_output_bindings=True)


def _parse_source_for_rewrite(
    source: str,
    document_path: str | Path,
) -> ParseResult:
    return _parse_source(source, document_path, validate_output_bindings=False)


def _parse_source(
    source: str,
    document_path: str | Path,
    *,
    validate_output_bindings: bool,
) -> ParseResult:
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
    decorator_kinds = _classify_node_decorators(module)
    _validate_rowcall_imports(module, issues)
    _diagnose_unsupported_node_syntax(module, decorator_kinds, issues)
    decoded_nodes = _decode_nodes(
        module,
        lines,
        decorator_kinds,
        issues,
        validate_output_bindings=validate_output_bindings,
    )
    edges = _decode_edges(module, decoded_nodes, issues)
    excluded = _excluded_source_lines(module, [node.function_def for node in decoded_nodes], lines)
    globals_code = _source_without_lines(lines, excluded).strip()
    nodes = tuple(_build_node(node, lines, globals_code) for node in decoded_nodes if node.node_id is not None and node.outputs is not None)

    if not decoded_nodes and not any(issue.kind == "unsupported_node_syntax" for issue in issues):
        issues.append(
            ValidationIssue(
                kind="missing_node",
                message=(
                    "A Rowcall document must define at least one node using "
                    '@node(id="...", outputs=[...]) on a synchronous function'
                ),
            )
        )

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


def _decode_nodes(
    module: ast.Module,
    lines: list[str],
    decorator_kinds: dict[int, str],
    issues: list[ValidationIssue],
    *,
    validate_output_bindings: bool,
) -> list[_DecodedNode]:
    decoded: list[_DecodedNode] = []
    node_function_names: set[str] = set()

    for statement in module.body:
        if not isinstance(statement, ast.FunctionDef):
            continue
        metadata = _decode_node_decorator(statement, decorator_kinds, issues)
        if metadata is None:
            continue
        decoded.append(metadata)
        node_function_names.add(statement.name)

    for decoded_node in decoded:
        function_def = decoded_node.function_def
        node_id = (
            decoded_node.node_id
            if decoded_node.node_id is not None
            else function_def.name
        )

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
        if decoded_node.outputs is not None:
            _validate_node_return(
                function_def,
                node_id,
                decoded_node.outputs,
                issues,
                validate_output_bindings=validate_output_bindings,
            )

    return decoded


def _diagnose_unsupported_node_syntax(
    module: ast.Module,
    decorator_kinds: dict[int, str],
    issues: list[ValidationIssue],
) -> None:
    """Report node-like syntax without expanding the supported grammar."""
    for statement in module.body:
        if not isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        kinds = {decorator_kinds.get(id(item)) for item in statement.decorator_list}
        kinds.discard(None)
        if isinstance(statement, ast.AsyncFunctionDef) and kinds:
            message = (
                f"Async node function '{statement.name}' is not supported; "
                "use a synchronous def with @node(...)"
            )
        elif _UNSUPPORTED_QUALIFIED_DECORATOR in kinds:
            message = (
                f"Qualified node decorator on '{statement.name}' is not supported; "
                "use 'from rowcall import node' and @node(...)"
            )
        elif _UNSUPPORTED_ALIASED_DECORATOR in kinds:
            message = (
                f"Aliased node decorator on '{statement.name}' is not supported; "
                "use 'from rowcall import node' and @node(...)"
            )
        elif _UNSUPPORTED_BARE_DECORATOR in kinds:
            message = (
                f"Decorator @node on '{statement.name}' is not bound by "
                "a top-level 'from rowcall import node' statement"
            )
        else:
            continue
        issues.append(
            ValidationIssue(
                kind="unsupported_node_syntax",
                message=message,
                node_id=statement.name,
                path=_statement_path(statement),
            )
        )


def _classify_node_decorators(module: ast.Module) -> dict[int, str]:
    """Classify decorators using conservative top-level binding provenance."""
    bindings: dict[str, str] = {}
    kinds: dict[int, str] = {}
    for statement in module.body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for decorator in statement.decorator_list:
                kind = _classify_node_decorator(decorator, bindings)
                if kind is not None:
                    kinds[id(decorator)] = kind
        _apply_top_level_bindings(statement, bindings)
    return kinds


def _classify_node_decorator(value: ast.AST, bindings: dict[str, str]) -> str | None:
    candidate = value.func if isinstance(value, ast.Call) else value
    if isinstance(candidate, ast.Name):
        provenance = bindings.get(candidate.id)
        if candidate.id == "node":
            return (
                _SUPPORTED_DECORATOR
                if provenance == _ROWCALL_NODE
                else _UNSUPPORTED_BARE_DECORATOR
            )
        if provenance == _ALIASED_ROWCALL_NODE:
            return _UNSUPPORTED_ALIASED_DECORATOR
        return None
    if (
        isinstance(candidate, ast.Attribute)
        and candidate.attr == "node"
        and isinstance(candidate.value, ast.Name)
        and bindings.get(candidate.value.id) == _ROWCALL_MODULE
    ):
        return _UNSUPPORTED_QUALIFIED_DECORATOR
    return None


def _apply_top_level_bindings(statement: ast.stmt, bindings: dict[str, str]) -> None:
    bound_names = _bound_names(statement)
    if _WILDCARD_IMPORT_BINDING in bound_names:
        bound_names.remove(_WILDCARD_IMPORT_BINDING)
        for name in tuple(bindings):
            bindings[name] = _UNKNOWN_BINDING
        bindings["node"] = _UNKNOWN_BINDING
    for name in bound_names:
        bindings[name] = _UNKNOWN_BINDING

    if isinstance(statement, ast.Import):
        for alias in statement.names:
            bound_name = alias.asname or alias.name.partition(".")[0]
            if alias.name == "rowcall" or (
                alias.asname is None and alias.name.startswith("rowcall.")
            ):
                bindings[bound_name] = _ROWCALL_MODULE
    elif isinstance(statement, ast.ImportFrom):
        for alias in statement.names:
            if alias.name == "*":
                continue
            bound_name = alias.asname or alias.name
            if statement.module == "rowcall" and alias.name == "node":
                bindings[bound_name] = (
                    _ALIASED_ROWCALL_NODE if alias.asname else _ROWCALL_NODE
                )


def _bound_names(statement: ast.stmt) -> set[str]:
    names: set[str] = set()

    class BindingVisitor(ast.NodeVisitor):
        def visit_Name(self, node: ast.Name) -> None:
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                names.add(node.id)

        def visit_Import(self, node: ast.Import) -> None:
            for alias in node.names:
                names.add(alias.asname or alias.name.partition(".")[0])

        def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
            for alias in node.names:
                if alias.name == "*":
                    names.add(_WILDCARD_IMPORT_BINDING)
                else:
                    names.add(alias.asname or alias.name)

        def visit_Call(self, node: ast.Call) -> None:
            # These calls can mutate or expose the module namespace in ways a
            # static parser cannot safely prove preserve the @node binding.
            if isinstance(node.func, ast.Name) and (
                node.func.id in {"exec", "globals", "locals"}
                or (
                    node.func.id == "vars"
                    and not (
                        len(node.args) == 1
                        and not isinstance(node.args[0], ast.Starred)
                        and not node.keywords
                    )
                )
            ):
                names.add(_WILDCARD_IMPORT_BINDING)
            self.generic_visit(node)

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            names.add(node.name)
            for decorator in node.decorator_list:
                self.visit(decorator)
            for default in [*node.args.defaults, *node.args.kw_defaults]:
                if default is not None:
                    self.visit(default)
            if node.returns is not None:
                self.visit(node.returns)

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            self.visit_FunctionDef(node)

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            names.add(node.name)
            for decorator in node.decorator_list:
                self.visit(decorator)
            for base in node.bases:
                self.visit(base)
            for keyword in node.keywords:
                self.visit(keyword.value)

        def visit_Lambda(self, node: ast.Lambda) -> None:
            return

        def visit_ListComp(self, node: ast.ListComp) -> None:
            self._visit_comprehension(node, [node.elt])

        def visit_SetComp(self, node: ast.SetComp) -> None:
            self._visit_comprehension(node, [node.elt])

        def visit_DictComp(self, node: ast.DictComp) -> None:
            self._visit_comprehension(node, [node.key, node.value])

        def visit_GeneratorExp(self, node: ast.GeneratorExp) -> None:
            self._visit_comprehension(node, [node.elt])

        def _visit_comprehension(
            self,
            node: ast.ListComp | ast.SetComp | ast.DictComp | ast.GeneratorExp,
            result_expressions: list[ast.expr],
        ) -> None:
            # Comprehension targets are scoped inside the comprehension, but
            # assignment expressions bind in the containing module scope.
            for expression in result_expressions:
                self.visit(expression)
            for generator in node.generators:
                self.visit(generator.iter)
                for condition in generator.ifs:
                    self.visit(condition)

        def visit_MatchAs(self, node: ast.MatchAs) -> None:
            if node.name is not None:
                names.add(node.name)
            if node.pattern is not None:
                self.visit(node.pattern)

        def visit_MatchStar(self, node: ast.MatchStar) -> None:
            if node.name is not None:
                names.add(node.name)

        def visit_MatchMapping(self, node: ast.MatchMapping) -> None:
            if node.rest is not None:
                names.add(node.rest)
            for key in node.keys:
                self.visit(key)
            for pattern in node.patterns:
                self.visit(pattern)

        def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
            if node.name is not None:
                names.add(node.name)
            if node.type is not None:
                self.visit(node.type)
            for child in node.body:
                self.visit(child)

    BindingVisitor().visit(statement)
    return names


def _decode_node_decorator(
    function_def: ast.FunctionDef,
    decorator_kinds: dict[int, str],
    issues: list[ValidationIssue],
) -> _DecodedNode | None:
    for decorator in function_def.decorator_list:
        if decorator_kinds.get(id(decorator)) != _SUPPORTED_DECORATOR:
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
        if argument.arg.startswith("__rowcall_"):
            issues.append(
                ValidationIssue(
                    kind="unsupported_python",
                    message="Node parameter names may not start with __rowcall_",
                    node_id=node_id,
                    path=_path_for(argument.lineno, argument.col_offset + 1),
                )
            )


def _validate_node_return(
    function_def: ast.FunctionDef,
    node_id: str,
    outputs: tuple[str, ...],
    issues: list[ValidationIssue],
    *,
    validate_output_bindings: bool,
) -> None:
    returns = _node_level_returns(function_def)
    format_hint = " See `rowcall help format` for the required structure."

    if len(returns) != 1:
        issues.append(
            ValidationIssue(
                kind="invalid_node_return",
                message=(
                    f"Node '{node_id}' must have exactly one return statement, "
                    "as the final statement in the function. Make every declared "
                    "output available as a same-named variable, then return the generated "
                    f"output dictionary.{format_hint}"
                ),
                node_id=node_id,
                path=_statement_path(function_def),
            )
        )
        return

    return_statement = returns[0]
    if not function_def.body or function_def.body[-1] is not return_statement:
        issues.append(
            ValidationIssue(
                kind="invalid_node_return",
                message=(
                    f"Node '{node_id}' must place its only return statement last. "
                    "Assign every declared output first, then end the function with "
                    f"the generated output dictionary.{format_hint}"
                ),
                node_id=node_id,
                path=_statement_path(return_statement),
            )
        )
        return

    returned = return_statement.value
    if not isinstance(returned, ast.Dict):
        issues.append(
            ValidationIssue(
                kind="invalid_node_return",
                message=(
                    f"Node '{node_id}' must return a dictionary literal whose keys "
                    "and same-named variable values exactly match outputs="
                    f"{list(outputs)!r}.{format_hint}"
                ),
                node_id=node_id,
                path=_statement_path(return_statement),
            )
        )
        return

    returned_keys: list[str] = []
    for key in returned.keys:
        key_text = _literal_string(key) if key is not None else None
        if key_text is None:
            issues.append(
                ValidationIssue(
                    kind="invalid_node_return",
                    message=(
                        f"Node '{node_id}' must use literal output names in its "
                        "return dictionary; dictionary expansion and computed keys "
                        f"are not supported.{format_hint}"
                    ),
                    node_id=node_id,
                    path=_statement_path(return_statement),
                )
            )
            return
        returned_keys.append(key_text)

    if tuple(returned_keys) != outputs:
        issues.append(
            ValidationIssue(
                kind="invalid_node_return",
                message=(
                    f"Node '{node_id}' returns outputs {returned_keys!r}, but its "
                    f"decorator declares {list(outputs)!r}. Return every declared "
                    f"output exactly once in the declared order.{format_hint}"
                ),
                node_id=node_id,
                path=_statement_path(return_statement),
            )
        )
        return

    local_bindings = (
        _node_local_bindings(function_def) if validate_output_bindings else None
    )
    for output, value in zip(outputs, returned.values):
        if isinstance(value, ast.Name) and value.id == output:
            if local_bindings is not None and output not in local_bindings:
                issues.append(
                    ValidationIssue(
                        kind="invalid_node_return",
                        message=(
                            f"Output '{output}' on node '{node_id}' must be a local "
                            "variable or parameter, but this name resolves outside "
                            f"the node function. Assign '{output}' in the node body "
                            f"before returning it.{format_hint}"
                        ),
                        node_id=node_id,
                        path=_path_for(value.lineno, value.col_offset + 1),
                    )
                )
            continue
        expression = ast.unparse(value)
        issues.append(
            ValidationIssue(
                kind="invalid_node_return",
                message=(
                    f"Output '{output}' on node '{node_id}' must be returned from "
                    f"the same-named variable '{output}', not the expression "
                    f"'{expression}'. Assign the expression to '{output}' before "
                    f"the return, then use `{output!r}: {output}`.{format_hint}"
                ),
                node_id=node_id,
                path=_path_for(value.lineno, value.col_offset + 1),
            )
        )


def _node_level_returns(function_def: ast.FunctionDef) -> list[ast.Return]:
    returns: list[ast.Return] = []

    class ReturnVisitor(ast.NodeVisitor):
        def visit_Return(self, node: ast.Return) -> None:
            returns.append(node)

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            return

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            return

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            return

        def visit_Lambda(self, node: ast.Lambda) -> None:
            return

    visitor = ReturnVisitor()
    for statement in function_def.body:
        visitor.visit(statement)
    return returns


def _node_local_bindings(function_def: ast.FunctionDef) -> set[str]:
    bindings = {
        argument.arg
        for argument in [
            *function_def.args.posonlyargs,
            *function_def.args.args,
            *function_def.args.kwonlyargs,
        ]
    }
    for statement in function_def.body[:-1]:
        bindings.update(_bound_names(statement))

    global_names: set[str] = set()
    nonlocal_names: set[str] = set()

    class DeclarationVisitor(ast.NodeVisitor):
        def visit_Global(self, node: ast.Global) -> None:
            global_names.update(node.names)

        def visit_Nonlocal(self, node: ast.Nonlocal) -> None:
            nonlocal_names.update(node.names)

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            return

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            return

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            return

        def visit_Lambda(self, node: ast.Lambda) -> None:
            return

    visitor = DeclarationVisitor()
    for statement in function_def.body[:-1]:
        visitor.visit(statement)

    bindings.difference_update(global_names)
    bindings.difference_update(nonlocal_names)
    bindings.discard(_WILDCARD_IMPORT_BINDING)
    return bindings


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


def _validate_rowcall_imports(module: ast.Module, issues: list[ValidationIssue]) -> None:
    for statement in module.body:
        if not _is_rowcall_from_import(statement):
            continue
        for alias in statement.names:
            if alias.name not in SUPPORTED_ROWCALL_FROM_IMPORTS:
                issues.append(
                    ValidationIssue(
                        kind="unsupported_python",
                        message="from rowcall imports may only include display and node",
                        path=_statement_path(statement),
                    )
                )
            if alias.asname is None:
                continue
            issues.append(
                ValidationIssue(
                    kind="unsupported_python",
                    message="from rowcall imports may not use aliases",
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
        id=node.node_id if node.node_id is not None else function_def.name,
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
        if _is_rowcall_from_import(statement) or (
            isinstance(statement, ast.Expr) and _looks_like_depends_on_call(statement.value)
        ):
            for line_number in range(statement.lineno, (statement.end_lineno or statement.lineno) + 1):
                excluded.add(line_number)

    for line_number, line in enumerate(lines, start=1):
        if line.strip() == "# Rowcall graph":
            excluded.add(line_number)

    return excluded


def _is_rowcall_from_import(statement: ast.stmt) -> bool:
    if isinstance(statement, ast.ImportFrom) and statement.module == "rowcall":
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
    returns = _node_level_returns(function_def)
    if len(returns) != 1:
        return False
    if not function_def.body:
        return False
    final_statement = function_def.body[-1]
    if final_statement is not returns[0]:
        return False
    if not isinstance(final_statement.value, ast.Dict):
        return False

    keys: list[str] = []
    values: list[str] = []
    for key, value in zip(final_statement.value.keys, final_statement.value.values):
        text = _literal_string(key) if key is not None else None
        if text is None or not isinstance(value, ast.Name):
            return False
        keys.append(text)
        values.append(value.id)
    return tuple(keys) == outputs and tuple(values) == outputs


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
                f"__rowcall_parameters = {list(parameters)!r}",
                f"__rowcall_outputs = {list(outputs)!r}",
                "__rowcall_call_inputs = {",
                "    name: globals()[name]",
                "    for name in __rowcall_parameters",
                "}",
                f"__rowcall_result = {function_name}(**__rowcall_call_inputs)",
                "if not isinstance(__rowcall_result, dict):",
                "    raise TypeError('Node function must return a dict of declared outputs')",
                "__rowcall_missing_outputs = [",
                "    name for name in __rowcall_outputs",
                "    if name not in __rowcall_result",
                "]",
                "if __rowcall_missing_outputs:",
                "    raise NameError(",
                "        'Node function did not return declared outputs: '",
                "        + ', '.join(__rowcall_missing_outputs)",
                "    )",
                "for __rowcall_output_name in __rowcall_outputs:",
                "    globals()[__rowcall_output_name] = __rowcall_result[__rowcall_output_name]",
            ]
        )
    )
    return "\n\n".join(parts)
