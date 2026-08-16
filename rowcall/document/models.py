"""Document models for Python-owned Rowcall parsing and planning."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SourceRange:
    start_line: int
    end_line: int
    start_col: int = 1
    end_col: int | None = None
    decorator_line: int | None = None
    body_start_line: int | None = None
    body_end_line: int | None = None
    return_line: int | None = None
    return_end_line: int | None = None
    indent: str | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "startLine": self.start_line,
            "endLine": self.end_line,
            "startCol": self.start_col,
        }
        if self.end_col is not None:
            result["endCol"] = self.end_col
        if self.decorator_line is not None:
            result["decoratorLine"] = self.decorator_line
        if self.body_start_line is not None:
            result["bodyStartLine"] = self.body_start_line
        if self.body_end_line is not None:
            result["bodyEndLine"] = self.body_end_line
        if self.return_line is not None:
            result["returnLine"] = self.return_line
        if self.return_end_line is not None:
            result["returnEndLine"] = self.return_end_line
        if self.indent is not None:
            result["indent"] = self.indent
        return result


@dataclass(frozen=True)
class ValidationIssue:
    kind: str
    message: str
    path: str | None = None
    node_id: str | None = None
    edge_index: int | None = None
    field: str | None = None
    operation_index: int | None = None
    operation_type: str | None = None

    def to_dict(self) -> dict[str, Any]:
        result = {"kind": self.kind, "message": self.message}
        if self.path is not None:
            result["path"] = self.path
        if self.node_id is not None:
            result["nodeId"] = self.node_id
        if self.edge_index is not None:
            result["edgeIndex"] = self.edge_index
        if self.field is not None:
            result["field"] = self.field
        if self.operation_index is not None:
            result["operationIndex"] = self.operation_index
        if self.operation_type is not None:
            result["operationType"] = self.operation_type
        return result


@dataclass(frozen=True)
class DocumentNode:
    id: str
    function_name: str
    outputs: tuple[str, ...]
    parameters: tuple[str, ...]
    source_range: SourceRange
    function_source: str
    display_code: str
    runtime_code: str
    custom_return: bool
    editable: bool

    @property
    def return_names(self) -> tuple[str, ...]:
        """Names returned by the generated node function."""
        return self.outputs

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "functionName": self.function_name,
            "outputs": list(self.outputs),
            "parameters": list(self.parameters),
            "sourceRange": self.source_range.to_dict(),
            "functionSource": self.function_source,
            "code": self.display_code,
            "runtimeCode": self.runtime_code,
            "customReturn": self.custom_return,
            "editable": self.editable,
        }

    def to_app_dict(self, globals_code: str = "") -> dict[str, Any]:
        runtime_code = (
            f"{globals_code}\n\n{self.runtime_code}"
            if globals_code
            else self.runtime_code
        )
        return {
            "id": self.id,
            "functionName": self.function_name,
            "code": self.display_code,
            "runtimeCode": runtime_code,
            "outputs": list(self.outputs),
            "parameters": list(self.parameters),
            "customReturn": self.custom_return,
            "editable": self.editable,
            "sourceRange": self.source_range.to_dict(),
        }


@dataclass(frozen=True)
class DocumentEdge:
    from_node: str
    from_output: str
    to_node: str
    to_input: str
    source_range: SourceRange | None = None

    def to_dict(self) -> dict[str, Any]:
        result = {
            "fromNode": self.from_node,
            "fromOutput": self.from_output,
            "toNode": self.to_node,
            "toInput": self.to_input,
        }
        if self.source_range is not None:
            result["sourceRange"] = self.source_range.to_dict()
        return result


@dataclass(frozen=True)
class ExecutableDocument:
    path: Path
    source: str
    revision: str
    globals_code: str
    nodes: tuple[DocumentNode, ...]
    edges: tuple[DocumentEdge, ...]
    issues: tuple[ValidationIssue, ...] = field(default_factory=tuple)
    version: int = 1

    def to_graph_dict(self) -> dict[str, Any]:
        return {
            "nodes": [
                {
                    "id": node.id,
                    "code": node.display_code,
                    "outputs": list(node.outputs),
                }
                for node in self.nodes
            ],
            "edges": [
                {
                    "fromNode": edge.from_node,
                    "fromOutput": edge.from_output,
                    "toNode": edge.to_node,
                    "toInput": edge.to_input,
                }
                for edge in self.edges
            ],
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "path": str(self.path),
            "revision": self.revision,
            "globalsCode": self.globals_code,
            "nodes": [node.to_dict() for node in self.nodes],
            "edges": [edge.to_dict() for edge in self.edges],
            "issues": [issue.to_dict() for issue in self.issues],
        }

    def to_app_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "revision": self.revision,
            "globalsCode": self.globals_code,
            "nodes": [node.to_app_dict(self.globals_code) for node in self.nodes],
            "edges": [
                {
                    "fromNode": edge.from_node,
                    "fromOutput": edge.from_output,
                    "toNode": edge.to_node,
                    "toInput": edge.to_input,
                }
                for edge in self.edges
            ],
            "readOnly": False,
        }


@dataclass(frozen=True)
class ParseResult:
    ok: bool
    document: ExecutableDocument | None
    issues: tuple[ValidationIssue, ...]

    def to_dict(self) -> dict[str, Any]:
        if self.ok:
            return {"ok": True, "document": self.document.to_dict() if self.document else None, "issues": []}
        return {"ok": False, "document": self.document.to_dict() if self.document else None, "issues": [issue.to_dict() for issue in self.issues]}


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    issues: tuple[ValidationIssue, ...]


@dataclass(frozen=True)
class RunPlanStep:
    node_id: str
    depends_on: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {"nodeId": self.node_id, "dependsOn": list(self.depends_on)}


@dataclass(frozen=True)
class RunPlan:
    target_node_ids: tuple[str, ...]
    steps: tuple[RunPlanStep, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "targetNodeIds": list(self.target_node_ids),
            "steps": [step.to_dict() for step in self.steps],
        }
