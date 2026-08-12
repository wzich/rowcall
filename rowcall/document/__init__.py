"""Python-owned document parsing, validation, and planning APIs."""

from __future__ import annotations

from .models import (
    DocumentEdge,
    DocumentNode,
    ExecutableDocument,
    ParseResult,
    RunPlan,
    RunPlanStep,
    SourceRange,
    ValidationIssue,
    ValidationResult,
)
from .parser import load_document, parse_source
from .planning import build_full_graph_plan, build_run_plan, build_run_plan_for_targets
from .rewrite import (
    OperationRewriteResult,
    RewriteResult,
    add_edge,
    apply_document_operations,
    remove_edge,
    update_node_body,
    update_node_outputs,
    update_node_views,
)
from .validation import (
    build_downstream_adjacency,
    build_upstream_adjacency,
    collect_required_node_ids,
    get_sink_node_ids,
    validate_document,
)

__all__ = [
    "DocumentEdge",
    "DocumentNode",
    "ExecutableDocument",
    "ParseResult",
    "OperationRewriteResult",
    "RunPlan",
    "RunPlanStep",
    "RewriteResult",
    "SourceRange",
    "ValidationIssue",
    "ValidationResult",
    "add_edge",
    "apply_document_operations",
    "build_downstream_adjacency",
    "build_full_graph_plan",
    "build_run_plan",
    "build_run_plan_for_targets",
    "build_upstream_adjacency",
    "collect_required_node_ids",
    "get_sink_node_ids",
    "load_document",
    "parse_source",
    "remove_edge",
    "update_node_body",
    "update_node_outputs",
    "update_node_views",
    "validate_document",
]
