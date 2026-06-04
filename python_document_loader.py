import ast
import hashlib
import json
import sys
import textwrap
from pathlib import Path
from typing import Any


class DocumentError(Exception):
    def __init__(self, issues: list[dict[str, Any]]) -> None:
        super().__init__("Python document decoding failed")
        self.issues = issues


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: python_document_loader.py path/to/document.py")

    path = Path(sys.argv[1])
    try:
        document = load_python_document(path)
    except DocumentError as error:
        print(json.dumps({"ok": False, "issues": error.issues}))
        return

    print(json.dumps({"ok": True, "document": document}))


def load_python_document(path: Path) -> dict[str, Any]:
    source = path.read_text()
    try:
        module = ast.parse(source, filename=str(path))
    except SyntaxError as error:
        raise DocumentError(
            [
                {
                    "kind": "invalid_python",
                    "message": error.msg,
                    "path": f"{error.lineno}:{error.offset}",
                }
            ]
        )

    lines = source.splitlines()
    issues: list[dict[str, Any]] = []
    node_defs: list[tuple[ast.FunctionDef, dict[str, Any]]] = []
    function_names: set[str] = set()

    for statement in module.body:
        if isinstance(statement, ast.FunctionDef):
            node_metadata = decode_node_decorator(statement)
            if node_metadata is not None:
                node_defs.append((statement, node_metadata))
                function_names.add(statement.name)

    seen_ids: set[str] = set()
    seen_function_names: set[str] = set()
    for function_def, metadata in node_defs:
        node_id = metadata["id"]
        if node_id in seen_ids:
            issues.append(
                {
                    "kind": "duplicate_node_id",
                    "message": f"Node ID '{node_id}' is not unique",
                    "nodeId": node_id,
                    "path": f"{function_def.lineno}:1",
                }
            )
        seen_ids.add(node_id)

        if function_def.name in seen_function_names:
            issues.append(
                {
                    "kind": "duplicate_function_name",
                    "message": f"Node function '{function_def.name}' is not unique",
                    "nodeId": node_id,
                    "path": f"{function_def.lineno}:1",
                }
            )
        seen_function_names.add(function_def.name)

        validate_node_function_shape(function_def, metadata, issues)
        validate_no_direct_node_calls(function_def, metadata, function_names, issues)

    edges = decode_edges(module, node_defs, issues)

    if issues:
        raise DocumentError(issues)

    excluded_lines = excluded_source_lines(module, [node_def for node_def, _ in node_defs], lines)
    globals_code = source_without_lines(lines, excluded_lines).strip()

    nodes = []
    for function_def, metadata in node_defs:
        function_source = extract_function_source(lines, function_def)
        parameters = parameter_names(function_def)
        outputs = metadata["outputs"]
        standard_return = has_standard_generated_return(function_def, outputs)
        display_code = extract_display_code(lines, function_def, standard_return)
        runtime_code = build_runtime_code(
            globals_code=globals_code,
            function_source=function_source,
            function_name=function_def.name,
            parameters=parameters,
            outputs=outputs,
        )

        nodes.append(
            {
                "id": metadata["id"],
                "functionName": function_def.name,
                "code": display_code,
                "runtimeCode": runtime_code,
                "outputs": outputs,
                "parameters": parameters,
                "customReturn": not standard_return,
                "editable": standard_return,
                "sourceRange": source_range(function_def, standard_return),
            }
        )

    return {
        "version": 1,
        "revision": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        "globalsCode": globals_code,
        "nodes": nodes,
        "edges": edges,
        "readOnly": False,
    }


def decode_node_decorator(function_def: ast.FunctionDef) -> dict[str, Any] | None:
    for decorator in function_def.decorator_list:
        if not is_node_call(decorator):
            continue

        node_id = None
        outputs = None
        for keyword in decorator.keywords:
            if keyword.arg == "id":
                node_id = literal_string(keyword.value)
            if keyword.arg == "outputs":
                outputs = literal_string_list(keyword.value)

        if node_id is None or outputs is None:
            return {
                "id": node_id,
                "outputs": outputs,
                "invalidDecorator": True,
            }

        return {"id": node_id, "outputs": outputs}

    return None


def is_node_call(value: ast.AST) -> bool:
    return (
        isinstance(value, ast.Call)
        and isinstance(value.func, ast.Name)
        and value.func.id == "node"
    )


def literal_string(value: ast.AST) -> str | None:
    return value.value if isinstance(value, ast.Constant) and isinstance(value.value, str) else None


def literal_string_list(value: ast.AST) -> list[str] | None:
    if not isinstance(value, ast.List):
        return None
    result = []
    for item in value.elts:
        text = literal_string(item)
        if text is None:
            return None
        result.append(text)
    return result


def validate_node_function_shape(
    function_def: ast.FunctionDef,
    metadata: dict[str, Any],
    issues: list[dict[str, Any]],
) -> None:
    node_id = metadata.get("id") if isinstance(metadata.get("id"), str) else function_def.name
    if metadata.get("invalidDecorator"):
        issues.append(
            {
                "kind": "wrong_type",
                "message": "Node decorators must provide string id and list[str] outputs",
                "nodeId": node_id,
                "path": f"{function_def.lineno}:1",
            }
        )

    if function_def.args.vararg is not None or function_def.args.kwarg is not None:
        issues.append(
            {
                "kind": "unsupported_python",
                "message": "Node functions may not use *args or **kwargs",
                "nodeId": node_id,
                "path": f"{function_def.lineno}:1",
            }
        )

    if function_def.args.posonlyargs:
        issues.append(
            {
                "kind": "unsupported_python",
                "message": "Node functions may not use positional-only parameters",
                "nodeId": node_id,
                "path": f"{function_def.lineno}:1",
            }
        )

    for argument in [*function_def.args.args, *function_def.args.kwonlyargs]:
        if argument.arg.startswith("__nodebook_"):
            issues.append(
                {
                    "kind": "unsupported_python",
                    "message": "Node parameter names may not start with __nodebook_",
                    "nodeId": node_id,
                    "path": f"{function_def.lineno}:1",
                }
            )


def validate_no_direct_node_calls(
    function_def: ast.FunctionDef,
    metadata: dict[str, Any],
    function_names: set[str],
    issues: list[dict[str, Any]],
) -> None:
    node_id = metadata.get("id") if isinstance(metadata.get("id"), str) else function_def.name
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
            {
                "kind": "unsupported_python",
                "message": (
                    f"Node function '{function_def.name}' calls node "
                    f"'{child.func.id}' directly. Add an explicit edge instead."
                ),
                "nodeId": node_id,
                "path": f"{child.lineno}:{child.col_offset + 1}",
            }
        )


def decode_edges(
    module: ast.Module,
    node_defs: list[tuple[ast.FunctionDef, dict[str, Any]]],
    issues: list[dict[str, Any]],
) -> list[dict[str, str]]:
    ids_by_function = {
        function_def.name: metadata["id"]
        for function_def, metadata in node_defs
        if isinstance(metadata.get("id"), str)
    }
    edges = []

    for statement in module.body:
        call = statement.value if isinstance(statement, ast.Expr) else None
        if not is_depends_on_call(call):
            continue

        downstream_name = call.func.value.id
        if downstream_name not in ids_by_function:
            issues.append(
                {
                    "kind": "missing_node_reference",
                    "message": f"Edge references nonexistent downstream node {downstream_name}",
                    "path": f"{statement.lineno}:1",
                }
            )
            continue

        for argument in call.args:
            if not isinstance(argument, ast.Name):
                issues.append(
                    {
                        "kind": "unsupported_python",
                        "message": "depends_on arguments must be node function names",
                        "nodeId": ids_by_function[downstream_name],
                        "path": f"{argument.lineno}:{argument.col_offset + 1}",
                    }
                )
                continue
            if argument.id not in ids_by_function:
                issues.append(
                    {
                        "kind": "missing_node_reference",
                        "message": f"Edge references nonexistent upstream node {argument.id}",
                        "nodeId": ids_by_function[downstream_name],
                        "path": f"{argument.lineno}:{argument.col_offset + 1}",
                    }
                )
                continue

            edges.append(
                {
                    "fromNode": ids_by_function[argument.id],
                    "toNode": ids_by_function[downstream_name],
                }
            )

    return edges


def is_depends_on_call(value: ast.AST | None) -> bool:
    return (
        isinstance(value, ast.Call)
        and isinstance(value.func, ast.Attribute)
        and value.func.attr == "depends_on"
        and isinstance(value.func.value, ast.Name)
    )


def excluded_source_lines(
    module: ast.Module,
    node_defs: list[ast.FunctionDef],
    lines: list[str],
) -> set[int]:
    excluded: set[int] = set()
    for function_def in node_defs:
        start = min(
            [function_def.lineno]
            + [decorator.lineno for decorator in function_def.decorator_list]
        )
        for line_number in range(start, (function_def.end_lineno or function_def.lineno) + 1):
            excluded.add(line_number)

    for statement in module.body:
        if is_nodebook_import(statement) or (
            isinstance(statement, ast.Expr) and is_depends_on_call(statement.value)
        ):
            for line_number in range(statement.lineno, (statement.end_lineno or statement.lineno) + 1):
                excluded.add(line_number)

    for line_number, line in enumerate(lines, start=1):
        if line.strip() == "# NodeBook graph":
            excluded.add(line_number)

    return excluded


def is_nodebook_import(statement: ast.stmt) -> bool:
    if isinstance(statement, ast.ImportFrom) and statement.module == "nodebook":
        return True
    if isinstance(statement, ast.Import):
        return any(alias.name == "nodebook" for alias in statement.names)
    return False


def source_without_lines(lines: list[str], excluded_lines: set[int]) -> str:
    return "\n".join(
        line
        for index, line in enumerate(lines, start=1)
        if index not in excluded_lines
    )


def extract_function_source(lines: list[str], function_def: ast.FunctionDef) -> str:
    start = function_def.lineno
    end = function_def.end_lineno or function_def.lineno
    return "\n".join(lines[start - 1 : end])


def extract_display_code(
    lines: list[str],
    function_def: ast.FunctionDef,
    strip_standard_return: bool,
) -> str:
    body = function_def.body
    if strip_standard_return and body and isinstance(body[-1], ast.Return):
        body = body[:-1]

    if not body:
        return ""

    start = body[0].lineno
    end = body[-1].end_lineno or body[-1].lineno
    return textwrap.dedent("\n".join(lines[start - 1 : end])).strip("\n")


def source_range(function_def: ast.FunctionDef, standard_return: bool) -> dict[str, int | str]:
    start = min(
        [function_def.lineno]
        + [decorator.lineno for decorator in function_def.decorator_list]
    )
    end = function_def.end_lineno or function_def.lineno
    range_info: dict[str, int | str] = {
        "startLine": start,
        "endLine": end,
    }
    for decorator in function_def.decorator_list:
        if is_node_call(decorator):
            range_info["decoratorLine"] = decorator.lineno
            break

    if standard_return and function_def.body and isinstance(function_def.body[-1], ast.Return):
        return_statement = function_def.body[-1]
        range_info["bodyStartLine"] = function_def.body[0].lineno
        range_info["bodyEndLine"] = return_statement.lineno - 1
        range_info["returnLine"] = return_statement.lineno
        range_info["returnEndLine"] = return_statement.end_lineno or return_statement.lineno
        range_info["indent"] = " " * return_statement.col_offset

    return range_info


def parameter_names(function_def: ast.FunctionDef) -> list[str]:
    return [
        *[argument.arg for argument in function_def.args.args],
        *[argument.arg for argument in function_def.args.kwonlyargs],
    ]


def has_standard_generated_return(function_def: ast.FunctionDef, outputs: list[str]) -> bool:
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
        text = literal_string(key) if key is not None else None
        if text is None:
            return False
        keys.append(text)

    return keys == outputs


def build_runtime_code(
    *,
    globals_code: str,
    function_source: str,
    function_name: str,
    parameters: list[str],
    outputs: list[str],
) -> str:
    parameter_literal = repr(parameters)
    output_literal = repr(outputs)
    parts = []
    if globals_code:
        parts.append(globals_code)
    parts.append(function_source)
    parts.append(
        "\n".join(
            [
                f"__nodebook_parameters = {parameter_literal}",
                f"__nodebook_outputs = {output_literal}",
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


if __name__ == "__main__":
    main()
