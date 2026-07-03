"""Stateless Python runtime executor for Nodebook documents."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import sys
import traceback
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from nodebook.document import (
    DocumentNode,
    ExecutableDocument,
    RunPlan,
    build_full_graph_plan,
    build_run_plan,
    parse_source,
)

from .previews import copy_for_node_input, install_default_copy_handlers, preview_value


NodeEventCallback = Callable[[dict[str, Any]], None]


@dataclass(frozen=True)
class RunRequest:
    source: str
    document_path: Path
    target: str | None = None
    trace: bool = False


def run_document(path: str | Path, target: str | None = None, trace: bool = False) -> dict[str, Any]:
    document_path = Path(path).expanduser().resolve()
    return run_source(document_path.read_text(), document_path, target=target, trace=trace)


def run_source(
    source: str,
    document_path: str | Path,
    target: str | None = None,
    trace: bool = False,
) -> dict[str, Any]:
    return execute_source(source, document_path, target=target, trace=trace)


def execute_source(
    source: str,
    document_path: str | Path,
    target: str | None = None,
    trace: bool = False,
    *,
    run_type: str | None = None,
    cache: dict[str, Any] | None = None,
    cache_mode: str = "refresh",
    root_inputs: dict[str, Any] | None = None,
    on_node_event: NodeEventCallback | None = None,
) -> dict[str, Any]:
    path = Path(document_path).expanduser().resolve()
    response_run_type = run_type or ("run_to_node" if target else "run_graph")
    install_default_copy_handlers()

    with document_execution_context(path):
        parse_result = parse_source(source, path)
        if not parse_result.ok or parse_result.document is None:
            return build_response(
                ok=False,
                run_type=response_run_type,
                target_node_id=target,
                final_node_ids=[],
                executed_node_ids=[],
                results_by_node={},
                trace=[] if trace else None,
                error={
                    "kind": "validation_error",
                    "message": "Document validation failed",
                    "issues": [issue.to_dict() for issue in parse_result.issues],
                },
            )

        document = parse_result.document
        try:
            plan, target_node_id = build_plan(document, target)
        except ValueError as exc:
            return build_response(
                ok=False,
                run_type=response_run_type,
                target_node_id=target,
                final_node_ids=[],
                executed_node_ids=[],
                results_by_node={},
                trace=[] if trace else None,
                error={"kind": "planning_error", "message": str(exc)},
            )

        return execute_plan(
            document,
            plan,
            target_node_id=target_node_id,
            trace_enabled=trace,
            run_type=run_type,
            cache=cache,
            cache_mode=cache_mode,
            root_inputs=root_inputs,
            on_node_event=on_node_event,
        )


def build_plan(document: ExecutableDocument, target: str | None) -> tuple[RunPlan, str | None]:
    if target is None:
        return build_full_graph_plan(document), None

    node_id = resolve_target_node_id(document, target)
    return build_run_plan(document, node_id), node_id


def resolve_target_node_id(document: ExecutableDocument, target: str) -> str:
    if any(node.id == target for node in document.nodes):
        return target

    matches = [node.id for node in document.nodes if node.function_name == target]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise ValueError(f"Target function name {target!r} is ambiguous")
    raise ValueError(f"Failed to find node with ID or function name {target}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def hash_cache_key(parts: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(parts).encode("utf-8")).hexdigest()


def node_signature(node: DocumentNode) -> dict[str, Any]:
    return {
        "id": node.id,
        "code": node.runtime_code,
        "outputs": list(node.outputs),
    }


def expected_cache_keys(
    nodes_by_id: dict[str, DocumentNode],
    plan: RunPlan,
    root_inputs: dict[str, Any],
    globals_code: str,
) -> dict[str, str]:
    keys: dict[str, str] = {}
    globals_key = hash_cache_key({"globalsCode": globals_code})
    input_key = hash_cache_key({"rootInputs": root_inputs})

    for step in plan.steps:
        node_id = step.node_id
        keys[node_id] = hash_cache_key(
            {
                "node": node_signature(nodes_by_id[node_id]),
                "globals": globals_key,
                "rootInputs": input_key if not step.depends_on else None,
                "upstream": [
                    {"nodeId": dependency, "key": keys[dependency]}
                    for dependency in step.depends_on
                ],
            }
        )

    return keys


def validate_cached_upstream(
    cache: dict[str, Any],
    plan: RunPlan,
    target_node_id: str,
    expected_keys: dict[str, str],
) -> str | None:
    target_step = next((step for step in plan.steps if step.node_id == target_node_id), None)
    if target_step is None:
        return f"Target node {target_node_id} is not in the run plan"

    for step in plan.steps:
        node_id = step.node_id
        if node_id == target_node_id:
            break

        cached = cache.get(node_id)
        if cached is None:
            return (
                f"Upstream cache is missing for node {node_id}. "
                "Run to this node first to refresh upstream outputs."
            )
        if cached.get("key") != expected_keys[node_id]:
            return (
                f"Upstream cache is stale for node {node_id}. "
                "Run to this node first to refresh upstream outputs."
            )

    return None


def make_cache_error_response(
    run_type: str,
    target_node_id: str | None,
    final_node_ids: list[str],
    trace: list[dict[str, Any]] | None,
    message: str,
    node_id: str | None = None,
) -> dict[str, Any]:
    return build_response(
        ok=False,
        run_type=run_type,
        target_node_id=target_node_id,
        final_node_ids=final_node_ids,
        executed_node_ids=[],
        results_by_node={},
        trace=trace,
        error={
            "kind": "cache_miss",
            "message": message,
            **({"nodeId": node_id} if node_id else {}),
        },
    )


@contextlib.contextmanager
def document_execution_context(document_path: Path) -> Iterator[None]:
    document_dir = str(document_path.parent)
    previous_cwd = os.getcwd()
    previous_path = list(sys.path)
    os.chdir(document_dir)
    if document_dir not in sys.path:
        sys.path.insert(0, document_dir)
    try:
        yield
    finally:
        os.chdir(previous_cwd)
        sys.path[:] = previous_path


def execute_plan(
    document: ExecutableDocument,
    plan: RunPlan,
    *,
    target_node_id: str | None,
    trace_enabled: bool,
    run_type: str | None = None,
    cache: dict[str, Any] | None = None,
    cache_mode: str = "refresh",
    root_inputs: dict[str, Any] | None = None,
    on_node_event: NodeEventCallback | None = None,
) -> dict[str, Any]:
    response_run_type = run_type or ("run_to_node" if target_node_id else "run_graph")
    nodes_by_id = {node.id: node for node in document.nodes}
    trace: list[dict[str, Any]] | None = [] if trace_enabled else None
    results_by_node: dict[str, dict[str, Any]] = {}
    outputs_by_node: dict[str, dict[str, Any]] = {}
    executed_node_ids: list[str] = []
    root_inputs = {} if root_inputs is None else dict(root_inputs)
    steps_to_execute = plan.steps
    cache_keys: dict[str, str] | None = None

    if cache is not None:
        try:
            cache_keys = expected_cache_keys(nodes_by_id, plan, root_inputs, document.globals_code)
        except (TypeError, ValueError) as exc:
            return make_cache_error_response(
                response_run_type,
                target_node_id,
                list(plan.target_node_ids),
                trace,
                f"Failed to compute runtime cache keys: {exc}",
                target_node_id,
            )

    if cache_mode == "single_node":
        if cache is None:
            return make_cache_error_response(
                response_run_type,
                target_node_id,
                list(plan.target_node_ids),
                trace,
                "Run node requires a runtime session cache",
                target_node_id,
            )
        if target_node_id is None:
            return make_cache_error_response(
                response_run_type,
                target_node_id,
                list(plan.target_node_ids),
                trace,
                "Run node requires a target node",
            )
        assert cache_keys is not None
        cache_error = validate_cached_upstream(cache, plan, target_node_id, cache_keys)
        if cache_error:
            return make_cache_error_response(
                response_run_type,
                target_node_id,
                list(plan.target_node_ids),
                trace,
                cache_error,
                target_node_id,
            )
        steps_to_execute = tuple(step for step in plan.steps if step.node_id == target_node_id)

    globals_result = build_document_globals(document)
    if not globals_result["ok"]:
        error = {
            **globals_result["errorDetails"],
            "stdout": globals_result["stdout"],
            "stderr": globals_result["stderr"],
            "error": globals_result["error"],
        }
        return build_response(
            ok=False,
            run_type=response_run_type,
            target_node_id=target_node_id,
            final_node_ids=list(plan.target_node_ids),
            executed_node_ids=[],
            results_by_node={},
            trace=trace,
            error=error,
        )
    globals_scope = globals_result["scope"]

    for index, step in enumerate(steps_to_execute):
        node_id = step.node_id
        node = nodes_by_id[node_id]
        if on_node_event is not None:
            on_node_event(
                {
                    "type": "node_started",
                    "index": index,
                    "nodeId": node_id,
                    "dependsOn": list(step.depends_on),
                }
            )
        if cache_mode == "single_node" and cache is not None:
            inputs, input_warnings = build_cached_inputs_for_step(step.depends_on, cache, root_inputs)
        else:
            inputs, input_warnings = build_inputs_for_step(step.depends_on, outputs_by_node, root_inputs)
        result = execute_node(node, globals_scope, inputs, input_warnings, str(document.path))
        results_by_node[node_id] = result
        executed_node_ids.append(node_id)

        if result["ok"]:
            raw_outputs = result["_rawOutputs"]
            outputs_by_node[node_id] = raw_outputs
            del result["_rawOutputs"]
            if cache is not None and cache_keys is not None:
                cache[node_id] = {"key": cache_keys[node_id], "outputs": raw_outputs}
            append_trace(
                trace,
                index=index,
                node_id=node_id,
                depends_on=step.depends_on,
                inputs=inputs,
                result=result,
            )
            if on_node_event is not None:
                on_node_event(
                    {
                        "type": "node_completed",
                        "index": index,
                        "nodeId": node_id,
                        "dependsOn": list(step.depends_on),
                        "result": result,
                    }
                )
            continue

        append_trace(
            trace,
            index=index,
            node_id=node_id,
            depends_on=step.depends_on,
            inputs=inputs,
            result=result,
        )
        if on_node_event is not None:
            on_node_event(
                {
                    "type": "node_failed",
                    "index": index,
                    "nodeId": node_id,
                    "dependsOn": list(step.depends_on),
                    "result": result,
                }
            )
        error_details = result.get("errorDetails")
        error = {
            **(
                error_details
                if isinstance(error_details, dict)
                else {
                    "kind": "runtime_error",
                    "phase": "node_execution",
                    "message": f"Failed execution at node {node_id}",
                    "nodeId": node_id,
                    "pythonExecutable": sys.executable,
                }
            ),
            "stdout": result.get("stdout", ""),
            "stderr": result.get("stderr", ""),
            "error": result.get("error"),
        }
        return build_response(
            ok=False,
            run_type=response_run_type,
            target_node_id=target_node_id,
            final_node_ids=list(plan.target_node_ids),
            executed_node_ids=executed_node_ids,
            results_by_node=results_by_node,
            trace=trace,
            error=error,
        )

    return build_response(
        ok=True,
        run_type=response_run_type,
        target_node_id=target_node_id,
        final_node_ids=list(plan.target_node_ids),
        executed_node_ids=executed_node_ids,
        results_by_node=results_by_node,
        trace=trace,
        error=None,
    )


def build_document_globals(document: ExecutableDocument) -> dict[str, Any]:
    scope: dict[str, Any] = {"__file__": str(document.path)}
    if not document.globals_code:
        return {"ok": True, "scope": scope}

    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout_buffer):
            with contextlib.redirect_stderr(stderr_buffer):
                code = compile(document.globals_code, str(document.path), "exec")
                exec(code, scope, scope)
    except Exception as exc:
        error_details = classify_exception(exc, phase="document_globals")
        return {
            "ok": False,
            "scope": scope,
            "error": str(exc),
            "errorDetails": error_details,
            "stdout": stdout_buffer.getvalue(),
            "stderr": stderr_buffer.getvalue() + traceback.format_exc(),
        }

    return {
        "ok": True,
        "scope": scope,
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
        "error": None,
    }


def build_inputs_for_step(
    depends_on: tuple[str, ...],
    outputs_by_node: dict[str, dict[str, Any]],
    root_inputs: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    if not depends_on:
        raw_inputs = dict(root_inputs or {})
    else:
        raw_inputs = {}
        for dependency in depends_on:
            raw_inputs.update(outputs_by_node[dependency])

    scoped_inputs: dict[str, Any] = {}
    warnings: list[str] = []
    for name, value in raw_inputs.items():
        copied, warning = copy_for_node_input(name, value)
        scoped_inputs[name] = copied
        if warning:
            warnings.append(warning)

    return scoped_inputs, warnings


def build_cached_inputs_for_step(
    depends_on: tuple[str, ...],
    cache: dict[str, Any],
    root_inputs: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    if not depends_on:
        raw_inputs = dict(root_inputs)
    else:
        raw_inputs: dict[str, Any] = {}
        for dependency in depends_on:
            raw_inputs.update(cache[dependency]["outputs"])

    scoped_inputs: dict[str, Any] = {}
    warnings: list[str] = []
    for name, value in raw_inputs.items():
        copied, warning = copy_for_node_input(name, value)
        scoped_inputs[name] = copied
        if warning:
            warnings.append(warning)

    return scoped_inputs, warnings


def execute_node(
    node: DocumentNode,
    globals_scope: dict[str, Any],
    inputs: dict[str, Any],
    input_warnings: list[str],
    filename: str,
) -> dict[str, Any]:
    scope: dict[str, Any] = dict(globals_scope)
    scope.update(inputs)
    scope["__file__"] = filename
    output_events: list[dict[str, Any]] = []
    stdout_buffer = CapturedStdout(output_events)
    stderr_buffer = io.StringIO()
    displays: list[dict[str, Any]] = []
    scope["display"] = make_display_collector(displays, output_events)
    result_warnings = list(input_warnings)

    try:
        with active_nodebook_display(scope["display"]):
            with contextlib.redirect_stdout(stdout_buffer):
                with contextlib.redirect_stderr(stderr_buffer):
                    code = compile(node.runtime_code, filename, "exec")
                    exec(code, scope, scope)
    except Exception as exc:
        stderr_text = stderr_buffer.getvalue() + traceback.format_exc()
        error_details = classify_exception(exc, phase="node_execution", node_id=node.id)
        result = make_error_result(
            str(exc),
            stdout_buffer.getvalue(),
            stderr_text,
            error_details=error_details,
        )
        result["displays"] = displays
        result["outputEvents"] = output_events
        result["warnings"] = result_warnings
        return result

    node_outputs: dict[str, Any] = {}
    output_previews: dict[str, Any] = {}
    for name in node.outputs:
        if name not in scope:
            result = make_error_result(
                f"Declared output '{name}' was not defined by node code",
                stdout_buffer.getvalue(),
                stderr_buffer.getvalue(),
            )
            result["displays"] = displays
            result["outputEvents"] = output_events
            result["warnings"] = result_warnings
            return result

        node_outputs[name] = scope[name]
        output_previews[name] = preview_value(name, scope[name])

    return {
        "ok": True,
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
        "outputs": output_previews,
        "displays": displays,
        "outputEvents": output_events,
        "warnings": result_warnings,
        "_rawOutputs": node_outputs,
    }


def make_error_result(
    message: str,
    stdout: str = "",
    stderr: str = "",
    *,
    error_details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "ok": False,
        "stdout": stdout,
        "stderr": stderr,
        "outputs": {},
        "displays": [],
        "outputEvents": [],
        "warnings": [],
        "error": message,
    }
    if error_details is not None:
        result["errorDetails"] = error_details
    return result


def classify_exception(
    exc: Exception,
    *,
    phase: str,
    node_id: str | None = None,
) -> dict[str, Any]:
    missing_module = exc.name if isinstance(exc, ModuleNotFoundError) else None
    if missing_module:
        if phase == "document_globals":
            message = f"Missing Python package while loading document globals: {missing_module}"
        elif node_id:
            message = f"Missing Python package while running node {node_id}: {missing_module}"
        else:
            message = f"Missing Python package while running document: {missing_module}"
        details: dict[str, Any] = {
            "kind": "missing_module",
            "phase": phase,
            "message": message,
            "missingModule": missing_module,
            "pythonExecutable": sys.executable,
        }
    else:
        message = "Failed execution in document globals" if phase == "document_globals" else (
            f"Failed execution at node {node_id}" if node_id else "Failed execution"
        )
        details = {
            "kind": "runtime_error",
            "phase": phase,
            "message": message,
            "pythonExecutable": sys.executable,
        }
    if node_id is not None:
        details["nodeId"] = node_id
    return details


def append_stdout_event(output_events: list[dict[str, Any]], text: str) -> None:
    if not text:
        return
    if output_events and output_events[-1]["kind"] == "stdout":
        output_events[-1]["text"] += text
    else:
        output_events.append({"kind": "stdout", "text": text})


class CapturedStdout(io.StringIO):
    def __init__(self, output_events: list[dict[str, Any]]) -> None:
        super().__init__()
        self.output_events = output_events

    def write(self, text: str) -> int:
        append_stdout_event(self.output_events, text)
        return super().write(text)


def make_display_collector(
    displays: list[dict[str, Any]],
    output_events: list[dict[str, Any]],
) -> Callable[[Any], None]:
    def display(value: Any) -> None:
        display_preview = {"value": preview_value("display", value)}
        displays.append(display_preview)
        output_events.append({"kind": "display", "value": display_preview["value"]})

    return display


@contextlib.contextmanager
def active_nodebook_display(display: Callable[[Any], None]) -> Iterator[None]:
    try:
        import nodebook
    except ImportError:
        yield
        return

    previous_display = getattr(nodebook, "display", None)
    nodebook.display = display
    try:
        yield
    finally:
        if previous_display is None:
            delattr(nodebook, "display")
        else:
            nodebook.display = previous_display


def append_trace(
    trace: list[dict[str, Any]] | None,
    *,
    index: int,
    node_id: str,
    depends_on: tuple[str, ...],
    inputs: dict[str, Any],
    result: dict[str, Any],
) -> None:
    if trace is None:
        return
    trace.append(
        {
            "index": index,
            "nodeId": node_id,
            "dependsOn": list(depends_on),
            "inputs": {name: preview_value(name, value) for name, value in inputs.items()},
            "ok": result["ok"],
            "stdout": result["stdout"],
            "stderr": result["stderr"],
            "outputs": result["outputs"],
            "displays": result["displays"],
            "outputEvents": result["outputEvents"],
            "warnings": result["warnings"],
            "error": result.get("error"),
        }
    )


def build_response(
    ok: bool,
    run_type: str,
    target_node_id: str | None,
    final_node_ids: list[str],
    executed_node_ids: list[str],
    results_by_node: dict[str, dict[str, Any]],
    trace: list[dict[str, Any]] | None,
    error: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "runType": run_type,
        **({"targetNodeId": target_node_id} if target_node_id else {}),
        "finalNodeIds": final_node_ids,
        "executedNodeIds": executed_node_ids,
        "resultsByNode": results_by_node,
        "finalOutputsByNode": {
            node_id: results_by_node[node_id]["outputs"]
            for node_id in final_node_ids
            if node_id in results_by_node
        },
        "trace": trace,
        "error": error,
    }
