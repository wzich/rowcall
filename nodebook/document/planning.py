"""Run planning helpers for parsed Nodebook documents."""

from __future__ import annotations

from .models import ExecutableDocument, RunPlan, RunPlanStep
from .validation import (
    build_downstream_adjacency,
    build_upstream_adjacency,
    get_sink_node_ids,
)


def build_run_plan(document: ExecutableDocument, target_node_id: str) -> RunPlan:
    return build_run_plan_for_targets(document, (target_node_id,))


def build_full_graph_plan(document: ExecutableDocument) -> RunPlan:
    return build_run_plan_for_targets(document, get_sink_node_ids(document))


def build_run_plan_for_targets(document: ExecutableDocument, target_node_ids: tuple[str, ...] | list[str]) -> RunPlan:
    targets = tuple(target_node_ids)
    required: dict[str, None] = {}
    upstream = build_upstream_adjacency(document)
    for node_id in targets:
        _collect_required_node_ids(document, node_id, upstream, required)

    downstream = build_downstream_adjacency(document)
    required_ids = set(required)

    depends_on: dict[str, tuple[str, ...]] = {}
    in_degree: dict[str, int] = {}
    for node_id in required:
        parents = tuple(parent for parent in upstream.get(node_id, []) if parent in required_ids)
        depends_on[node_id] = parents
        in_degree[node_id] = len(parents)

    queue = [node_id for node_id in required if in_degree[node_id] == 0]
    steps: list[RunPlanStep] = []

    while queue:
        node_id = queue.pop(0)
        steps.append(RunPlanStep(node_id=node_id, depends_on=depends_on.get(node_id, ())))

        for child_id in downstream.get(node_id, []):
            if child_id not in required_ids:
                continue
            in_degree[child_id] -= 1
            if in_degree[child_id] == 0:
                queue.append(child_id)

    if len(steps) != len(required):
        raise ValueError("Could not build run plan")

    return RunPlan(target_node_ids=targets, steps=tuple(steps))


def _collect_required_node_ids(
    document: ExecutableDocument,
    target_node_id: str,
    upstream: dict[str, list[str]],
    required: dict[str, None],
) -> None:
    node_ids = {node.id for node in document.nodes}
    if target_node_id not in node_ids:
        raise ValueError(f"Failed to find node with ID {target_node_id}")

    def visit(node_id: str) -> None:
        if node_id in required:
            return
        required[node_id] = None
        for parent_id in upstream.get(node_id, []):
            visit(parent_id)

    visit(target_node_id)
