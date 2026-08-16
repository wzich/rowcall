"""Validation helpers for parsed Rowcall documents."""

from __future__ import annotations

import keyword
from collections import defaultdict

from .models import DocumentEdge, ExecutableDocument, ValidationIssue, ValidationResult


def validate_document(document: ExecutableDocument) -> ValidationResult:
    issues: list[ValidationIssue] = []
    _validate_duplicate_node_ids(document, issues)
    _validate_duplicate_function_names(document, issues)
    _validate_node_metadata(document, issues)
    _validate_edge_endpoints(document, issues)
    _validate_duplicate_edges(document, issues)
    _validate_cycles(document, issues)
    _validate_conflicting_upstream_outputs(document, issues)
    _validate_node_parameters_satisfied(document, issues)
    return ValidationResult(ok=len(issues) == 0, issues=tuple(issues))


def build_downstream_adjacency(document: ExecutableDocument) -> dict[str, list[str]]:
    adjacency = {node.id: [] for node in document.nodes}
    for edge in document.edges:
        adjacency.setdefault(edge.from_node, []).append(edge.to_node)
    return adjacency


def build_upstream_adjacency(document: ExecutableDocument) -> dict[str, list[str]]:
    adjacency = {node.id: [] for node in document.nodes}
    for edge in document.edges:
        adjacency.setdefault(edge.to_node, []).append(edge.from_node)
    return adjacency


def get_sink_node_ids(document: ExecutableDocument) -> tuple[str, ...]:
    downstream = build_downstream_adjacency(document)
    return tuple(node.id for node in document.nodes if len(downstream.get(node.id, [])) == 0)


def collect_required_node_ids(document: ExecutableDocument, target_node_id: str) -> set[str]:
    node_ids = {node.id for node in document.nodes}
    if target_node_id not in node_ids:
        raise ValueError(f"Failed to find node with ID {target_node_id}")

    required: set[str] = set()
    upstream = build_upstream_adjacency(document)

    def visit(node_id: str) -> None:
        if node_id in required:
            return
        required.add(node_id)
        for parent_id in upstream.get(node_id, []):
            visit(parent_id)

    visit(target_node_id)
    return required


def _validate_duplicate_node_ids(document: ExecutableDocument, issues: list[ValidationIssue]) -> None:
    seen: set[str] = set()
    for index, node in enumerate(document.nodes):
        if node.id in seen:
            issues.append(
                ValidationIssue(
                    kind="duplicate_node_id",
                    message=f"Node ID '{node.id}' is not unique",
                    node_id=node.id,
                    path=f"nodes[{index}].id",
                )
            )
        seen.add(node.id)


def _validate_duplicate_function_names(document: ExecutableDocument, issues: list[ValidationIssue]) -> None:
    seen: set[str] = set()
    for index, node in enumerate(document.nodes):
        if node.function_name in seen:
            issues.append(
                ValidationIssue(
                    kind="duplicate_function_name",
                    message=f"Node function '{node.function_name}' is not unique",
                    node_id=node.id,
                    path=f"nodes[{index}].functionName",
                )
            )
        seen.add(node.function_name)


def _validate_node_metadata(document: ExecutableDocument, issues: list[ValidationIssue]) -> None:
    for index, node in enumerate(document.nodes):
        if not node.id.strip():
            issues.append(
                ValidationIssue(
                    kind="invalid_node_id",
                    message="Node IDs must not be empty or whitespace",
                    node_id=node.id,
                    path=f"nodes[{index}].id",
                )
            )
        seen_outputs: set[str] = set()
        for output_index, output in enumerate(node.outputs):
            if (
                not output.isidentifier()
                or keyword.iskeyword(output)
                or output.startswith("__rowcall_")
                or output == "display"
            ):
                issues.append(
                    ValidationIssue(
                        kind="invalid_output",
                        message=(
                            f"Output '{output}' on node '{node.id}' must be a valid "
                            "Python variable name and must not use the reserved "
                            "name 'display' or the reserved '__rowcall_' prefix"
                        ),
                        node_id=node.id,
                        path=f"nodes[{index}].outputs[{output_index}]",
                    )
                )
            if output in seen_outputs:
                issues.append(
                    ValidationIssue(
                        kind="duplicate_output",
                        message=f"Node '{node.id}' declares output '{output}' more than once",
                        node_id=node.id,
                        path=f"nodes[{index}].outputs[{output_index}]",
                    )
                )
            seen_outputs.add(output)

def _validate_duplicate_edges(document: ExecutableDocument, issues: list[ValidationIssue]) -> None:
    seen: set[tuple[str, str]] = set()
    for index, edge in enumerate(document.edges):
        key = (edge.from_node, edge.to_node)
        if key in seen:
            issues.append(
                ValidationIssue(
                    kind="duplicate_edge",
                    message=f"Edge from '{edge.from_node}' to '{edge.to_node}' is duplicated",
                    edge_index=index,
                    path=f"edges[{index}]",
                )
            )
        seen.add(key)


def _validate_edge_endpoints(document: ExecutableDocument, issues: list[ValidationIssue]) -> None:
    node_ids = {node.id for node in document.nodes}
    for index, edge in enumerate(document.edges):
        if edge.from_node not in node_ids:
            issues.append(_missing_endpoint(edge, index, "fromNode"))
        if edge.to_node not in node_ids:
            issues.append(_missing_endpoint(edge, index, "toNode"))


def _missing_endpoint(edge: DocumentEdge, index: int, field: str) -> ValidationIssue:
    node_id = edge.from_node if field == "fromNode" else edge.to_node
    return ValidationIssue(
        kind="missing_node_reference",
        message=f"Edge references nonexistent node {node_id}",
        edge_index=index,
        field=field,
        path=f"edges[{index}].{field}",
    )


def _validate_cycles(document: ExecutableDocument, issues: list[ValidationIssue]) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()
    downstream = build_downstream_adjacency(document)

    def visit(node_id: str) -> bool:
        if node_id in visiting:
            return True
        if node_id in visited:
            return False
        visiting.add(node_id)
        for neighbor in downstream.get(node_id, []):
            if neighbor not in downstream:
                continue
            if visit(neighbor):
                return True
        visiting.remove(node_id)
        visited.add(node_id)
        return False

    for node in document.nodes:
        if visit(node.id):
            issues.append(ValidationIssue(kind="cycle", message="Graph has a cycle"))
            return


def _validate_conflicting_upstream_outputs(document: ExecutableDocument, issues: list[ValidationIssue]) -> None:
    upstream = build_upstream_adjacency(document)
    outputs_by_node = {node.id: node.outputs for node in document.nodes}
    for node in document.nodes:
        owners_by_output: dict[str, list[str]] = defaultdict(list)
        for parent_id in upstream.get(node.id, []):
            for output in outputs_by_node.get(parent_id, ()):
                owners_by_output[output].append(parent_id)
        conflicts = [name for name, owners in owners_by_output.items() if len(owners) > 1]
        if conflicts:
            issues.append(
                ValidationIssue(
                    kind="conflicting_outputs",
                    message=f"Node '{node.id}' has conflicting upstream outputs: {', '.join(conflicts)}",
                    node_id=node.id,
                )
            )


def _validate_node_parameters_satisfied(
    document: ExecutableDocument,
    issues: list[ValidationIssue],
) -> None:
    upstream = build_upstream_adjacency(document)
    outputs_by_node = {node.id: node.outputs for node in document.nodes}
    node_ids = set(outputs_by_node)

    for node in document.nodes:
        available_inputs: set[str] = set()
        for parent_id in upstream.get(node.id, []):
            if parent_id not in node_ids:
                continue
            available_inputs.update(outputs_by_node[parent_id])

        missing_parameters = [
            parameter
            for parameter in node.parameters
            if parameter not in available_inputs
        ]
        if not missing_parameters:
            continue

        issues.append(
            ValidationIssue(
                kind="unsupported_python",
                message=(
                    f"Node '{node.id}' has parameters without direct upstream "
                    f"outputs: {', '.join(missing_parameters)}"
                ),
                node_id=node.id,
            )
        )
