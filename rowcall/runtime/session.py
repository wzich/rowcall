"""Long-lived runtime session facade for Rowcall worker operations."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rowcall.document import ParseResult, apply_document_operations, load_document, parse_source

from .executor import NodeEventCallback, build_plan, execute_source
from .previews import query_table_preview, run_with_captured_stdio


PROTOCOL_VERSION = 1


@dataclass(frozen=True)
class LatestResultStore:
    run_id: str
    document_revision: str
    outputs_by_node: dict[str, dict[str, Any]]


class RuntimeSession:
    """Stateful runtime boundary used by the NDJSON worker.

    Execution is always fresh. The only retained state is the latest successful
    UI run's routed outputs for bounded, provenance-checked inspection.
    """

    def __init__(self) -> None:
        self._latest_result_store: LatestResultStore | None = None

    def load_document(self, document_path: str | Path) -> dict[str, Any]:
        resolved_path = self._resolve_document_path(document_path)
        try:
            parse_result = load_document(resolved_path)
        except OSError as exc:
            return self._document_error_result(resolved_path, str(exc))
        return self._app_document_result(parse_result, resolved_path)

    def validate_source(self, source: str, document_path: str | Path) -> dict[str, Any]:
        parse_result = parse_source(source, self._resolve_document_path(document_path))
        return {
            "ok": parse_result.ok,
            "issues": [issue.to_dict() for issue in parse_result.issues],
            "documentPath": str(self._resolve_document_path(document_path)),
            "revision": parse_result.document.revision if parse_result.document is not None else None,
        }

    def inspect_source(self, source: str, document_path: str | Path) -> dict[str, Any]:
        resolved_path = self._resolve_document_path(document_path)
        parse_result = parse_source(source, resolved_path)
        return self._app_document_result(parse_result, resolved_path)

    def render_source(self, source: str, document_path: str | Path) -> dict[str, Any]:
        resolved_path = self._resolve_document_path(document_path)
        parse_result = parse_source(source, resolved_path)
        result = self._app_document_result(parse_result, resolved_path)
        if result["ok"]:
            result["source"] = source
        return result

    def validate_candidate_source(self, source: str, document_path: str | Path) -> dict[str, Any]:
        resolved_path = self._resolve_document_path(document_path)
        parse_result = parse_source(source, resolved_path)
        return self._app_document_result(parse_result, resolved_path)

    def apply_operations(
        self,
        source: str,
        document_path: str | Path,
        operations: list[dict[str, Any]],
        sidecar_metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        resolved_path = self._resolve_document_path(document_path)
        result = apply_document_operations(source, resolved_path, operations, sidecar_metadata=sidecar_metadata)
        if not result.ok or result.source is None or result.parse_result.document is None:
            return {
                "ok": False,
                "documentPath": str(resolved_path),
                "issues": [issue.to_dict() for issue in result.issues],
            }
        return {
            "ok": True,
            "documentPath": str(result.parse_result.document.path),
            "source": result.source,
            "document": result.parse_result.document.to_app_dict(),
            "sidecarMetadata": result.sidecar_metadata or {},
            "issues": [],
        }

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
        inputs: dict[str, Any] | None = None,
        on_node_event: NodeEventCallback | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        return self._execute_and_publish(
            source,
            document_path,
            trace=trace,
            inputs=inputs,
            on_node_event=on_node_event,
            run_id=run_id,
        )

    def run_to_node(
        self,
        source: str,
        document_path: str | Path,
        target: str,
        *,
        trace: bool = False,
        inputs: dict[str, Any] | None = None,
        on_node_event: NodeEventCallback | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        return self._execute_and_publish(
            source,
            document_path,
            target=target,
            trace=trace,
            inputs=inputs,
            on_node_event=on_node_event,
            run_id=run_id,
        )

    def run_node(
        self,
        source: str,
        document_path: str | Path,
        target: str,
        *,
        trace: bool = False,
        inputs: dict[str, Any] | None = None,
        on_node_event: NodeEventCallback | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        return self._execute_and_publish(
            source,
            document_path,
            target=target,
            trace=trace,
            run_type="run_node",
            inputs=inputs,
            on_node_event=on_node_event,
            run_id=run_id,
        )

    def query_table(
        self,
        *,
        run_id: str,
        document_revision: str,
        node_id: str,
        output_name: str,
        offset: int,
        sort: dict[str, Any] | None,
    ) -> dict[str, Any]:
        store = self._latest_result_store
        if (
            store is None
            or store.run_id != run_id
            or store.document_revision != document_revision
        ):
            return self._table_query_error(
                "stale_result",
                "These interactive results are no longer available. Run again to refresh them.",
            )
        node_outputs = store.outputs_by_node.get(node_id)
        if node_outputs is None or output_name not in node_outputs:
            return self._table_query_error(
                "missing_output",
                "The selected output was not produced by the latest successful run.",
            )
        try:
            (table, resolved_offset), _, _ = run_with_captured_stdio(
                lambda: query_table_preview(
                    node_outputs[output_name],
                    offset=offset,
                    sort=sort,
                )
            )
        except ValueError as exc:
            return self._table_query_error("invalid_table_query", str(exc))
        except Exception as exc:
            return self._table_query_error("table_query_failed", str(exc))
        if table is None:
            return self._table_query_error(
                "unsupported_output",
                "Interactive tables currently support Pandas and Polars DataFrames and Series.",
            )
        return {
            "ok": True,
            "runId": run_id,
            "documentRevision": document_revision,
            "nodeId": node_id,
            "outputName": output_name,
            "offset": resolved_offset,
            "sort": sort,
            "table": table,
        }

    def _execute_and_publish(
        self,
        source: str,
        document_path: str | Path,
        *,
        target: str | None = None,
        trace: bool = False,
        run_type: str | None = None,
        inputs: dict[str, Any] | None = None,
        on_node_event: NodeEventCallback | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        result = execute_source(
            source,
            self._resolve_document_path(document_path),
            target=target,
            trace=trace,
            run_type=run_type,
            root_inputs=inputs,
            on_node_event=on_node_event,
            capture_raw_outputs=run_id is not None,
        )
        raw_outputs = result.pop("_rawOutputsByNode", None)
        document_revision = result.get("documentRevision")
        if (
            result.get("ok")
            and run_id is not None
            and isinstance(document_revision, str)
            and isinstance(raw_outputs, dict)
        ):
            self._latest_result_store = LatestResultStore(
                run_id=run_id,
                document_revision=document_revision,
                outputs_by_node=raw_outputs,
            )
            result["resultStore"] = {
                "runId": run_id,
                "documentRevision": document_revision,
            }
        return result

    @staticmethod
    def _table_query_error(kind: str, message: str) -> dict[str, Any]:
        return {"ok": False, "error": {"kind": kind, "message": message}}

    def clear_session_cache(self) -> dict[str, Any]:
        """Compatibility response; result inspection is not computation caching."""
        return {"ok": True, "clearedEntries": 0, "cachingDisabled": True}

    def _resolve_document_path(self, document_path: str | Path) -> Path:
        return Path(document_path).expanduser().resolve()

    def _app_document_result(self, parse_result: ParseResult, document_path: Path) -> dict[str, Any]:
        if parse_result.ok and parse_result.document is not None:
            return {
                "ok": True,
                "documentPath": str(parse_result.document.path),
                "document": parse_result.document.to_app_dict(),
                "issues": [],
            }
        return {
            "ok": False,
            "documentPath": str(document_path),
            "issues": [issue.to_dict() for issue in parse_result.issues],
        }

    def _document_error_result(self, document_path: Path, message: str) -> dict[str, Any]:
        return {
            "ok": False,
            "documentPath": str(document_path),
            "issues": [{"kind": "invalid_python", "message": message}],
        }
