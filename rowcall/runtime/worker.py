"""NDJSON worker protocol for long-lived Rowcall runtime sessions."""

from __future__ import annotations

import json
import sys
from collections.abc import Callable, Iterable
from typing import Any, TextIO

from .executor import bound_diagnostic_text
from .session import PROTOCOL_VERSION, RuntimeSession


def run_worker(
    input_stream: TextIO | None = None,
    output_stream: TextIO | None = None,
    *,
    session: RuntimeSession | None = None,
) -> int:
    """Run the worker loop until EOF or a shutdown request is received."""

    input_stream = sys.stdin if input_stream is None else input_stream
    output_stream = sys.stdout if output_stream is None else output_stream
    runtime_session = RuntimeSession() if session is None else session

    for raw_line in input_stream:
        line = raw_line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            _write_event(output_stream, _error_event(None, "malformed_json", str(exc)))
            continue

        try:
            events, should_shutdown = handle_request(
                request,
                runtime_session,
                emit_event=lambda event: _write_event(output_stream, event),
            )
        except Exception as exc:
            request_id = request.get("id") if isinstance(request, dict) else None
            events = [_error_event(request_id, "worker_error", str(exc))]
            should_shutdown = False

        for event in events:
            _write_event(output_stream, event)

        if should_shutdown:
            return 0

    return 0


def handle_request(
    request: Any,
    session: RuntimeSession,
    emit_event: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    if not isinstance(request, dict):
        return [_error_event(None, "invalid_request", "Worker requests must be JSON objects")], False

    request_id = request.get("id")
    operation = request.get("operation")
    payload = request.get("payload", {})
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        return [_error_event(request_id, "invalid_request", "Request payload must be an object")], False

    if operation == "shutdown":
        return [_event("shutdown", request_id, {"ok": True})], True

    if operation not in {
        "inspect_source",
        "apply_operations",
        "run_graph",
        "run_to_node",
        "query_table",
    }:
        return [_error_event(request_id, "unknown_operation", f"Unknown operation: {operation}")], False

    if operation == "query_table":
        for field in ("runId", "documentRevision", "nodeId", "outputName"):
            field_error = _require_text(payload, field)
            if field_error:
                return [_error_event(request_id, "invalid_request", field_error)], False
        offset = payload.get("offset")
        if type(offset) is not int or offset < 0:
            return [
                _error_event(
                    request_id,
                    "invalid_request",
                    "Request field 'offset' must be a non-negative integer",
                )
            ], False
        sort = payload.get("sort")
        if sort is not None and not isinstance(sort, dict):
            return [
                _error_event(request_id, "invalid_request", "Request field 'sort' must be an object")
            ], False
        return [
            _event(
                "table_query_completed",
                request_id,
                session.query_table(
                    run_id=payload["runId"],
                    document_revision=payload["documentRevision"],
                    node_id=payload["nodeId"],
                    output_name=payload["outputName"],
                    offset=offset,
                    sort=sort,
                ),
            )
        ], False

    path_error = _require_text(payload, "documentPath")
    if path_error:
        return [_error_event(request_id, "invalid_request", path_error)], False

    document_path = payload["documentPath"]

    source_error = _require_text(payload, "source")
    if source_error:
        return [_error_event(request_id, "invalid_request", source_error)], False

    source = payload["source"]

    if operation == "inspect_source":
        return [_event("inspect_source_completed", request_id, session.inspect_source(source, document_path))], False

    if operation == "apply_operations":
        operations = payload.get("operations")
        if not isinstance(operations, list):
            return [_error_event(request_id, "invalid_request", "Request field 'operations' must be a list")], False
        if not all(isinstance(item, dict) for item in operations):
            return [_error_event(request_id, "invalid_request", "Request field 'operations' must contain objects")], False
        sidecar_metadata = payload.get("sidecarMetadata")
        if sidecar_metadata is not None and not isinstance(sidecar_metadata, dict):
            return [_error_event(request_id, "invalid_request", "Request field 'sidecarMetadata' must be an object")], False
        return [
            _event(
                "apply_operations_completed",
                request_id,
                session.apply_operations(source, document_path, operations, sidecar_metadata=sidecar_metadata),
            )
        ], False

    if operation == "run_graph":
        return _run_events(request_id, "run_graph", source, document_path, None, payload, session, emit_event), False

    if operation == "run_to_node":
        target = payload.get("target")
        if not isinstance(target, str) or not target:
            return [_error_event(request_id, "invalid_request", "Request field 'target' must be a non-empty string")], False
        return _run_events(request_id, "run_to_node", source, document_path, target, payload, session, emit_event), False

    raise AssertionError(f"Unhandled operation: {operation}")


def _run_events(
    request_id: Any,
    run_type: str,
    source: str,
    document_path: str,
    target: str | None,
    payload: dict[str, Any],
    session: RuntimeSession,
    emit_event: Callable[[dict[str, Any]], None] | None = None,
) -> list[dict[str, Any]]:
    trace = bool(payload.get("trace", False))
    inputs = payload.get("inputs", {})
    if not isinstance(inputs, dict):
        return [_error_event(request_id, "invalid_request", "Request field 'inputs' must be an object")]
    run_id = payload.get("runId")
    if run_id is not None and (not isinstance(run_id, str) or not run_id):
        return [_error_event(request_id, "invalid_request", "Request field 'runId' must be a non-empty string")]

    plan_result = session.plan_run(source, document_path, target=target)

    events: list[dict[str, Any]] = []

    def append_or_emit(event: dict[str, Any]) -> None:
        if emit_event is None:
            events.append(event)
            return
        emit_event(event)

    append_or_emit(_event("run_started", request_id, {"runType": run_type, "target": target}))
    append_or_emit(_event("run_plan", request_id, plan_result))

    def append_node_event(event: dict[str, Any]) -> None:
        append_or_emit(
            _event(event["type"], request_id, {key: value for key, value in event.items() if key != "type"})
        )

    run_options = {
        "trace": trace,
        "inputs": inputs,
        "on_node_event": append_node_event,
        **({"run_id": run_id} if run_id is not None else {}),
    }

    if target is not None:
        run_result = session.run_to_node(
            source,
            document_path,
            target,
            **run_options,
        )
    else:
        run_result = session.run_graph(
            source,
            document_path,
            **run_options,
        )

    final_type = "run_completed" if run_result.get("ok") else "run_failed"
    append_or_emit(
        _event(final_type, request_id, {"ok": bool(run_result.get("ok")), "response": run_result})
    )
    return events


def _require_text(payload: dict[str, Any], field: str) -> str | None:
    value = payload.get(field)
    if not isinstance(value, str):
        return f"Request field '{field}' must be a string"
    return None


def _event(event_type: str, request_id: Any, payload: dict[str, Any]) -> dict[str, Any]:
    event: dict[str, Any] = {"protocolVersion": PROTOCOL_VERSION, "type": event_type}
    if request_id is not None:
        event["id"] = request_id
    event.update(payload)
    return event


def _error_event(request_id: Any, kind: str, message: str) -> dict[str, Any]:
    return _event(
        "error",
        request_id,
        {"ok": False, "error": {"kind": kind, "message": bound_diagnostic_text(message)}},
    )


def _write_event(output_stream: TextIO, event: dict[str, Any]) -> None:
    output_stream.write(json.dumps(event, separators=(",", ":"), sort_keys=True) + "\n")
    output_stream.flush()


def main(argv: Iterable[str] | None = None) -> int:
    del argv
    return run_worker()


if __name__ == "__main__":
    raise SystemExit(main())
