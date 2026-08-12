"""Stateless Python runtime executor for Nodebook documents."""

from __future__ import annotations

import contextlib
import hashlib
import io
import importlib
import importlib.machinery
import importlib.util
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
DEFAULT_CAPTURE_LIMIT_BYTES = 1024 * 1024
DEFAULT_DISPLAY_EVENT_LIMIT = 100
DEFAULT_ERROR_MESSAGE_LIMIT_BYTES = 16 * 1024
_TRUNCATED_ERROR_SUFFIX = "\n[error message truncated]"
_DOCUMENT_LOCAL_MODULE_PATHS: dict[str, frozenset[Path]] = {}


@dataclass(frozen=True)
class RunRequest:
    source: str
    document_path: Path
    target: str | None = None
    trace: bool = False


class ImportFreshnessError(RuntimeError):
    """Raised when a fresh import state cannot be established safely."""


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
    root_inputs: dict[str, Any] | None = None,
    on_node_event: NodeEventCallback | None = None,
    capture_raw_outputs: bool = False,
) -> dict[str, Any]:
    path = Path(document_path).expanduser().resolve()
    source_revision = hashlib.sha256(source.encode("utf-8")).hexdigest()
    response_run_type = run_type or ("run_to_node" if target else "run_graph")
    install_default_copy_handlers()

    with document_execution_context(path):
        try:
            invalidate_document_local_imports(path.parent)
        except ImportFreshnessError as exc:
            return build_response(
                ok=False,
                run_type=response_run_type,
                target_node_id=target,
                final_node_ids=[],
                executed_node_ids=[],
                results_by_node={},
                trace=[] if trace else None,
                error={
                    "kind": "import_freshness_error",
                    "phase": "runtime_preparation",
                    "message": bound_diagnostic_text(str(exc)),
                    "pythonExecutable": sys.executable,
                },
                document_revision=source_revision,
            )
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
                document_revision=source_revision,
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
                error={"kind": "planning_error", "message": bound_diagnostic_text(str(exc))},
                document_revision=document.revision,
            )

        return execute_plan(
            document,
            plan,
            target_node_id=target_node_id,
            trace_enabled=trace,
            run_type=run_type,
            root_inputs=root_inputs,
            on_node_event=on_node_event,
            capture_raw_outputs=capture_raw_outputs,
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


def invalidate_document_local_imports(document_dir: Path) -> None:
    """Evict local helper modules so each run observes current source files.

    This is deliberately not a provenance or cache system. It simply prevents
    the long-lived worker's normal ``sys.modules`` cache from violating the
    fresh-execution contract between separate runs.
    """
    importlib.invalidate_caches()
    root = document_dir.resolve()
    previous_document_modules = dict(_DOCUMENT_LOCAL_MODULE_PATHS)
    shadowed_top_level_names = _importable_top_level_names(root)
    for name, module in tuple(sys.modules.items()):
        if name == "nodebook" or name.startswith("nodebook."):
            continue
        top_level_name = name.partition(".")[0]
        top_level_module = sys.modules.get(top_level_name)
        top_level_origin = _module_spec_origin(top_level_module)
        if top_level_origin in {"built-in", "frozen"}:
            continue
        try:
            lexical_path = _absolute_module_path(_static_module_attribute(module, "__file__"))
            module_paths = _module_paths(module)
            previous_paths = previous_document_modules.get(name)
            loaded_from_previous_document = (
                previous_paths is not None
                and not module_paths.isdisjoint(previous_paths)
            )
            loaded_from_current_document = (
                any(path.is_relative_to(root) for path in module_paths)
            )
            loaded_from_document = loaded_from_previous_document or loaded_from_current_document
            shadowed_by_document = top_level_name in shadowed_top_level_names
            if not loaded_from_document and not shadowed_by_document:
                continue
            if loaded_from_document:
                _remove_safely_derived_bytecode(module, lexical_path)
            sys.modules.pop(name, None)
        except ImportFreshnessError:
            raise
        except (OSError, RuntimeError):
            # A missing or unreadable prior helper cannot be reused safely.
            sys.modules.pop(name, None)
    _DOCUMENT_LOCAL_MODULE_PATHS.clear()


def _importable_top_level_names(root: Path) -> set[str]:
    """Return loaded top-level names that the document directory can shadow."""
    names = {name.partition(".")[0] for name in sys.modules}
    names.discard("nodebook")
    importable: set[str] = set()
    for name in names:
        try:
            if importlib.machinery.PathFinder.find_spec(name, [str(root)]) is not None:
                importable.add(name)
        except (ImportError, OSError, RuntimeError, ValueError):
            continue
    return importable


def _remove_safely_derived_bytecode(module: Any, loaded_path: Path | None) -> None:
    """Remove bytecode only when its Python source still exists.

    A standalone ``.pyc`` can be the module's sole source. Keeping it is
    necessary so eviction from ``sys.modules`` does not make the next fresh
    run unable to import the helper at all.
    """
    cached_path = _absolute_module_path(_static_module_attribute(module, "__cached__"))
    source_path: Path | None = None
    if loaded_path is not None and loaded_path.suffix == ".py":
        source_path = loaded_path
        if cached_path is not None:
            try:
                cached_source = Path(
                    os.path.abspath(importlib.util.source_from_cache(str(cached_path)))
                )
                if cached_source != source_path:
                    cached_path = None
            except (NotImplementedError, ValueError):
                cached_path = None
        if cached_path is None:
            try:
                cached_path = Path(importlib.util.cache_from_source(str(source_path)))
            except (NotImplementedError, ValueError):
                return
    elif cached_path is not None:
        try:
            source_path = Path(importlib.util.source_from_cache(str(cached_path)))
        except (NotImplementedError, ValueError):
            return
    if source_path is not None and cached_path is not None and source_path.exists():
        try:
            cached_path.unlink(missing_ok=True)
        except OSError as exc:
            raise ImportFreshnessError(
                "Execution did not start because Nodebook could not remove "
                f"derived local bytecode {cached_path}: {exc}"
            ) from exc
        if cached_path.exists():
            raise ImportFreshnessError(
                "Execution did not start because derived local bytecode still "
                f"exists after removal was requested: {cached_path}"
            )


def _module_paths(module: Any) -> frozenset[Path]:
    """Return lexical and resolved origins, including namespace package paths."""
    paths: set[Path] = set()
    filename = _absolute_module_path(_static_module_attribute(module, "__file__"))
    if filename is not None:
        paths.add(filename)
        paths.add(filename.resolve())

    spec = _static_module_attribute(module, "__spec__")
    try:
        package_locations = getattr(spec, "submodule_search_locations", None)
        locations = tuple(package_locations) if package_locations is not None else ()
    except Exception:
        locations = ()
    for location in locations:
        lexical_path = _absolute_module_path(location)
        if lexical_path is None:
            continue
        paths.add(lexical_path)
        paths.add(lexical_path.resolve())
    return frozenset(paths)


def _static_module_attribute(module: Any, name: str) -> Any:
    """Read real module metadata without invoking a dynamic ``__getattr__``."""
    try:
        return vars(module).get(name)
    except Exception:
        return None


def _module_spec_origin(module: Any) -> Any:
    spec = _static_module_attribute(module, "__spec__")
    try:
        return getattr(spec, "origin", None)
    except Exception:
        return None


def _absolute_module_path(value: Any) -> Path | None:
    """Accept only unambiguous absolute paths from third-party module metadata."""
    try:
        path = Path(os.fsdecode(os.fspath(value)))
    except Exception:
        return None
    return path if path.is_absolute() else None


def remember_document_local_imports(document_dir: Path) -> None:
    """Remember local module names so a later run in another root evicts them."""
    root = document_dir.resolve()
    for name, module in tuple(sys.modules.items()):
        if name == "nodebook" or name.startswith("nodebook."):
            continue
        try:
            module_paths = _module_paths(module)
            if any(path.is_relative_to(root) for path in module_paths):
                _DOCUMENT_LOCAL_MODULE_PATHS[name] = module_paths
        except (OSError, RuntimeError):
            continue


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
        remember_document_local_imports(document_path.parent)
        os.chdir(previous_cwd)
        sys.path[:] = previous_path


def execute_plan(
    document: ExecutableDocument,
    plan: RunPlan,
    *,
    target_node_id: str | None,
    trace_enabled: bool,
    run_type: str | None = None,
    root_inputs: dict[str, Any] | None = None,
    on_node_event: NodeEventCallback | None = None,
    capture_raw_outputs: bool = False,
) -> dict[str, Any]:
    response_run_type = run_type or ("run_to_node" if target_node_id else "run_graph")
    nodes_by_id = {node.id: node for node in document.nodes}
    trace: list[dict[str, Any]] | None = [] if trace_enabled else None
    results_by_node: dict[str, dict[str, Any]] = {}
    outputs_by_node: dict[str, dict[str, Any]] = {}
    executed_node_ids: list[str] = []
    root_inputs = {} if root_inputs is None else dict(root_inputs)

    globals_result = build_document_globals(document)
    if not globals_result["ok"]:
        error = {
            **globals_result["errorDetails"],
            "stdout": globals_result["stdout"],
            "stderr": globals_result["stderr"],
            "warnings": globals_result.get("warnings", []),
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
            document_revision=document.revision,
        )
    globals_scope = globals_result["scope"]

    for index, step in enumerate(plan.steps):
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
        inputs, input_warnings = build_inputs_for_step(step.depends_on, outputs_by_node, root_inputs)
        result = execute_node(node, globals_scope, inputs, input_warnings, str(document.path))
        results_by_node[node_id] = result
        executed_node_ids.append(node_id)

        if result["ok"]:
            raw_outputs = result["_rawOutputs"]
            outputs_by_node[node_id] = raw_outputs
            del result["_rawOutputs"]
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
            document_revision=document.revision,
        )

    response = build_response(
        ok=True,
        run_type=response_run_type,
        target_node_id=target_node_id,
        final_node_ids=list(plan.target_node_ids),
        executed_node_ids=executed_node_ids,
        results_by_node=results_by_node,
        trace=trace,
        error=None,
        document_revision=document.revision,
    )
    if capture_raw_outputs:
        response["_rawOutputsByNode"] = outputs_by_node
    return response


def build_document_globals(document: ExecutableDocument) -> dict[str, Any]:
    scope: dict[str, Any] = {"__file__": str(document.path)}
    if not document.globals_code:
        return {"ok": True, "scope": scope}

    stdout_buffer = BoundedTextBuffer(DEFAULT_CAPTURE_LIMIT_BYTES)
    stderr_buffer = BoundedTextBuffer(DEFAULT_CAPTURE_LIMIT_BYTES)
    try:
        with contextlib.redirect_stdout(stdout_buffer):
            with contextlib.redirect_stderr(stderr_buffer):
                code = compile(document.globals_code, str(document.path), "exec")
                exec(code, scope, scope)
    except Exception as exc:
        error_details = classify_exception(exc, phase="document_globals")
        stderr_buffer.write(traceback.format_exc())
        return {
            "ok": False,
            "scope": scope,
            "error": bound_diagnostic_text(str(exc)),
            "errorDetails": error_details,
            "stdout": stdout_buffer.getvalue(),
            "stderr": stderr_buffer.getvalue(),
            "warnings": _capture_warnings(stdout_buffer, stderr_buffer),
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
    stderr_buffer = BoundedTextBuffer(DEFAULT_CAPTURE_LIMIT_BYTES)
    result_warnings = list(input_warnings)
    displays: list[dict[str, Any]] = []
    scope["display"] = make_display_collector(displays, output_events, result_warnings)

    try:
        with active_nodebook_display(scope["display"]):
            with contextlib.redirect_stdout(stdout_buffer):
                with contextlib.redirect_stderr(stderr_buffer):
                    code = compile(node.runtime_code, filename, "exec")
                    exec(code, scope, scope)
    except Exception as exc:
        stderr_buffer.write(traceback.format_exc())
        error_details = classify_exception(exc, phase="node_execution", node_id=node.id)
        result = make_error_result(
            bound_diagnostic_text(str(exc)),
            stdout_buffer.getvalue(),
            stderr_buffer.getvalue(),
            error_details=error_details,
        )
        result["displays"] = displays
        result["outputEvents"] = output_events
        result["warnings"] = [*result_warnings, *_capture_warnings(stdout_buffer, stderr_buffer)]
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
            result["warnings"] = [*result_warnings, *_capture_warnings(stdout_buffer, stderr_buffer)]
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
        "warnings": [*result_warnings, *_capture_warnings(stdout_buffer, stderr_buffer)],
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
        "error": bound_diagnostic_text(message),
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
        missing_module = bound_diagnostic_text(str(missing_module))
        if phase == "document_globals":
            message = f"Missing Python package while loading document globals: {missing_module}"
        elif node_id:
            message = f"Missing Python package while running node {node_id}: {missing_module}"
        else:
            message = f"Missing Python package while running document: {missing_module}"
        message = bound_diagnostic_text(message)
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


def bound_diagnostic_text(
    text: str,
    limit_bytes: int = DEFAULT_ERROR_MESSAGE_LIMIT_BYTES,
) -> str:
    """Bound a user-controlled diagnostic while marking any truncation."""
    encoded = text.encode("utf-8", errors="backslashreplace")
    if len(encoded) <= limit_bytes:
        return encoded.decode("utf-8")
    suffix = _TRUNCATED_ERROR_SUFFIX.encode("utf-8")
    if limit_bytes <= len(suffix):
        return suffix[: max(0, limit_bytes)].decode("utf-8", errors="ignore")
    retained = encoded[: limit_bytes - len(suffix)].decode("utf-8", errors="ignore")
    return retained + _TRUNCATED_ERROR_SUFFIX


def append_stdout_event(output_events: list[dict[str, Any]], text: str) -> None:
    if not text:
        return
    if output_events and output_events[-1]["kind"] == "stdout":
        output_events[-1]["text"] += text
    else:
        output_events.append({"kind": "stdout", "text": text})


class BoundedTextBuffer(io.StringIO):
    def __init__(self, limit_bytes: int) -> None:
        super().__init__()
        self.limit_bytes = limit_bytes
        self.retained_bytes = 0
        self.truncated_bytes = 0
        self.last_retained = ""

    def _retain(self, text: str) -> str:
        encoded = text.encode("utf-8", errors="backslashreplace")
        remaining = max(0, self.limit_bytes - self.retained_bytes)
        kept_bytes = encoded[:remaining]
        while kept_bytes:
            try:
                kept = kept_bytes.decode("utf-8")
                break
            except UnicodeDecodeError:
                kept_bytes = kept_bytes[:-1]
        else:
            kept = ""
        self.retained_bytes += len(kept_bytes)
        self.truncated_bytes += len(encoded) - len(kept_bytes)
        self.last_retained = kept
        return kept

    def write(self, text: str) -> int:
        super().write(self._retain(text))
        return len(text)


class CapturedStdout(BoundedTextBuffer):
    def __init__(self, output_events: list[dict[str, Any]]) -> None:
        super().__init__(DEFAULT_CAPTURE_LIMIT_BYTES)
        self.output_events = output_events

    def write(self, text: str) -> int:
        result = super().write(text)
        append_stdout_event(self.output_events, self.last_retained)
        return result


def _capture_warnings(stdout: BoundedTextBuffer, stderr: BoundedTextBuffer) -> list[str]:
    warnings: list[str] = []
    if stdout.truncated_bytes:
        warnings.append(
            f"stdout was truncated after {stdout.limit_bytes} retained bytes "
            f"({stdout.truncated_bytes} additional bytes discarded)"
        )
    if stderr.truncated_bytes:
        warnings.append(
            f"stderr was truncated after {stderr.limit_bytes} retained bytes "
            f"({stderr.truncated_bytes} additional bytes discarded)"
        )
    return warnings


def make_display_collector(
    displays: list[dict[str, Any]],
    output_events: list[dict[str, Any]],
    warnings: list[str],
) -> Callable[[Any], None]:
    def display(value: Any) -> None:
        if len(displays) >= DEFAULT_DISPLAY_EVENT_LIMIT:
            warning = f"display events were truncated after {DEFAULT_DISPLAY_EVENT_LIMIT} values"
            if warning not in warnings:
                warnings.append(warning)
            return
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
    document_revision: str | None = None,
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
        **({"documentRevision": document_revision} if document_revision else {}),
    }
