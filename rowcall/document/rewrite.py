"""Source rewrite helpers for Python-owned Rowcall documents."""

from __future__ import annotations

import ast
import copy
import io
import json
import keyword
import textwrap
import tokenize
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from .models import DocumentEdge, DocumentNode, ExecutableDocument, ParseResult, ValidationIssue
from .parser import _parse_source_for_rewrite, parse_source


EdgeSpec = tuple[str, str, str, str]


@dataclass(frozen=True)
class RewriteResult:
    source: str
    parse_result: ParseResult

    @property
    def ok(self) -> bool:
        return self.parse_result.ok

    @property
    def issues(self) -> tuple[ValidationIssue, ...]:
        return self.parse_result.issues


@dataclass(frozen=True)
class OperationRewriteResult:
    ok: bool
    source: str | None
    parse_result: ParseResult
    sidecar_metadata: dict[str, Any] | None = None

    @property
    def issues(self) -> tuple[ValidationIssue, ...]:
        return self.parse_result.issues


def apply_document_operations(
    source: str,
    document_path: str | Path,
    operations: list[dict[str, Any]] | tuple[dict[str, Any], ...],
    sidecar_metadata: dict[str, Any] | None = None,
) -> OperationRewriteResult:
    if not isinstance(operations, (list, tuple)):
        return _operation_failure(
            source,
            document_path,
            ValidationIssue(kind="invalid_operation", message="Operations must be a list."),
        )

    current_source = source
    current_metadata = _normalize_sidecar_metadata(sidecar_metadata)
    validated_operations: list[tuple[int, dict[str, Any]]] = []

    for index, operation in enumerate(operations):
        if not isinstance(operation, dict):
            return _operation_failure(
                source,
                document_path,
                ValidationIssue(kind="invalid_operation", message="Operation must be an object."),
                index,
                None,
            )
        operation_type = operation.get("type")
        if not isinstance(operation_type, str) or not operation_type:
            return _operation_failure(
                source,
                document_path,
                ValidationIssue(kind="invalid_operation", message="Operation type must be a non-empty string."),
                index,
                None,
            )

        validated_operations.append((index, operation))

    initial_parse = parse_source(source, document_path)
    can_add_first_node = any(
        operation.get("type") == "add_node" for _, operation in validated_operations
    )
    initial_issues = tuple(
        issue
        for issue in initial_parse.issues
        if not (can_add_first_node and issue.kind == "missing_node")
    )
    if initial_issues:
        blocking_parse = ParseResult(
            ok=False,
            document=initial_parse.document,
            issues=initial_issues,
        )
        return OperationRewriteResult(
            ok=False,
            source=None,
            parse_result=blocking_parse,
            sidecar_metadata=None,
        )

    coalesced_operations = _coalesce_document_operations(validated_operations)
    for original_index, operation in coalesced_operations:
        operation_type = operation["type"]
        result = _apply_one_operation(
            current_source,
            document_path,
            operation,
            current_metadata,
            normalize_signatures=False,
        )
        if isinstance(result, ValidationIssue):
            return _operation_failure(source, document_path, result, original_index, operation_type)
        current_source, current_metadata = result

    if any(
        operation["type"] in {"add_edge", "remove_edge", "delete_node"}
        for _, operation in coalesced_operations
    ):
        lines, newline, final_newline = _split_source(current_source)
        finalized = _finish_rewrite_with_normalized_signatures(
            lines,
            newline,
            final_newline,
            document_path,
            validate_output_bindings=False,
        )
        if not finalized.ok:
            return OperationRewriteResult(
                ok=False,
                source=None,
                parse_result=finalized.parse_result,
                sidecar_metadata=None,
            )
        current_source = finalized.source

    parsed = parse_source(current_source, document_path)
    if not parsed.ok:
        return OperationRewriteResult(ok=False, source=None, parse_result=parsed, sidecar_metadata=None)
    return OperationRewriteResult(ok=True, source=current_source, parse_result=parsed, sidecar_metadata=current_metadata)


def update_node_body(
    source: str,
    document_path: str | Path,
    node_id: str,
    body_code: str,
) -> RewriteResult:
    return _update_node_body(
        source,
        document_path,
        node_id,
        body_code,
        validate_output_bindings=True,
    )


def _update_node_body(
    source: str,
    document_path: str | Path,
    node_id: str,
    body_code: str,
    *,
    validate_output_bindings: bool,
) -> RewriteResult:
    parsed = _parse_rewrite_source(
        source,
        document_path,
        validate_output_bindings,
    )
    if not parsed.ok or not parsed.document:
        return RewriteResult(source=source, parse_result=parsed)

    node = _find_node(parsed.document.nodes, node_id)
    rejection = _reject_uneditable_node(source, parsed, node_id, node)
    if rejection is not None:
        return rejection

    assert node is not None
    if node.source_range.return_line is None or node.source_range.return_end_line is None:
        return _unsupported(source, parsed, node_id, "Node body cannot be rewritten without a generated return range.")

    lines, newline, final_newline = _split_source(source)
    body_lines = _render_body_lines(body_code, node.source_range.indent or "    ")
    return_line = _render_return_line(node.return_names, node.source_range.indent or "    ")
    _replace_lines(
        lines,
        node.source_range.body_start_line or node.source_range.return_line,
        node.source_range.return_end_line,
        [*body_lines, return_line],
    )
    result = _finish_rewrite(
        lines,
        newline,
        final_newline,
        document_path,
        validate_output_bindings=validate_output_bindings,
    )
    return _localize_node_body_syntax_issues(
        result,
        node_id=node_id,
        body_start_line=node.source_range.body_start_line or node.source_range.return_line,
        indent=node.source_range.indent or "    ",
        body_lines=body_lines,
    )


def _localize_node_body_syntax_issues(
    result: RewriteResult,
    *,
    node_id: str,
    body_start_line: int,
    indent: str,
    body_lines: list[str],
) -> RewriteResult:
    if result.ok:
        return result

    localized_issues: list[ValidationIssue] = []
    for issue in result.issues:
        if issue.kind != "invalid_python" or issue.path is None:
            localized_issues.append(issue)
            continue
        try:
            line_text, column_text = issue.path.split(":", maxsplit=1)
            document_line = int(line_text)
            document_column = int(column_text)
        except (ValueError, TypeError):
            localized_issues.append(issue)
            continue
        local_line = max(document_line - body_start_line + 1, 1)
        local_column = max(document_column - len(indent), 1)
        if local_line > len(body_lines):
            local_line = len(body_lines)
            local_column = max(len(body_lines[-1]) - len(indent) + 1, 1)
        localized_issues.append(
            replace(
                issue,
                path=f"{local_line}:{local_column}",
                node_id=node_id,
                field="code",
            )
        )

    return RewriteResult(
        source=result.source,
        parse_result=ParseResult(
            ok=result.parse_result.ok,
            document=result.parse_result.document,
            issues=tuple(localized_issues),
        ),
    )


def update_node_outputs(
    source: str,
    document_path: str | Path,
    node_id: str,
    outputs: list[str] | tuple[str, ...],
) -> RewriteResult:
    return _update_node_outputs(
        source,
        document_path,
        node_id,
        outputs,
        validate_output_bindings=True,
        normalize_signatures=True,
    )


def _update_node_outputs(
    source: str,
    document_path: str | Path,
    node_id: str,
    outputs: list[str] | tuple[str, ...],
    *,
    validate_output_bindings: bool,
    normalize_signatures: bool,
) -> RewriteResult:
    parsed = _parse_rewrite_source(
        source,
        document_path,
        validate_output_bindings,
    )
    if not parsed.ok or not parsed.document:
        return RewriteResult(source=source, parse_result=parsed)

    node = _find_node(parsed.document.nodes, node_id)
    rejection = _reject_uneditable_node(source, parsed, node_id, node)
    if rejection is not None:
        return rejection

    assert node is not None
    custom_downstream_issue = _reject_custom_managed_downstream_change(
        parsed.document,
        node_id,
    )
    if custom_downstream_issue is not None:
        return _with_issue(source, parsed, custom_downstream_issue)

    next_outputs = tuple(outputs)
    output_issue = _validate_names(node_id, next_outputs, "Output")
    if output_issue is not None:
        return _with_issue(source, parsed, output_issue)

    decorator_range = _node_decorator_range(source, node)
    if decorator_range is None:
        return _unsupported(source, parsed, node_id, "Node decorator range could not be found.")
    if node.source_range.return_line is None or node.source_range.return_end_line is None:
        return _unsupported(source, parsed, node_id, "Node outputs cannot be rewritten without a generated return range.")

    lines, newline, final_newline = _split_source(source)
    _replace_lines(
        lines,
        node.source_range.return_line,
        node.source_range.return_end_line,
        [
            _render_return_line(
                next_outputs,
                node.source_range.indent or "    ",
            )
        ],
    )
    _replace_lines(
        lines,
        decorator_range[0],
        decorator_range[1],
        [_render_decorator(node.id, next_outputs)],
    )
    finish = (
        _finish_rewrite_with_normalized_signatures
        if normalize_signatures
        else _finish_rewrite
    )
    return finish(
        lines,
        newline,
        final_newline,
        document_path,
        validate_output_bindings=validate_output_bindings,
    )


def add_edge(
    source: str,
    document_path: str | Path,
    from_node_id: str,
    from_output: str,
    to_node_id: str,
    to_input: str | None = None,
) -> RewriteResult:
    return _add_edge(
        source,
        document_path,
        from_node_id,
        from_output,
        to_node_id,
        to_input or from_output,
        validate_output_bindings=True,
        normalize_signatures=True,
    )


def _add_edge(
    source: str,
    document_path: str | Path,
    from_node_id: str,
    from_output: str,
    to_node_id: str,
    to_input: str,
    *,
    validate_output_bindings: bool,
    normalize_signatures: bool,
) -> RewriteResult:
    return _rewrite_edges(
        source,
        document_path,
        add=(from_node_id, from_output, to_node_id, to_input),
        remove=None,
        validate_output_bindings=validate_output_bindings,
        normalize_signatures=normalize_signatures,
    )


def remove_edge(
    source: str,
    document_path: str | Path,
    from_node_id: str,
    from_output: str,
    to_node_id: str,
    to_input: str,
) -> RewriteResult:
    return _remove_edge(
        source,
        document_path,
        from_node_id,
        from_output,
        to_node_id,
        to_input,
        validate_output_bindings=True,
        normalize_signatures=True,
    )


def _remove_edge(
    source: str,
    document_path: str | Path,
    from_node_id: str,
    from_output: str,
    to_node_id: str,
    to_input: str,
    *,
    validate_output_bindings: bool,
    normalize_signatures: bool,
) -> RewriteResult:
    return _rewrite_edges(
        source,
        document_path,
        add=None,
        remove=(from_node_id, from_output, to_node_id, to_input),
        validate_output_bindings=validate_output_bindings,
        normalize_signatures=normalize_signatures,
    )


def _coalesce_document_operations(
    operations: list[tuple[int, dict[str, Any]]],
) -> list[tuple[int, dict[str, Any]]]:
    result: list[tuple[int, dict[str, Any]]] = []
    edge_indexes: dict[tuple[str, str, str, str, str], int] = {}

    for original_index, operation in operations:
        operation_type = operation.get("type")
        edge = _edge_spec(operation) if operation_type in {"add_edge", "remove_edge"} else None
        if edge is None or operation_type not in {"add_edge", "remove_edge"}:
            result.append((original_index, operation))
            continue

        key = (operation_type, *edge)
        inverse_type = "remove_edge" if operation_type == "add_edge" else "add_edge"
        inverse_key = (inverse_type, *edge)
        inverse_index = edge_indexes.get(inverse_key)
        if inverse_index is not None:
            result.pop(inverse_index)
            edge_indexes = _edge_operation_indexes(result)
            continue

        existing_index = edge_indexes.get(key)
        if existing_index is not None:
            result[existing_index] = (original_index, operation)
            continue

        edge_indexes[key] = len(result)
        result.append((original_index, operation))

    return result


def _edge_operation_indexes(
    operations: list[tuple[int, dict[str, Any]]],
) -> dict[tuple[str, str, str, str, str], int]:
    indexes: dict[tuple[str, str, str, str, str], int] = {}
    for index, (_, operation) in enumerate(operations):
        operation_type = operation.get("type")
        if operation_type not in {"add_edge", "remove_edge"}:
            continue
        edge = _edge_spec(operation)
        if edge is None:
            continue
        indexes[(operation_type, *edge)] = index
    return indexes


def _apply_one_operation(
    source: str,
    document_path: str | Path,
    operation: dict[str, Any],
    metadata: dict[str, Any],
    *,
    normalize_signatures: bool,
) -> tuple[str, dict[str, Any]] | ValidationIssue:
    operation_type = operation["type"]
    if operation_type == "update_node_body":
        node_id = _text_field(operation, "nodeId", "node_id")
        body_code = _text_field(operation, "bodyCode", "body_code", "code")
        if node_id is None or body_code is None:
            return _invalid_operation("update_node_body requires nodeId and bodyCode.")
        result = _update_node_body(
            source,
            document_path,
            node_id,
            body_code,
            validate_output_bindings=False,
        )
        return _source_result_or_issue(result, metadata)

    if operation_type == "update_node_outputs":
        node_id = _text_field(operation, "nodeId", "node_id")
        outputs = operation.get("outputs")
        if node_id is None or not isinstance(outputs, list) or not all(isinstance(item, str) for item in outputs):
            return _invalid_operation("update_node_outputs requires nodeId and outputs list.")
        result = _update_node_outputs(
            source,
            document_path,
            node_id,
            tuple(outputs),
            validate_output_bindings=False,
            normalize_signatures=normalize_signatures,
        )
        return _source_result_or_issue(result, metadata)

    if operation_type == "add_edge":
        edge = _edge_spec(operation)
        if edge is None:
            return _invalid_operation("add_edge requires fromNode, fromOutput, toNode, and toInput.")
        result = _add_edge(
            source,
            document_path,
            *edge,
            validate_output_bindings=False,
            normalize_signatures=normalize_signatures,
        )
        return _source_result_or_issue(result, metadata)

    if operation_type == "remove_edge":
        edge = _edge_spec(operation)
        if edge is None:
            return _invalid_operation("remove_edge requires fromNode, fromOutput, toNode, and toInput.")
        result = _remove_edge(
            source,
            document_path,
            *edge,
            validate_output_bindings=False,
            normalize_signatures=normalize_signatures,
        )
        return _source_result_or_issue(result, metadata)

    if operation_type == "update_globals":
        globals_code = _text_field(operation, "globalsCode", "globals_code", "code")
        if globals_code is None:
            return _invalid_operation("update_globals requires globalsCode.")
        return _replace_globals(source, document_path, globals_code, metadata)

    if operation_type == "rename_node_function":
        node_id = _text_field(operation, "nodeId", "node_id")
        function_name = _text_field(operation, "functionName", "function_name", "newFunctionName", "new_function_name")
        if node_id is None or function_name is None:
            return _invalid_operation("rename_node_function requires nodeId and functionName.")
        return _rename_node_function(source, document_path, node_id, function_name, metadata)

    if operation_type == "add_node":
        return _add_node(source, document_path, operation, metadata)

    if operation_type == "delete_node":
        node_id = _text_field(operation, "nodeId", "node_id")
        if node_id is None:
            return _invalid_operation("delete_node requires nodeId.")
        return _delete_node(
            source,
            document_path,
            node_id,
            metadata,
            normalize_signatures=normalize_signatures,
        )

    if operation_type in {"move_node", "update_node_title", "update_node_description"}:
        node_id = _text_field(operation, "nodeId", "node_id")
        if node_id is None:
            return _invalid_operation(f"{operation_type} requires nodeId.")
        parsed = _parse_source_for_rewrite(source, document_path)
        if not parsed.document:
            return _first_issue(parsed, "Document could not be parsed.")
        if _find_node(parsed.document.nodes, node_id) is None:
            return ValidationIssue(kind="missing_node_reference", message=f"Node '{node_id}' was not found.", node_id=node_id)
        return source, _apply_metadata_operation(metadata, operation_type, node_id, operation)

    return _invalid_operation(f"Unsupported operation type: {operation_type}")


def _rewrite_edges(
    source: str,
    document_path: str | Path,
    *,
    add: EdgeSpec | None,
    remove: EdgeSpec | None,
    validate_output_bindings: bool,
    normalize_signatures: bool,
) -> RewriteResult:
    parsed = _parse_rewrite_source(
        source,
        document_path,
        validate_output_bindings,
    )
    if not parsed.ok or not parsed.document:
        return RewriteResult(source=source, parse_result=parsed)

    document = parsed.document
    nodes_by_id = {node.id: node for node in document.nodes}
    edited_edge = add or remove
    assert edited_edge is not None
    from_node_id, from_output, to_node_id, to_input = edited_edge
    if from_node_id not in nodes_by_id:
        return _missing_node(source, parsed, from_node_id)
    if to_node_id not in nodes_by_id:
        return _missing_node(source, parsed, to_node_id)
    if add is not None:
        input_issue = _validate_names(to_node_id, (to_input,), "Input")
        if input_issue is not None:
            return _with_issue(source, parsed, input_issue)
    custom_downstream_issue = _reject_custom_managed_node_input_change(
        nodes_by_id[to_node_id],
    )
    if custom_downstream_issue is not None:
        return _with_issue(source, parsed, custom_downstream_issue)

    edge_specs = [_document_edge_spec(edge) for edge in document.edges]
    if add is not None and add not in edge_specs:
        edge_specs.append(add)
    if remove is not None:
        edge_specs = [edge for edge in edge_specs if edge != remove]

    source_node = nodes_by_id[from_node_id]
    next_outputs = _outputs_routed_from_node(
        source_node.outputs,
        edge_specs,
        from_node_id,
    )
    outputs_changed = source_node.editable and next_outputs != source_node.outputs

    # A new route promotes its source before the route is rendered so every
    # intermediate document remains valid. Removing a route does the inverse:
    # first remove it, then demote the source if that was its final route.
    if add is not None and outputs_changed:
        promoted = _update_node_outputs(
            source,
            document_path,
            from_node_id,
            next_outputs,
            validate_output_bindings=validate_output_bindings,
            normalize_signatures=False,
        )
        if not promoted.ok:
            return promoted
        source = promoted.source
        parsed = _parse_rewrite_source(
            source,
            document_path,
            validate_output_bindings,
        )
        if not parsed.ok or not parsed.document:
            return RewriteResult(source=source, parse_result=parsed)
        document = parsed.document

    lines, newline, final_newline = _split_source(source)
    lines = _strip_graph_lines(source, lines)
    graph_lines = _render_graph_lines(document.nodes, edge_specs)
    if graph_lines:
        while lines and lines[-1].strip() == "":
            lines.pop()
        if lines:
            lines.append("")
        lines.extend(graph_lines)

    finish = (
        _finish_rewrite_with_normalized_signatures
        if normalize_signatures
        else _finish_rewrite
    )
    rewritten = finish(
        lines,
        newline,
        final_newline,
        document_path,
        validate_output_bindings=validate_output_bindings,
    )
    if not rewritten.ok or remove is None or not outputs_changed:
        return rewritten

    return _update_node_outputs(
        rewritten.source,
        document_path,
        from_node_id,
        next_outputs,
        validate_output_bindings=validate_output_bindings,
        normalize_signatures=normalize_signatures,
    )


def _outputs_routed_from_node(
    current_outputs: tuple[str, ...],
    edges: list[EdgeSpec],
    node_id: str,
) -> tuple[str, ...]:
    routed_outputs = list(
        dict.fromkeys(
            edge[1]
            for edge in edges
            if edge[0] == node_id
        )
    )
    routed_set = set(routed_outputs)
    return tuple(
        [output for output in current_outputs if output in routed_set]
        + [output for output in routed_outputs if output not in current_outputs]
    )


def _replace_globals(
    source: str,
    document_path: str | Path,
    globals_code: str,
    metadata: dict[str, Any],
) -> tuple[str, dict[str, Any]] | ValidationIssue:
    parsed = _parse_source_for_rewrite(source, document_path)
    if not parsed.document:
        return _first_issue(parsed, "Document could not be parsed.")

    normalized_globals = textwrap.dedent(globals_code).strip("\n")
    try:
        ast.parse(normalized_globals, filename=str(document_path))
    except SyntaxError as error:
        return ValidationIssue(
            kind="invalid_python",
            message=error.msg,
            path=f"{error.lineno}:{error.offset}",
            field="globalsCode",
        )

    lines, newline, final_newline = _split_source(source)
    excluded = _protected_line_numbers(source, parsed.document.nodes)
    replacement = normalized_globals.splitlines()
    kept_lines = [line for index, line in enumerate(lines, start=1) if index in excluded]
    if replacement:
        next_lines = [*replacement, ""]
        next_lines.extend(kept_lines)
    else:
        next_lines = kept_lines
    result = _finish_rewrite(
        _trim_blank_runs(next_lines),
        newline,
        final_newline,
        document_path,
        validate_output_bindings=False,
    )
    return _source_result_or_issue(result, metadata)


def _rename_node_function(
    source: str,
    document_path: str | Path,
    node_id: str,
    function_name: str,
    metadata: dict[str, Any],
) -> tuple[str, dict[str, Any]] | ValidationIssue:
    if not function_name.isidentifier() or keyword.iskeyword(function_name):
        return ValidationIssue(kind="unsupported_python", message=f"Function name '{function_name}' is invalid.", node_id=node_id)
    parsed = _parse_source_for_rewrite(source, document_path)
    if not parsed.document:
        return _first_issue(parsed, "Document could not be parsed.")
    node = _find_node(parsed.document.nodes, node_id)
    if node is None:
        return ValidationIssue(kind="missing_node_reference", message=f"Node '{node_id}' was not found.", node_id=node_id)
    if node.custom_return or not node.editable:
        return ValidationIssue(
            kind="unsupported_python",
            message=f"Custom-return node {node.id} cannot be renamed by Python source rewrite APIs.",
            node_id=node.id,
        )
    if any(other.id != node_id and other.function_name == function_name for other in parsed.document.nodes):
        return ValidationIssue(kind="unsupported_python", message=f"Function name '{function_name}' is already in use.", node_id=node_id)

    lines, newline, final_newline = _split_source(source)
    function_line_number = _function_def_line_number(lines, node)
    if function_line_number is None:
        return ValidationIssue(kind="unsupported_python", message=f"Function signature for node '{node_id}' could not be found.", node_id=node_id)
    lines[function_line_number - 1] = _replace_function_def_name(lines[function_line_number - 1], function_name)
    lines = _strip_graph_lines(source, lines)
    graph_lines = _render_graph_lines_with_names(
        parsed.document.nodes,
        [_document_edge_spec(edge) for edge in parsed.document.edges],
        {node_id: function_name},
    )
    _append_graph(lines, graph_lines)
    result = _finish_rewrite(
        lines,
        newline,
        final_newline,
        document_path,
        validate_output_bindings=False,
    )
    return _source_result_or_issue(result, metadata)


def _add_node(
    source: str,
    document_path: str | Path,
    operation: dict[str, Any],
    metadata: dict[str, Any],
) -> tuple[str, dict[str, Any]] | ValidationIssue:
    parsed = _parse_source_for_rewrite(source, document_path)
    if not parsed.document:
        return _first_issue(parsed, "Document could not be parsed.")
    node_operation = operation.get("node")
    node_payload = node_operation if isinstance(node_operation, dict) else operation
    node_id = _text_field(node_payload, "nodeId", "node_id", "id")
    function_name = _text_field(node_payload, "functionName", "function_name")
    outputs = node_payload.get("outputs", [])
    body_code = _text_field(node_payload, "bodyCode", "body_code", "code") or "pass"
    if (
        node_id is None
        or function_name is None
        or not isinstance(outputs, list)
        or not all(isinstance(item, str) for item in outputs)
    ):
        return _invalid_operation("add_node requires nodeId, functionName, and outputs list.")
    if any(node.id == node_id for node in parsed.document.nodes):
        return ValidationIssue(kind="duplicate_node_id", message=f"Node id '{node_id}' is already in use.", node_id=node_id)
    if any(node.function_name == function_name for node in parsed.document.nodes):
        return ValidationIssue(kind="unsupported_python", message=f"Function name '{function_name}' is already in use.", node_id=node_id)
    if not function_name.isidentifier() or keyword.iskeyword(function_name):
        return ValidationIssue(kind="unsupported_python", message=f"Function name '{function_name}' is invalid.", node_id=node_id)
    output_issue = _validate_names(node_id, tuple(outputs), "Output")
    if output_issue is not None:
        return output_issue
    lines, newline, final_newline = _split_source(source)
    lines = _strip_graph_lines(source, lines)
    if not _has_node_import(source):
        _ensure_node_import(lines)
    while lines and lines[-1].strip() == "":
        lines.pop()
    if lines:
        lines.append("")
    lines.extend(
        _render_node_lines(
            node_id,
            function_name,
            tuple(outputs),
            body_code,
        )
    )
    graph_lines = _render_graph_lines(
        parsed.document.nodes,
        [_document_edge_spec(edge) for edge in parsed.document.edges],
    )
    _append_graph(lines, graph_lines)
    next_metadata = _apply_metadata_fields(metadata, node_id, node_payload)
    result = _finish_rewrite(
        lines,
        newline,
        final_newline,
        document_path,
        validate_output_bindings=False,
    )
    return _source_result_or_issue(result, next_metadata)


def _delete_node(
    source: str,
    document_path: str | Path,
    node_id: str,
    metadata: dict[str, Any],
    *,
    normalize_signatures: bool = True,
) -> tuple[str, dict[str, Any]] | ValidationIssue:
    parsed = _parse_source_for_rewrite(source, document_path)
    if not parsed.document:
        return _first_issue(parsed, "Document could not be parsed.")
    node = _find_node(parsed.document.nodes, node_id)
    if node is None:
        return ValidationIssue(kind="missing_node_reference", message=f"Node '{node_id}' was not found.", node_id=node_id)
    custom_downstream_issue = _reject_custom_managed_downstream_change(
        parsed.document,
        node_id,
    )
    if custom_downstream_issue is not None:
        return custom_downstream_issue
    lines, newline, final_newline = _split_source(source)
    lines = _strip_graph_lines(source, lines)
    _replace_lines(lines, node.source_range.start_line, node.source_range.end_line, [])
    remaining_nodes = tuple(item for item in parsed.document.nodes if item.id != node_id)
    remaining_edges = [
        _document_edge_spec(edge)
        for edge in parsed.document.edges
        if edge.from_node != node_id and edge.to_node != node_id
    ]
    affected_source_ids = tuple(
        dict.fromkeys(
            edge.from_node
            for edge in parsed.document.edges
            if edge.to_node == node_id and edge.from_node != node_id
        )
    )
    nodes_by_id = {item.id: item for item in remaining_nodes}
    next_outputs_by_source: dict[str, tuple[str, ...]] = {}
    for source_id in affected_source_ids:
        source_node = nodes_by_id.get(source_id)
        if source_node is None or not source_node.editable:
            continue
        next_outputs = _outputs_routed_from_node(
            source_node.outputs,
            remaining_edges,
            source_id,
        )
        if next_outputs != source_node.outputs:
            next_outputs_by_source[source_id] = next_outputs
    _append_graph(lines, _render_graph_lines(remaining_nodes, remaining_edges))
    next_metadata = copy.deepcopy(metadata)
    if isinstance(next_metadata.get("nodes"), dict):
        next_metadata["nodes"].pop(node_id, None)
    finish = (
        _finish_rewrite_with_normalized_signatures
        if normalize_signatures
        else _finish_rewrite
    )
    result = finish(
        _trim_blank_runs(lines),
        newline,
        final_newline,
        document_path,
        validate_output_bindings=False,
    )
    # A batch may replace every node by deleting the existing nodes before an
    # add_node operation.  Let that temporary empty document continue through
    # the transaction; apply_document_operations performs a strict parse after
    # the complete batch and will still reject a document that ends empty.
    if result.issues and all(issue.kind == "missing_node" for issue in result.issues):
        return result.source, next_metadata
    if not result.ok:
        return _source_result_or_issue(result, next_metadata)

    rewritten = result
    for source_id, next_outputs in next_outputs_by_source.items():
        rewritten = _update_node_outputs(
            rewritten.source,
            document_path,
            source_id,
            next_outputs,
            validate_output_bindings=False,
            normalize_signatures=False,
        )
        if not rewritten.ok:
            return _source_result_or_issue(rewritten, next_metadata)

    return rewritten.source, next_metadata


def _find_node(nodes: tuple[DocumentNode, ...], node_id: str) -> DocumentNode | None:
    return next((node for node in nodes if node.id == node_id), None)


def _reject_uneditable_node(
    source: str,
    parsed: ParseResult,
    node_id: str,
    node: DocumentNode | None,
) -> RewriteResult | None:
    if node is None:
        return _with_issue(
            source,
            parsed,
            ValidationIssue(kind="missing_node_reference", message=f"Node '{node_id}' was not found.", node_id=node_id),
        )
    if node.custom_return or not node.editable:
        return _unsupported(
            source,
            parsed,
            node.id,
            f"Custom-return node {node.id} cannot be edited by Python source rewrite APIs.",
        )
    return None


def _validate_names(
    node_id: str,
    names: tuple[str, ...],
    label: str,
    *,
    maximum: int | None = None,
) -> ValidationIssue | None:
    if maximum is not None and len(names) > maximum:
        return ValidationIssue(
            kind="unsupported_python",
            message=f"Node {node_id} may declare at most {maximum} {label.lower()}s.",
            node_id=node_id,
        )
    seen: set[str] = set()
    for name in names:
        if (
            not name.isidentifier()
            or keyword.iskeyword(name)
            or name.startswith("__rowcall_")
            or name == "display"
        ):
            return ValidationIssue(
                kind="unsupported_python",
                message=(
                    f"{label} '{name}' on node {node_id} must be a valid Python "
                    "variable name without the reserved name 'display' or "
                    "the '__rowcall_' prefix."
                ),
                node_id=node_id,
            )
        if name in seen:
            return ValidationIssue(
                kind="unsupported_python",
                message=f"{label} '{name}' is declared more than once on node {node_id}.",
                node_id=node_id,
            )
        seen.add(name)
    return None


def _render_body_lines(body_code: str, indent: str) -> list[str]:
    code = textwrap.dedent(body_code).strip("\n")
    if not code.strip():
        return [f"{indent}pass"]
    return [f"{indent}{line}" if line else "" for line in code.splitlines()]


def _render_decorator(
    node_id: str,
    outputs: tuple[str, ...],
) -> str:
    return f"@node(id={json.dumps(node_id)}, outputs={json.dumps(list(outputs))})"


def _render_return_line(outputs: tuple[str, ...], indent: str) -> str:
    items = ", ".join(f"{output!r}: {output}" for output in outputs).replace("'", '"')
    return f"{indent}return {{{items}}}"


def _render_graph_lines(nodes: tuple[DocumentNode, ...], edges: list[EdgeSpec]) -> list[str]:
    if not edges:
        return []

    function_by_id = {node.id: node.function_name for node in nodes}
    return _render_graph_lines_for_names(nodes, edges, function_by_id)


def _render_graph_lines_with_names(
    nodes: tuple[DocumentNode, ...],
    edges: list[EdgeSpec],
    overrides: dict[str, str],
) -> list[str]:
    if not edges:
        return []
    function_by_id = {node.id: overrides.get(node.id, node.function_name) for node in nodes}
    return _render_graph_lines_for_names(nodes, edges, function_by_id)


def _render_graph_lines_for_names(
    nodes: tuple[DocumentNode, ...],
    edges: list[EdgeSpec],
    function_by_id: dict[str, str],
) -> list[str]:
    node_order = {node.id: index for index, node in enumerate(nodes)}
    routes_by_to: dict[str, list[tuple[str, str, str]]] = {}
    for from_node, from_output, to_node, to_input in edges:
        routes_by_to.setdefault(to_node, []).append(
            (from_node, from_output, to_input)
        )

    lines = ["# Rowcall graph"]
    for to_node in sorted(routes_by_to, key=lambda node_id: node_order.get(node_id, 10**9)):
        declared_routes = routes_by_to[to_node]
        routes = [route for route in declared_routes if route[2] == route[1]]
        routes.extend(route for route in declared_routes if route[2] != route[1])
        references = []
        for from_node, from_output, to_input in routes:
            reference = f"{function_by_id[from_node]}.output({json.dumps(from_output)})"
            references.append(
                reference if to_input == from_output else f"{to_input}={reference}"
            )
        lines.append(
            f"{function_by_id[to_node]}.depends_on({', '.join(references)})"
        )
    return lines


def _render_node_lines(
    node_id: str,
    function_name: str,
    outputs: tuple[str, ...],
    body_code: str,
) -> list[str]:
    body_lines = _render_body_lines(body_code, "    ")
    return [
        _render_decorator(node_id, outputs),
        f"def {function_name}():",
        *body_lines,
        _render_return_line(outputs, "    "),
    ]


def _append_graph(lines: list[str], graph_lines: list[str]) -> None:
    if not graph_lines:
        return
    while lines and lines[-1].strip() == "":
        lines.pop()
    if lines:
        lines.append("")
    lines.extend(graph_lines)


def _node_decorator_range(source: str, node: DocumentNode) -> tuple[int, int] | None:
    try:
        module = ast.parse(source)
    except SyntaxError:
        return None
    for statement in module.body:
        if not isinstance(statement, ast.FunctionDef) or statement.name != node.function_name:
            continue
        for decorator in statement.decorator_list:
            if isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Name) and decorator.func.id == "node":
                return decorator.lineno, decorator.end_lineno or decorator.lineno
    return None


def _strip_graph_lines(source: str, lines: list[str]) -> list[str]:
    graph_line_numbers = _top_level_graph_line_numbers(source, lines)
    return [line for index, line in enumerate(lines, start=1) if index not in graph_line_numbers]


def _top_level_graph_line_numbers(source: str, lines: list[str]) -> set[int]:
    line_numbers = {index for index, line in enumerate(lines, start=1) if line.strip() == "# Rowcall graph"}
    try:
        module = ast.parse(source)
    except SyntaxError:
        return line_numbers

    for statement in module.body:
        if not isinstance(statement, ast.Expr) or not _is_depends_on_call(statement.value):
            continue
        for line_number in range(statement.lineno, (statement.end_lineno or statement.lineno) + 1):
            line_numbers.add(line_number)
    return line_numbers


def _is_depends_on_call(value: ast.AST) -> bool:
    return (
        isinstance(value, ast.Call)
        and isinstance(value.func, ast.Attribute)
        and value.func.attr == "depends_on"
        and isinstance(value.func.value, ast.Name)
    )


def _split_source(source: str) -> tuple[list[str], str, bool]:
    newline = "\r\n" if "\r\n" in source else "\n"
    return source.splitlines(), newline, source.endswith(("\n", "\r\n"))


def _join_source(lines: list[str], newline: str, final_newline: bool) -> str:
    text = newline.join(lines)
    if final_newline and (text or lines):
        text += newline
    return text


def _replace_lines(lines: list[str], start_line: int, end_line: int, replacement: list[str]) -> None:
    lines[start_line - 1 : end_line] = replacement


def _parse_rewrite_source(
    source: str,
    document_path: str | Path,
    validate_output_bindings: bool,
) -> ParseResult:
    if validate_output_bindings:
        return parse_source(source, document_path)
    return _parse_source_for_rewrite(source, document_path)


def _finish_rewrite(
    lines: list[str],
    newline: str,
    final_newline: bool,
    document_path: str | Path,
    *,
    validate_output_bindings: bool,
) -> RewriteResult:
    rewritten = _join_source(lines, newline, final_newline)
    return RewriteResult(
        source=rewritten,
        parse_result=_parse_rewrite_source(
            rewritten,
            document_path,
            validate_output_bindings,
        ),
    )


def _finish_rewrite_with_normalized_signatures(
    lines: list[str],
    newline: str,
    final_newline: bool,
    document_path: str | Path,
    *,
    validate_output_bindings: bool,
) -> RewriteResult:
    rewritten = _join_source(lines, newline, final_newline)
    parsed = _parse_rewrite_source(
        rewritten,
        document_path,
        validate_output_bindings,
    )
    if parsed.document is None:
        return RewriteResult(source=rewritten, parse_result=parsed)

    normalized = _normalize_function_signatures(rewritten, parsed.document)
    if isinstance(normalized, ValidationIssue):
        return _with_issue(rewritten, parsed, normalized)
    if normalized == rewritten:
        return RewriteResult(source=rewritten, parse_result=parsed)

    normalized_lines, normalized_newline, normalized_final_newline = _split_source(normalized)
    return _finish_rewrite(
        normalized_lines,
        normalized_newline,
        normalized_final_newline,
        document_path,
        validate_output_bindings=validate_output_bindings,
    )


def _normalize_function_signatures(
    source: str,
    document: ExecutableDocument,
) -> str | ValidationIssue:
    replacements: list[tuple[int, int, str]] = []
    for node in document.nodes:
        parameters = _expected_node_parameters(document, node.id)
        if node.parameters == parameters:
            continue
        if node.custom_return or not node.editable:
            return ValidationIssue(
                kind="unsupported_python",
                message=(
                    f"Custom-return node {node.id} cannot have its function "
                    "signature rewritten by graph operations."
                ),
                node_id=node.id,
            )

        replacement = _function_parameter_replacement(source, node, parameters)
        if replacement is None:
            return ValidationIssue(
                kind="unsupported_python",
                message=f"Function signature for node '{node.id}' could not be rewritten.",
                node_id=node.id,
            )
        replacements.append(replacement)

    rewritten = source
    for start, end, replacement in sorted(replacements, reverse=True):
        rewritten = f"{rewritten[:start]}{replacement}{rewritten[end:]}"
    return rewritten


def _function_parameter_replacement(
    source: str,
    node: DocumentNode,
    parameters: tuple[str, ...],
) -> tuple[int, int, str] | None:
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (IndentationError, tokenize.TokenError):
        return None

    opening: tokenize.TokenInfo | None = None
    closing: tokenize.TokenInfo | None = None
    for index, token in enumerate(tokens):
        if (
            token.type != tokenize.NAME
            or token.string != "def"
            or token.start[0] < node.source_range.start_line
            or token.start[0] > node.source_range.end_line
        ):
            continue
        name_index = _next_significant_token_index(tokens, index + 1)
        if name_index is None or tokens[name_index].string != node.function_name:
            continue
        opening_index = _next_significant_token_index(tokens, name_index + 1)
        if opening_index is None or tokens[opening_index].string != "(":
            return None
        opening = tokens[opening_index]
        depth = 0
        for candidate in tokens[opening_index:]:
            if candidate.type != tokenize.OP:
                continue
            if candidate.string == "(":
                depth += 1
            elif candidate.string == ")":
                depth -= 1
                if depth == 0:
                    closing = candidate
                    break
        break

    if opening is None or closing is None:
        return None

    line_offsets = _source_line_offsets(source)
    start = _source_offset(line_offsets, opening.end)
    end = _source_offset(line_offsets, closing.start)
    if start is None or end is None or end < start:
        return None

    replacement = _render_function_parameters(
        source,
        opening,
        closing,
        start,
        end,
        parameters,
    )
    return start, end, replacement


def _next_significant_token_index(
    tokens: list[tokenize.TokenInfo],
    start: int,
) -> int | None:
    ignored = {
        tokenize.ENCODING,
        tokenize.INDENT,
        tokenize.DEDENT,
        tokenize.NL,
        tokenize.NEWLINE,
        tokenize.COMMENT,
    }
    for index in range(start, len(tokens)):
        if tokens[index].type not in ignored:
            return index
    return None


def _source_line_offsets(source: str) -> list[int]:
    offsets = [0]
    for line in source.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    return offsets


def _source_offset(
    line_offsets: list[int],
    position: tuple[int, int],
) -> int | None:
    line, column = position
    if line < 1 or line > len(line_offsets):
        return None
    return line_offsets[line - 1] + column


def _render_function_parameters(
    source: str,
    opening: tokenize.TokenInfo,
    closing: tokenize.TokenInfo,
    start: int,
    end: int,
    parameters: tuple[str, ...],
) -> str:
    if opening.start[0] == closing.start[0]:
        return ", ".join(parameters)

    newline = "\r\n" if "\r\n" in source else "\n"
    source_lines = source.splitlines()
    function_line = source_lines[opening.start[0] - 1]
    function_indent = function_line[: len(function_line) - len(function_line.lstrip())]
    parameter_indent = _existing_parameter_indent(
        source[start:end],
        function_indent,
    )
    if not parameters:
        return f"{newline}{function_indent}"
    rendered = newline.join(f"{parameter_indent}{parameter}," for parameter in parameters)
    return f"{newline}{rendered}{newline}{function_indent}"


def _existing_parameter_indent(parameter_source: str, function_indent: str) -> str:
    for line in parameter_source.splitlines()[1:]:
        if not line.strip():
            continue
        indent = line[: len(line) - len(line.lstrip())]
        if len(indent) > len(function_indent):
            return indent
    return f"{function_indent}    "


def _expected_node_parameters(document: ExecutableDocument, node_id: str) -> tuple[str, ...]:
    parameters: list[str] = []
    seen: set[str] = set()
    for edge in document.edges:
        if edge.to_node != node_id:
            continue
        if edge.to_input in seen:
            continue
        if not edge.to_input.isidentifier() or keyword.iskeyword(edge.to_input):
            continue
        seen.add(edge.to_input)
        parameters.append(edge.to_input)
    return tuple(parameters)


def _reject_custom_managed_downstream_change(
    document: ExecutableDocument,
    from_node_id: str,
) -> ValidationIssue | None:
    nodes_by_id = {node.id: node for node in document.nodes}
    for edge in document.edges:
        if edge.from_node != from_node_id:
            continue
        downstream = nodes_by_id.get(edge.to_node)
        if downstream is None:
            continue
        issue = _reject_custom_managed_node_input_change(downstream)
        if issue is not None:
            return issue
    return None


def _reject_custom_managed_node_input_change(
    node: DocumentNode,
) -> ValidationIssue | None:
    if not node.custom_return and node.editable:
        return None
    return ValidationIssue(
        kind="unsupported_python",
        message=(
            f"Custom-return node {node.id} cannot have its input dependencies "
            "changed by graph operations."
        ),
        node_id=node.id,
    )


def _unsupported(source: str, parsed: ParseResult, node_id: str, message: str) -> RewriteResult:
    return _with_issue(source, parsed, ValidationIssue(kind="unsupported_python", message=message, node_id=node_id))


def _missing_node(source: str, parsed: ParseResult, node_id: str) -> RewriteResult:
    return _with_issue(
        source,
        parsed,
        ValidationIssue(kind="missing_node_reference", message=f"Node '{node_id}' was not found.", node_id=node_id),
    )


def _with_issue(source: str, parsed: ParseResult, issue: ValidationIssue) -> RewriteResult:
    return RewriteResult(
        source=source,
        parse_result=ParseResult(ok=False, document=parsed.document, issues=(*parsed.issues, issue)),
    )


def _operation_failure(
    original_source: str,
    document_path: str | Path,
    issue: ValidationIssue,
    operation_index: int | None = None,
    operation_type: str | None = None,
) -> OperationRewriteResult:
    parsed = parse_source(original_source, document_path)
    tagged_issue = _tag_operation_issue(issue, operation_index, operation_type)
    return OperationRewriteResult(
        ok=False,
        source=None,
        parse_result=ParseResult(ok=False, document=parsed.document, issues=(*parsed.issues, tagged_issue)),
        sidecar_metadata=None,
    )


def _tag_operation_issue(
    issue: ValidationIssue,
    operation_index: int | None,
    operation_type: str | None,
) -> ValidationIssue:
    return ValidationIssue(
        kind=issue.kind,
        message=issue.message,
        path=issue.path,
        node_id=issue.node_id,
        edge_index=issue.edge_index,
        field=issue.field,
        operation_index=operation_index,
        operation_type=operation_type,
    )


def _source_result_or_issue(
    result: RewriteResult,
    metadata: dict[str, Any],
) -> tuple[str, dict[str, Any]] | ValidationIssue:
    if result.ok:
        return result.source, metadata
    return result.issues[-1] if result.issues else _invalid_operation("Operation failed.")


def _first_issue(parsed: ParseResult, fallback: str) -> ValidationIssue:
    return parsed.issues[0] if parsed.issues else ValidationIssue(kind="invalid_python", message=fallback)


def _invalid_operation(message: str) -> ValidationIssue:
    return ValidationIssue(kind="invalid_operation", message=message)


def _text_field(operation: dict[str, Any], *names: str) -> str | None:
    for name in names:
        value = operation.get(name)
        if isinstance(value, str):
            return value
    return None


def _edge_spec(operation: dict[str, Any]) -> EdgeSpec | None:
    from_node = _text_field(operation, "fromNode", "from_node", "fromNodeId", "from_node_id")
    from_output = _text_field(operation, "fromOutput", "from_output")
    to_node = _text_field(operation, "toNode", "to_node", "toNodeId", "to_node_id")
    to_input = _text_field(operation, "toInput", "to_input")
    if from_node is None or from_output is None or to_node is None or to_input is None:
        return None
    return from_node, from_output, to_node, to_input


def _document_edge_spec(edge: DocumentEdge) -> EdgeSpec:
    return edge.from_node, edge.from_output, edge.to_node, edge.to_input


def _protected_line_numbers(source: str, nodes: tuple[DocumentNode, ...]) -> set[int]:
    lines = source.splitlines()
    protected = _top_level_graph_line_numbers(source, lines)
    for node in nodes:
        protected.update(range(node.source_range.start_line, node.source_range.end_line + 1))
    try:
        module = ast.parse(source)
    except SyntaxError:
        return protected
    for statement in module.body:
        if isinstance(statement, ast.ImportFrom) and statement.module == "rowcall":
            protected.update(range(statement.lineno, (statement.end_lineno or statement.lineno) + 1))
    return protected


def _has_node_import(source: str) -> bool:
    try:
        module = ast.parse(source)
    except SyntaxError:
        return False
    for statement in module.body:
        if not isinstance(statement, ast.ImportFrom) or statement.module != "rowcall":
            continue
        if any(alias.name == "node" and alias.asname is None for alias in statement.names):
            return True
    return False


def _ensure_node_import(lines: list[str]) -> None:
    insertion_index = _node_import_insertion_index(lines)
    insert_lines = ["from rowcall import node"]
    if insertion_index < len(lines) and lines[insertion_index].strip() != "":
        insert_lines.append("")
    lines[insertion_index:insertion_index] = insert_lines


def _node_import_insertion_index(lines: list[str]) -> int:
    insertion_index = 1 if lines and lines[0].startswith("#!") else 0
    source = "\n".join(lines)
    try:
        module = ast.parse(source)
    except SyntaxError:
        return insertion_index

    body = list(module.body)
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        insertion_index = max(insertion_index, body.pop(0).end_lineno or 1)

    for statement in body:
        if not (
            isinstance(statement, ast.ImportFrom)
            and statement.module == "__future__"
        ):
            break
        insertion_index = max(insertion_index, statement.end_lineno or statement.lineno)

    while insertion_index < len(lines) and lines[insertion_index].strip() == "":
        insertion_index += 1

    return insertion_index


def _replace_function_def_name(line: str, function_name: str) -> str:
    prefix, rest = line.split("def ", 1)
    _, suffix = rest.split("(", 1)
    return f"{prefix}def {function_name}({suffix}"


def _function_def_line_number(lines: list[str], node: DocumentNode) -> int | None:
    for index in range(node.source_range.start_line, min(node.source_range.end_line, len(lines)) + 1):
        if lines[index - 1].lstrip().startswith("def "):
            return index
    return None


def _trim_blank_runs(lines: list[str]) -> list[str]:
    result: list[str] = []
    blank_count = 0
    for line in lines:
        if line.strip() == "":
            blank_count += 1
            if blank_count > 2:
                continue
        else:
            blank_count = 0
        result.append(line)
    while result and result[0].strip() == "":
        result.pop(0)
    return result


def _apply_metadata_operation(
    metadata: dict[str, Any],
    operation_type: str,
    node_id: str,
    operation: dict[str, Any],
) -> dict[str, Any]:
    next_metadata = copy.deepcopy(metadata)
    return _apply_metadata_fields(next_metadata, node_id, operation, operation_type)


def _apply_metadata_fields(
    metadata: dict[str, Any],
    node_id: str,
    operation: dict[str, Any],
    operation_type: str | None = None,
) -> dict[str, Any]:
    next_metadata = _normalize_sidecar_metadata(metadata)
    nodes = next_metadata.setdefault("nodes", {})
    if not isinstance(nodes, dict):
        nodes = {}
        next_metadata["nodes"] = nodes
    node_metadata = nodes.setdefault(node_id, {})
    if not isinstance(node_metadata, dict):
        node_metadata = {}
        nodes[node_id] = node_metadata

    if operation_type == "move_node" or "position" in operation:
        position = operation.get("position")
        if isinstance(position, dict):
            node_metadata["position"] = copy.deepcopy(position)
    if operation_type == "update_node_title" or "title" in operation:
        title = operation.get("title")
        if isinstance(title, str):
            node_metadata["title"] = title
    if operation_type == "update_node_description" or "description" in operation:
        description = operation.get("description")
        if isinstance(description, str):
            node_metadata["description"] = description
    return next_metadata


def _normalize_sidecar_metadata(value: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {"nodes": {}}

    raw_nodes = value.get("nodes")
    if isinstance(raw_nodes, dict):
        return {
            "nodes": {
                str(node_id): copy.deepcopy(metadata)
                for node_id, metadata in raw_nodes.items()
                if isinstance(metadata, dict)
            }
        }

    if isinstance(raw_nodes, list):
        nodes: dict[str, Any] = {}
        for item in raw_nodes:
            if not isinstance(item, dict):
                continue
            node_id = item.get("id")
            if not isinstance(node_id, str):
                continue
            metadata = {
                key: copy.deepcopy(metadata_value)
                for key, metadata_value in item.items()
                if key != "id"
            }
            nodes[node_id] = metadata
        return {"nodes": nodes}

    return {"nodes": {}}
