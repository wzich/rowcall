"""NDJSON worker protocol for long-lived Nodebook runtime sessions."""

from __future__ import annotations

import json
import sys
from collections.abc import Iterable
from typing import Any, TextIO

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
            events, should_shutdown = handle_request(request, runtime_session)
        except Exception as exc:
            request_id = request.get("id") if isinstance(request, dict) else None
            events = [_error_event(request_id, "worker_error", str(exc))]
            should_shutdown = False

        for event in events:
            _write_event(output_stream, event)

        if should_shutdown:
            return 0

    return 0


def handle_request(request: Any, session: RuntimeSession) -> tuple[list[dict[str, Any]], bool]:
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
        "validate_source",
        "inspect_source",
        "plan_run",
        "run_graph",
        "run_to_node",
        "clear_session_cache",
    }:
        return [_error_event(request_id, "unknown_operation", f"Unknown operation: {operation}")], False

    if operation == "clear_session_cache":
        return [_event("session_cache_cleared", request_id, session.clear_session_cache())], False

    source_error = _require_text(payload, "source")
    path_error = _require_text(payload, "documentPath")
    if source_error or path_error:
        return [_error_event(request_id, "invalid_request", source_error or path_error or "")], False

    source = payload["source"]
    document_path = payload["documentPath"]

    if operation == "validate_source":
        return [_event("validate_source_completed", request_id, session.validate_source(source, document_path))], False

    if operation == "inspect_source":
        return [_event("inspect_source_completed", request_id, session.inspect_source(source, document_path))], False

    if operation == "plan_run":
        target = payload.get("target")
        if target is not None and not isinstance(target, str):
            return [_error_event(request_id, "invalid_request", "Request field 'target' must be a string")], False
        return [_event("plan_run_completed", request_id, session.plan_run(source, document_path, target=target))], False

    if operation == "run_graph":
        return _run_events(request_id, "run_graph", source, document_path, None, payload, session), False

    if operation == "run_to_node":
        target = payload.get("target")
        if not isinstance(target, str) or not target:
            return [_error_event(request_id, "invalid_request", "Request field 'target' must be a non-empty string")], False
        return _run_events(request_id, "run_to_node", source, document_path, target, payload, session), False

    raise AssertionError(f"Unhandled operation: {operation}")


def _run_events(
    request_id: Any,
    run_type: str,
    source: str,
    document_path: str,
    target: str | None,
    payload: dict[str, Any],
    session: RuntimeSession,
) -> list[dict[str, Any]]:
    trace = bool(payload.get("trace", False))
    plan_result = session.plan_run(source, document_path, target=target)
    run_result = (
        session.run_to_node(source, document_path, target, trace=trace)
        if target is not None
        else session.run_graph(source, document_path, trace=trace)
    )
    final_type = "run_completed" if run_result.get("ok") else "run_failed"
    return [
        _event("run_started", request_id, {"runType": run_type, "target": target}),
        _event("run_plan", request_id, plan_result),
        _event(final_type, request_id, {"ok": bool(run_result.get("ok")), "response": run_result}),
    ]


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
    return _event("error", request_id, {"ok": False, "error": {"kind": kind, "message": message}})


def _write_event(output_stream: TextIO, event: dict[str, Any]) -> None:
    output_stream.write(json.dumps(event, separators=(",", ":"), sort_keys=True) + "\n")
    output_stream.flush()


def main(argv: Iterable[str] | None = None) -> int:
    del argv
    return run_worker()


if __name__ == "__main__":
    raise SystemExit(main())
