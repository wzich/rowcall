"""Stateless Python runtime executor for Nodebook documents."""

from __future__ import annotations

import contextlib
import io
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
    path = Path(document_path).expanduser().resolve()
    install_default_copy_handlers()

    with document_execution_context(path):
        parse_result = parse_source(source, path)
        if not parse_result.ok or parse_result.document is None:
            return build_response(
                ok=False,
                run_type="run_to_node" if target else "run_graph",
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
                run_type="run_to_node" if target else "run_graph",
                target_node_id=target,
                final_node_ids=[],
                executed_node_ids=[],
                results_by_node={},
                trace=[] if trace else None,
                error={"kind": "planning_error", "message": str(exc)},
            )

        return execute_plan(document, plan, target_node_id=target_node_id, trace_enabled=trace)


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
) -> dict[str, Any]:
    run_type = "run_to_node" if target_node_id else "run_graph"
    nodes_by_id = {node.id: node for node in document.nodes}
    trace: list[dict[str, Any]] | None = [] if trace_enabled else None
    results_by_node: dict[str, dict[str, Any]] = {}
    outputs_by_node: dict[str, dict[str, Any]] = {}
    executed_node_ids: list[str] = []
    globals_result = build_document_globals(document)
    if not globals_result["ok"]:
        return build_response(
            ok=False,
            run_type=run_type,
            target_node_id=target_node_id,
            final_node_ids=list(plan.target_node_ids),
            executed_node_ids=[],
            results_by_node={},
            trace=trace,
            error={
                "kind": "runtime_error",
                "message": "Failed execution in document globals",
                "stdout": globals_result["stdout"],
                "stderr": globals_result["stderr"],
                "error": globals_result["error"],
            },
        )
    globals_scope = globals_result["scope"]

    for index, step in enumerate(plan.steps):
        node_id = step.node_id
        node = nodes_by_id[node_id]
        inputs, input_warnings = build_inputs_for_step(step.depends_on, outputs_by_node)
        result = execute_node(node, globals_scope, inputs, input_warnings, str(document.path))
        results_by_node[node_id] = result
        executed_node_ids.append(node_id)

        if result["ok"]:
            outputs_by_node[node_id] = result["_rawOutputs"]
            del result["_rawOutputs"]
            append_trace(
                trace,
                index=index,
                node_id=node_id,
                depends_on=step.depends_on,
                inputs=inputs,
                result=result,
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
        return build_response(
            ok=False,
            run_type=run_type,
            target_node_id=target_node_id,
            final_node_ids=list(plan.target_node_ids),
            executed_node_ids=executed_node_ids,
            results_by_node=results_by_node,
            trace=trace,
            error={
                "kind": "runtime_error",
                "message": f"Failed execution at node {node_id}",
                "nodeId": node_id,
            },
        )

    return build_response(
        ok=True,
        run_type=run_type,
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
        return {
            "ok": False,
            "scope": scope,
            "error": str(exc),
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
) -> tuple[dict[str, Any], list[str]]:
    raw_inputs: dict[str, Any] = {}
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
        result = make_error_result(str(exc), stdout_buffer.getvalue(), stderr_text)
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


def make_error_result(message: str, stdout: str = "", stderr: str = "") -> dict[str, Any]:
    return {
        "ok": False,
        "stdout": stdout,
        "stderr": stderr,
        "outputs": {},
        "displays": [],
        "outputEvents": [],
        "warnings": [],
        "error": message,
    }


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
