"""Long-lived runtime session facade for Nodebook worker operations."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from nodebook.document import parse_source

from .executor import build_plan, run_source


PROTOCOL_VERSION = 1


@dataclass
class RuntimeSession:
    """Stateful runtime boundary used by the NDJSON worker.

    Execution remains stateless for now, but this class owns the place where
    future cache and session-scoped runtime behavior can be added without
    changing the worker protocol.
    """

    cache: dict[str, Any] = field(default_factory=dict)

    def validate_source(self, source: str, document_path: str | Path) -> dict[str, Any]:
        parse_result = parse_source(source, self._resolve_document_path(document_path))
        return {
            "ok": parse_result.ok,
            "issues": [issue.to_dict() for issue in parse_result.issues],
            "documentPath": str(self._resolve_document_path(document_path)),
            "revision": parse_result.document.revision if parse_result.document is not None else None,
        }

    def inspect_source(self, source: str, document_path: str | Path) -> dict[str, Any]:
        parse_result = parse_source(source, self._resolve_document_path(document_path))
        return parse_result.to_dict()

    def plan_run(
        self,
        source: str,
        document_path: str | Path,
        target: str | None = None,
    ) -> dict[str, Any]:
        parse_result = parse_source(source, self._resolve_document_path(document_path))
        if not parse_result.ok or parse_result.document is None:
            return {
                "ok": False,
                "documentPath": str(self._resolve_document_path(document_path)),
                "issues": [issue.to_dict() for issue in parse_result.issues],
                "error": {
                    "kind": "validation_error",
                    "message": "Document validation failed",
                },
            }

        try:
            plan, target_node_id = build_plan(parse_result.document, target)
        except ValueError as exc:
            return {
                "ok": False,
                "documentPath": str(parse_result.document.path),
                "issues": [],
                "error": {"kind": "planning_error", "message": str(exc)},
            }

        return {
            "ok": True,
            "documentPath": str(parse_result.document.path),
            "targetNodeId": target_node_id,
            "plan": plan.to_dict(),
            "issues": [],
        }

    def run_graph(
        self,
        source: str,
        document_path: str | Path,
        *,
        trace: bool = False,
    ) -> dict[str, Any]:
        return run_source(source, self._resolve_document_path(document_path), trace=trace)

    def run_to_node(
        self,
        source: str,
        document_path: str | Path,
        target: str,
        *,
        trace: bool = False,
    ) -> dict[str, Any]:
        return run_source(source, self._resolve_document_path(document_path), target=target, trace=trace)

    def clear_session_cache(self) -> dict[str, Any]:
        cleared_entries = len(self.cache)
        self.cache.clear()
        return {"ok": True, "clearedEntries": cleared_entries}

    def _resolve_document_path(self, document_path: str | Path) -> Path:
        return Path(document_path).expanduser().resolve()
