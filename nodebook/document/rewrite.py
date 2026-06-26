"""Source rewrite helpers for Python-owned Nodebook documents."""

from __future__ import annotations

import ast
import keyword
import textwrap
from dataclasses import dataclass
from pathlib import Path

from .models import DocumentNode, ParseResult, ValidationIssue
from .parser import parse_source


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


def update_node_body(source: str, document_path: str | Path, node_id: str, body_code: str) -> RewriteResult:
    parsed = parse_source(source, document_path)
    if not parsed.document:
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
    return_line = _render_return_line(node.outputs, node.source_range.indent or "    ")
    _replace_lines(
        lines,
        node.source_range.body_start_line or node.source_range.return_line,
        node.source_range.return_end_line,
        [*body_lines, return_line],
    )
    return _finish_rewrite(lines, newline, final_newline, document_path)


def update_node_outputs(source: str, document_path: str | Path, node_id: str, outputs: list[str] | tuple[str, ...]) -> RewriteResult:
    parsed = parse_source(source, document_path)
    if not parsed.document:
        return RewriteResult(source=source, parse_result=parsed)

    node = _find_node(parsed.document.nodes, node_id)
    rejection = _reject_uneditable_node(source, parsed, node_id, node)
    if rejection is not None:
        return rejection

    assert node is not None
    next_outputs = tuple(outputs)
    output_issue = _validate_outputs(node_id, next_outputs)
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
        [_render_return_line(next_outputs, node.source_range.indent or "    ")],
    )
    _replace_lines(lines, decorator_range[0], decorator_range[1], [_render_decorator(node.id, next_outputs)])
    return _finish_rewrite(lines, newline, final_newline, document_path)


def add_edge(source: str, document_path: str | Path, from_node_id: str, to_node_id: str) -> RewriteResult:
    return _rewrite_edges(source, document_path, add=(from_node_id, to_node_id), remove=None)


def remove_edge(source: str, document_path: str | Path, from_node_id: str, to_node_id: str) -> RewriteResult:
    return _rewrite_edges(source, document_path, add=None, remove=(from_node_id, to_node_id))


def _rewrite_edges(
    source: str,
    document_path: str | Path,
    *,
    add: tuple[str, str] | None,
    remove: tuple[str, str] | None,
) -> RewriteResult:
    parsed = parse_source(source, document_path)
    if not parsed.document:
        return RewriteResult(source=source, parse_result=parsed)

    document = parsed.document
    nodes_by_id = {node.id: node for node in document.nodes}
    edited_pair = add or remove
    assert edited_pair is not None
    from_node_id, to_node_id = edited_pair
    if from_node_id not in nodes_by_id:
        return _missing_node(source, parsed, from_node_id)
    if to_node_id not in nodes_by_id:
        return _missing_node(source, parsed, to_node_id)

    edge_pairs = [(edge.from_node, edge.to_node) for edge in document.edges]
    if add is not None and add not in edge_pairs:
        edge_pairs.append(add)
    if remove is not None:
        edge_pairs = [edge for edge in edge_pairs if edge != remove]

    lines, newline, final_newline = _split_source(source)
    lines = _strip_graph_lines(source, lines)
    graph_lines = _render_graph_lines(document.nodes, edge_pairs)
    if graph_lines:
        while lines and lines[-1].strip() == "":
            lines.pop()
        if lines:
            lines.append("")
        lines.extend(graph_lines)

    return _finish_rewrite(lines, newline, final_newline, document_path)


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


def _validate_outputs(node_id: str, outputs: tuple[str, ...]) -> ValidationIssue | None:
    seen: set[str] = set()
    for output in outputs:
        if not output.isidentifier() or keyword.iskeyword(output):
            return ValidationIssue(
                kind="unsupported_python",
                message=f"Output '{output}' on node {node_id} must be a valid Python variable name.",
                node_id=node_id,
            )
        if output in seen:
            return ValidationIssue(
                kind="unsupported_python",
                message=f"Output '{output}' is declared more than once on node {node_id}.",
                node_id=node_id,
            )
        seen.add(output)
    return None


def _render_body_lines(body_code: str, indent: str) -> list[str]:
    code = textwrap.dedent(body_code).strip("\n")
    if not code.strip():
        return [f"{indent}pass"]
    return [f"{indent}{line}" if line else "" for line in code.splitlines()]


def _render_decorator(node_id: str, outputs: tuple[str, ...]) -> str:
    return f"@node(id={node_id!r}, outputs={list(outputs)!r})".replace("'", '"')


def _render_return_line(outputs: tuple[str, ...], indent: str) -> str:
    items = ", ".join(f"{output!r}: {output}" for output in outputs).replace("'", '"')
    return f"{indent}return {{{items}}}"


def _render_graph_lines(nodes: tuple[DocumentNode, ...], edges: list[tuple[str, str]]) -> list[str]:
    if not edges:
        return []

    function_by_id = {node.id: node.function_name for node in nodes}
    node_order = {node.id: index for index, node in enumerate(nodes)}
    upstreams_by_to: dict[str, list[str]] = {}
    for from_node, to_node in edges:
        upstreams_by_to.setdefault(to_node, [])
        if from_node not in upstreams_by_to[to_node]:
            upstreams_by_to[to_node].append(from_node)

    lines = ["# NodeBook graph"]
    for to_node in sorted(upstreams_by_to, key=lambda node_id: node_order.get(node_id, 10**9)):
        upstreams = sorted(upstreams_by_to[to_node], key=lambda node_id: node_order.get(node_id, 10**9))
        upstream_names = ", ".join(function_by_id[node_id] for node_id in upstreams)
        lines.append(f"{function_by_id[to_node]}.depends_on({upstream_names})")
    return lines


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
    line_numbers = {index for index, line in enumerate(lines, start=1) if line.strip() == "# NodeBook graph"}
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


def _finish_rewrite(lines: list[str], newline: str, final_newline: bool, document_path: str | Path) -> RewriteResult:
    rewritten = _join_source(lines, newline, final_newline)
    return RewriteResult(source=rewritten, parse_result=parse_source(rewritten, document_path))


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
