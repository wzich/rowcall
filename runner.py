import contextlib
import copy
import math
import hashlib
import io
import json
import sys
import traceback
from typing import Any, Callable


COPY_HANDLERS: list[tuple[Callable[[Any], bool], Callable[[Any], Any], str]] = []
CAPTURED_OUTPUT_PREVIEW_LIMIT = 500
REPR_PREVIEW_LIMIT = 2000
JSON_PREVIEW_BYTE_LIMIT = 16_000
JSON_PREVIEW_MAX_DEPTH = 6
JSON_PREVIEW_MAX_NODES = 1_000
JSON_PREVIEW_MAX_CONTAINER_ITEMS = 200
TABLE_PREVIEW_MAX_ROWS = 50
TABLE_PREVIEW_MAX_COLUMNS = 30
TABLE_PREVIEW_MAX_CELL_REPR = 200


def emit(event: dict) -> None:
    json.dump(event, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()


def register_copy_handler(predicate, copier, label: str) -> None:
    COPY_HANDLERS.append((predicate, copier, label))


def install_default_copy_handlers() -> None:
    try:
        import pandas as pd

        register_copy_handler(
            lambda value: isinstance(value, (pd.DataFrame, pd.Series)),
            lambda value: value.copy(deep=True),
            "pandas.copy(deep=True)",
        )
    except ImportError:
        pass

    try:
        import numpy as np

        register_copy_handler(
            lambda value: isinstance(value, np.ndarray),
            lambda value: value.copy(),
            "numpy.copy()",
        )
    except ImportError:
        pass


def make_error_result(message: str, stdout: str = "", stderr: str = "") -> dict:
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


def truncate_text(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "...<truncated>"


def run_with_captured_stdio(action: Callable[[], Any]) -> tuple[Any, str, str]:
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    with contextlib.redirect_stdout(stdout_buffer):
        with contextlib.redirect_stderr(stderr_buffer):
            result = action()
    return result, stdout_buffer.getvalue(), stderr_buffer.getvalue()


def captured_stdio_warning(operation: str, stdout_text: str, stderr_text: str) -> str | None:
    parts = []
    if stdout_text:
        parts.append(
            f"stdout={truncate_text(stdout_text, CAPTURED_OUTPUT_PREVIEW_LIMIT)!r}"
        )
    if stderr_text:
        parts.append(
            f"stderr={truncate_text(stderr_text, CAPTURED_OUTPUT_PREVIEW_LIMIT)!r}"
        )
    if not parts:
        return None
    return f"{operation} emitted output while runtime telemetry was active: {', '.join(parts)}"


def combine_warnings(*warnings: str | None) -> str | None:
    present = [warning for warning in warnings if warning]
    if not present:
        return None
    return "; ".join(present)


def to_json_preview_value(
    value: Any,
    seen: set[int],
    budget: dict[str, int],
    depth: int = 0,
) -> Any:
    if budget["nodes"] <= 0:
        raise ValueError("too many values")
    budget["nodes"] -= 1

    if value is None or type(value) in (bool, int, str):
        return value

    if type(value) is float:
        return value

    if depth >= JSON_PREVIEW_MAX_DEPTH:
        raise ValueError("too deeply nested")

    if type(value) in (list, tuple):
        if len(value) > JSON_PREVIEW_MAX_CONTAINER_ITEMS:
            raise ValueError("too many container items")
        value_id = id(value)
        if value_id in seen:
            raise ValueError("cycle detected")
        seen.add(value_id)
        try:
            return [
                to_json_preview_value(item, seen, budget, depth + 1)
                for item in value
            ]
        finally:
            seen.remove(value_id)

    if type(value) is dict:
        if len(value) > JSON_PREVIEW_MAX_CONTAINER_ITEMS:
            raise ValueError("too many container items")
        value_id = id(value)
        if value_id in seen:
            raise ValueError("cycle detected")
        seen.add(value_id)
        try:
            result = {}
            for key, item in value.items():
                if type(key) is not str:
                    raise ValueError("non-string dict key")
                result[key] = to_json_preview_value(item, seen, budget, depth + 1)
            return result
        finally:
            seen.remove(value_id)

    raise ValueError("not a plain JSON value")


def make_json_preview_value(value: Any) -> Any:
    candidate = to_json_preview_value(value, set(), {"nodes": JSON_PREVIEW_MAX_NODES})
    encoded = json.dumps(candidate, ensure_ascii=False, allow_nan=False)
    if len(encoded.encode("utf-8")) > JSON_PREVIEW_BYTE_LIMIT:
        raise ValueError("JSON preview too large")
    return candidate


def is_nan_like(value: Any) -> bool:
    try:
        if isinstance(value, float):
            return math.isnan(value)
    except TypeError:
        return False

    try:
        import pandas as pd

        return bool(pd.isna(value))
    except (ImportError, TypeError, ValueError):
        return False


def table_cell_preview(value: Any) -> Any:
    if value is None:
        return None

    if is_nan_like(value):
        return {"kind": "nan"}

    if type(value) in (bool, int, str):
        return value

    if type(value) is float:
        if not math.isfinite(value):
            return {"kind": "repr", "value": repr(value)}
        return value

    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return {"kind": "datetime", "value": str(isoformat())}
        except Exception:
            pass

    try:
        import numpy as np

        if isinstance(value, np.generic):
            return table_cell_preview(value.item())
    except ImportError:
        pass

    try:
        text = repr(value)
    except Exception as exc:
        text = f"<repr failed: {exc}>"

    return {"kind": "repr", "value": truncate_text(text, TABLE_PREVIEW_MAX_CELL_REPR)}


def make_pandas_table_preview(value: Any) -> dict | None:
    try:
        import pandas as pd
    except ImportError:
        return None

    if isinstance(value, pd.Series):
        frame = value.to_frame()
    elif isinstance(value, pd.DataFrame):
        frame = value
    else:
        return None

    row_count, column_count = frame.shape
    sliced = frame.iloc[:TABLE_PREVIEW_MAX_ROWS, :TABLE_PREVIEW_MAX_COLUMNS]

    return {
        "columns": [
            {"name": str(column), "dtype": str(dtype)}
            for column, dtype in zip(sliced.columns, sliced.dtypes)
        ],
        "index": [table_cell_preview(item) for item in sliced.index.tolist()],
        "rows": [
            [table_cell_preview(item) for item in row]
            for row in sliced.itertuples(index=False, name=None)
        ],
        "rowCount": row_count,
        "columnCount": column_count,
        "truncated": row_count > TABLE_PREVIEW_MAX_ROWS
        or column_count > TABLE_PREVIEW_MAX_COLUMNS,
    }


def make_polars_table_preview(value: Any) -> dict | None:
    try:
        import polars as pl
    except ImportError:
        return None

    if isinstance(value, pl.Series):
        frame = value.to_frame()
    elif isinstance(value, pl.DataFrame):
        frame = value
    else:
        return None

    row_count, column_count = frame.shape
    sliced = frame.head(TABLE_PREVIEW_MAX_ROWS)
    columns = sliced.columns[:TABLE_PREVIEW_MAX_COLUMNS]
    sliced = sliced.select(columns) if columns else sliced
    dtype_by_column = dict(zip(sliced.columns, sliced.dtypes))

    return {
        "columns": [
            {"name": column, "dtype": str(dtype_by_column[column])}
            for column in sliced.columns
        ],
        "rows": [
            [table_cell_preview(item) for item in row]
            for row in sliced.iter_rows()
        ],
        "rowCount": row_count,
        "columnCount": column_count,
        "truncated": row_count > TABLE_PREVIEW_MAX_ROWS
        or column_count > TABLE_PREVIEW_MAX_COLUMNS,
    }


def make_table_preview(value: Any) -> dict | None:
    for previewer in (make_pandas_table_preview, make_polars_table_preview):
        try:
            preview = previewer(value)
        except Exception:
            preview = None
        if preview is not None:
            return preview
    return None


def preview_value(name: str, value: Any, warning: str | None = None) -> dict:
    stdio_warning = None
    try:
        repr_text, stdout_text, stderr_text = run_with_captured_stdio(lambda: repr(value))
        stdio_warning = captured_stdio_warning(
            f"Preview repr for '{name}'",
            stdout_text,
            stderr_text,
        )
    except Exception as exc:
        repr_text = f"<repr failed: {exc}>"

    if len(repr_text) > REPR_PREVIEW_LIMIT:
        repr_text = repr_text[:REPR_PREVIEW_LIMIT] + "...<truncated>"

    preview = {
        "name": name,
        "type": f"{type(value).__module__}.{type(value).__qualname__}",
        "repr": repr_text,
    }

    combined_warning = combine_warnings(warning, stdio_warning)
    if combined_warning:
        preview["warning"] = combined_warning

    table_preview = make_table_preview(value)
    if table_preview is not None:
        preview["table"] = table_preview

    # Keep this deliberately conservative. This field is only for small,
    # plain JSON-compatible values that are cheap and safe to ship to the UI.
    try:
        preview["jsonValue"] = make_json_preview_value(value)
    except (TypeError, ValueError, OverflowError):
        pass

    return preview


def copy_for_node_input(name: str, value: Any) -> tuple[Any, str | None]:
    if value is None or isinstance(value, (bool, int, float, str, bytes)):
        return value, None

    for predicate, copier, label in COPY_HANDLERS:
        try:
            matches, predicate_stdout, predicate_stderr = run_with_captured_stdio(
                lambda: predicate(value)
            )
            predicate_warning = captured_stdio_warning(
                f"Copy predicate {label} for input '{name}'",
                predicate_stdout,
                predicate_stderr,
            )
            if matches:
                copied, copier_stdout, copier_stderr = run_with_captured_stdio(
                    lambda: copier(value)
                )
                copier_warning = captured_stdio_warning(
                    f"Copy handler {label} for input '{name}'",
                    copier_stdout,
                    copier_stderr,
                )
                return copied, combine_warnings(predicate_warning, copier_warning)
        except Exception as exc:
            return value, (
                f"Could not copy input '{name}' with {label}; "
                f"passed by reference: {exc}"
            )

    try:
        copied, stdout_text, stderr_text = run_with_captured_stdio(
            lambda: copy.deepcopy(value)
        )
        return copied, captured_stdio_warning(
            f"Deepcopy for input '{name}'",
            stdout_text,
            stderr_text,
        )
    except Exception as exc:
        return value, f"Could not deepcopy input '{name}'; passed by reference: {exc}"


def validate_payload(payload: dict) -> str | None:
    if not isinstance(payload.get("nodes"), list):
        return "Payload field 'nodes' must be an array"
    if not isinstance(payload.get("plan"), dict):
        return "Payload field 'plan' must be an object"
    if not isinstance(payload.get("inputs", {}), dict):
        return "Payload field 'inputs' must be an object"
    if not isinstance(payload.get("trace", False), bool):
        return "Payload field 'trace' must be a boolean"
    if not isinstance(payload.get("runType"), str):
        return "Payload field 'runType' must be a string"

    for node in payload["nodes"]:
        if not isinstance(node, dict):
            return "Every node must be an object"
        if not isinstance(node.get("id"), str):
            return "Every node must have a string id"
        if not isinstance(node.get("code"), str):
            return "Every node must have string code"
        outputs = node.get("outputs")
        if not isinstance(outputs, list) or not all(
            isinstance(name, str) for name in outputs
        ):
            return "Every node must have an array of string outputs"

    plan = payload["plan"]
    if not isinstance(plan.get("targetNodeIds"), list) or not all(
        isinstance(node_id, str) for node_id in plan.get("targetNodeIds", [])
    ):
        return "Plan targetNodeIds must be an array of strings"
    if not isinstance(plan.get("steps"), list):
        return "Plan steps must be an array"
    for step in plan["steps"]:
        if not isinstance(step, dict):
            return "Every plan step must be an object"
        if not isinstance(step.get("nodeId"), str):
            return "Every plan step must have a string nodeId"
        if not isinstance(step.get("dependsOn"), list) or not all(
            isinstance(node_id, str) for node_id in step.get("dependsOn", [])
        ):
            return "Every plan step dependsOn must be an array of strings"

    return None


def build_response(
    ok: bool,
    run_type: str,
    target_node_id: str | None,
    final_node_ids: list[str],
    executed_node_ids: list[str],
    results_by_node: dict,
    trace: list | None,
    error: dict | None,
) -> dict:
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


def build_inputs_for_step(
    step: dict,
    user_inputs: dict,
    outputs_by_node: dict[str, dict[str, Any]],
) -> tuple[dict[str, Any], list[str]]:
    raw_inputs = user_inputs if not step["dependsOn"] else {}

    for dependency in step["dependsOn"]:
        raw_inputs.update(outputs_by_node[dependency])

    scoped_inputs = {}
    warnings = []
    for name, value in raw_inputs.items():
        copied, warning = copy_for_node_input(name, value)
        scoped_inputs[name] = copied
        if warning:
            warnings.append(warning)

    return scoped_inputs, warnings


def append_stdout_event(output_events: list[dict], text: str) -> None:
    if not text:
        return
    if output_events and output_events[-1]["kind"] == "stdout":
        output_events[-1]["text"] += text
    else:
        output_events.append({"kind": "stdout", "text": text})


class CapturedStdout(io.StringIO):
    def __init__(self, output_events: list[dict]) -> None:
        super().__init__()
        self.output_events = output_events

    def write(self, text: str) -> int:
        append_stdout_event(self.output_events, text)
        return super().write(text)


def make_display_collector(
    displays: list[dict],
    output_events: list[dict],
) -> Callable[[Any], None]:
    def display(value: Any) -> None:
        display_preview = {"value": preview_value("display", value)}
        displays.append(display_preview)
        output_events.append({"kind": "display", "value": display_preview["value"]})

    return display


@contextlib.contextmanager
def active_nodebook_display(display: Callable[[Any], None]):
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


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def node_signature(node: dict) -> dict:
    return {
        "id": node["id"],
        "code": node["code"],
        "outputs": node["outputs"],
    }


def hash_cache_key(parts: dict) -> str:
    encoded = canonical_json(parts).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def expected_cache_keys(
    nodes_by_id: dict[str, dict],
    plan: dict,
    user_inputs: dict,
) -> dict[str, str]:
    keys = {}
    input_key = hash_cache_key({"rootInputs": user_inputs})

    for step in plan["steps"]:
        node_id = step["nodeId"]
        keys[node_id] = hash_cache_key(
            {
                "node": node_signature(nodes_by_id[node_id]),
                "rootInputs": input_key if not step["dependsOn"] else None,
                "upstream": [
                    {"nodeId": dependency, "key": keys[dependency]}
                    for dependency in step["dependsOn"]
                ],
            }
        )

    return keys


def make_cache_error_response(
    run_type: str,
    target_node_id: str | None,
    final_node_ids: list[str],
    trace: list | None,
    message: str,
    node_id: str | None = None,
) -> dict:
    return build_response(
        False,
        run_type,
        target_node_id,
        final_node_ids,
        [],
        {},
        trace,
        {
            "kind": "cache_miss",
            "message": message,
            **({"nodeId": node_id} if node_id else {}),
        },
    )


class RuntimeSession:
    def __init__(self) -> None:
        self.cache: dict[str, dict] = {}

    def clear_cache(self) -> None:
        self.cache.clear()

    def validate_cached_upstream(
        self,
        plan: dict,
        target_node_id: str,
        expected_keys: dict[str, str],
    ) -> str | None:
        target_step = next(
            (step for step in plan["steps"] if step["nodeId"] == target_node_id),
            None,
        )
        if target_step is None:
            return f"Target node {target_node_id} is not in the run plan"

        for step in plan["steps"]:
            node_id = step["nodeId"]
            if node_id == target_node_id:
                break

            cached = self.cache.get(node_id)
            if cached is None:
                return (
                    f"Upstream cache is missing for node {node_id}. "
                    "Run to this node first to refresh upstream outputs."
                )
            if cached["key"] != expected_keys[node_id]:
                return (
                    f"Upstream cache is stale for node {node_id}. "
                    "Run to this node first to refresh upstream outputs."
                )

        return None

    def build_cached_inputs_for_step(
        self,
        step: dict,
        user_inputs: dict,
    ) -> tuple[dict[str, Any], list[str]]:
        if not step["dependsOn"]:
            raw_inputs = user_inputs
        else:
            raw_inputs = {}
            for dependency in step["dependsOn"]:
                raw_inputs.update(self.cache[dependency]["outputs"])

        scoped_inputs = {}
        warnings = []
        for name, value in raw_inputs.items():
            copied, warning = copy_for_node_input(name, value)
            scoped_inputs[name] = copied
            if warning:
                warnings.append(warning)

        return scoped_inputs, warnings


def run_plan(payload: dict, session: RuntimeSession | None = None) -> dict:
    validation_error = validate_payload(payload)
    run_type = payload.get("runType", "run_graph")
    target_node_id = payload.get("targetNodeId")
    plan = payload.get("plan", {"targetNodeIds": [], "steps": []})
    cache_mode = payload.get("cacheMode", "none")

    if validation_error:
        return build_response(
            False,
            run_type,
            target_node_id,
            plan.get("targetNodeIds", []),
            [],
            {},
            [] if payload.get("trace", False) else None,
            {"kind": "internal_error", "message": validation_error},
        )

    nodes_by_id = {node["id"]: node for node in payload["nodes"]}
    user_inputs = payload.get("inputs", {})
    trace_enabled = payload.get("trace", False)
    trace = [] if trace_enabled else None
    results_by_node = {}
    outputs_by_node = {}
    executed_node_ids = []
    cache_keys = expected_cache_keys(nodes_by_id, plan, user_inputs)
    steps_to_execute = plan["steps"]

    if cache_mode == "single_node":
        if session is None:
            return make_cache_error_response(
                run_type,
                target_node_id,
                plan["targetNodeIds"],
                trace,
                "Run node requires a runtime session cache",
                target_node_id,
            )
        if target_node_id is None:
            return make_cache_error_response(
                run_type,
                target_node_id,
                plan["targetNodeIds"],
                trace,
                "Run node requires a target node",
            )

        cache_error = session.validate_cached_upstream(
            plan,
            target_node_id,
            cache_keys,
        )
        if cache_error:
            return make_cache_error_response(
                run_type,
                target_node_id,
                plan["targetNodeIds"],
                trace,
                cache_error,
                target_node_id,
            )

        target_step = next(
            step for step in plan["steps"] if step["nodeId"] == target_node_id
        )
        steps_to_execute = [target_step]

    for index, step in enumerate(steps_to_execute):
        node_id = step["nodeId"]
        node = nodes_by_id[node_id]

        emit(
            {
                "type": "node_started",
                "index": index,
                "nodeId": node_id,
                "dependsOn": step["dependsOn"],
            }
        )

        if cache_mode == "single_node" and session is not None:
            inputs, input_warnings = session.build_cached_inputs_for_step(
                step,
                user_inputs,
            )
        else:
            inputs, input_warnings = build_inputs_for_step(
                step,
                user_inputs,
                outputs_by_node,
            )
        scope = dict(inputs)
        output_events: list[dict] = []
        stdout_buffer = CapturedStdout(output_events)
        stderr_buffer = io.StringIO()
        displays: list[dict] = []
        scope["display"] = make_display_collector(displays, output_events)
        result_warnings = list(input_warnings)

        try:
            with active_nodebook_display(scope["display"]):
                with contextlib.redirect_stdout(stdout_buffer):
                    with contextlib.redirect_stderr(stderr_buffer):
                        exec(node["code"], scope, scope)
        except Exception as exc:
            stderr_text = stderr_buffer.getvalue() + traceback.format_exc()
            result = make_error_result(str(exc), stdout_buffer.getvalue(), stderr_text)
            result["displays"] = displays
            result["outputEvents"] = output_events
            result["warnings"] = result_warnings
            results_by_node[node_id] = result
            executed_node_ids.append(node_id)

            if trace_enabled:
                trace.append(
                    {
                        "index": index,
                        "nodeId": node_id,
                        "dependsOn": step["dependsOn"],
                        "inputs": {
                            name: preview_value(name, value)
                            for name, value in inputs.items()
                        },
                        "ok": False,
                        "stdout": result["stdout"],
                        "stderr": result["stderr"],
                        "outputs": {},
                        "displays": displays,
                        "outputEvents": output_events,
                        "warnings": result_warnings,
                        "error": result["error"],
                    }
                )

            emit(
                {
                    "type": "node_failed",
                    "index": index,
                    "nodeId": node_id,
                    "dependsOn": step["dependsOn"],
                    "result": result,
                }
            )

            return build_response(
                False,
                run_type,
                target_node_id,
                plan["targetNodeIds"],
                executed_node_ids,
                results_by_node,
                trace,
                {
                    "kind": "runtime_error",
                    "message": f"Failed execution at node {node_id}",
                    "nodeId": node_id,
                },
            )

        node_outputs = {}
        output_previews = {}
        for name in node["outputs"]:
            if name not in scope:
                result = make_error_result(
                    f"Declared output '{name}' was not defined by node code",
                    stdout_buffer.getvalue(),
                    stderr_buffer.getvalue(),
                )
                result["displays"] = displays
                result["outputEvents"] = output_events
                result["warnings"] = result_warnings
                results_by_node[node_id] = result
                executed_node_ids.append(node_id)

                if trace_enabled:
                    trace.append(
                        {
                            "index": index,
                            "nodeId": node_id,
                            "dependsOn": step["dependsOn"],
                            "inputs": {
                                input_name: preview_value(input_name, value)
                                for input_name, value in inputs.items()
                            },
                            "ok": False,
                            "stdout": result["stdout"],
                            "stderr": result["stderr"],
                            "outputs": {},
                            "displays": displays,
                            "outputEvents": output_events,
                            "warnings": result_warnings,
                            "error": result["error"],
                        }
                    )

                emit(
                    {
                        "type": "node_failed",
                        "index": index,
                        "nodeId": node_id,
                        "dependsOn": step["dependsOn"],
                        "result": result,
                    }
                )

                return build_response(
                    False,
                    run_type,
                    target_node_id,
                    plan["targetNodeIds"],
                    executed_node_ids,
                    results_by_node,
                    trace,
                    {
                        "kind": "runtime_error",
                        "message": f"Failed execution at node {node_id}",
                        "nodeId": node_id,
                    },
                )

            node_outputs[name] = scope[name]
            output_previews[name] = preview_value(name, scope[name])

        outputs_by_node[node_id] = node_outputs
        if session is not None:
            session.cache[node_id] = {
                "key": cache_keys[node_id],
                "outputs": node_outputs,
            }

        result = {
            "ok": True,
            "stdout": stdout_buffer.getvalue(),
            "stderr": stderr_buffer.getvalue(),
            "outputs": output_previews,
            "displays": displays,
            "outputEvents": output_events,
            "warnings": result_warnings,
        }
        results_by_node[node_id] = result
        executed_node_ids.append(node_id)

        if trace_enabled:
            trace.append(
                {
                    "index": index,
                    "nodeId": node_id,
                    "dependsOn": step["dependsOn"],
                    "inputs": {
                        name: preview_value(name, value) for name, value in inputs.items()
                    },
                    "ok": True,
                    "stdout": result["stdout"],
                    "stderr": result["stderr"],
                    "outputs": output_previews,
                    "displays": displays,
                    "outputEvents": output_events,
                    "warnings": result_warnings,
                    "error": None,
                }
            )

        emit(
            {
                "type": "node_completed",
                "index": index,
                "nodeId": node_id,
                "dependsOn": step["dependsOn"],
                "result": result,
            }
        )

    return build_response(
        True,
        run_type,
        target_node_id,
        plan["targetNodeIds"],
        executed_node_ids,
        results_by_node,
        trace,
        None,
    )


def run_session() -> int:
    install_default_copy_handlers()
    session = RuntimeSession()

    for line in sys.stdin:
        if not line.strip():
            continue

        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            emit(
                {
                    "type": "run_failed",
                    "response": build_response(
                        False,
                        "run_graph",
                        None,
                        [],
                        [],
                        {},
                        None,
                        {
                            "kind": "internal_error",
                            "message": f"Failed to decode JSON payload: {exc}",
                        },
                    ),
                }
            )
            continue

        command = payload.get("command", "run") if isinstance(payload, dict) else "run"
        if command == "clear_cache":
            session.clear_cache()
            emit({"type": "session_cache_cleared", "ok": True})
            continue

        if not isinstance(payload, dict):
            emit(
                {
                    "type": "run_failed",
                    "response": build_response(
                        False,
                        "run_graph",
                        None,
                        [],
                        [],
                        {},
                        None,
                        {
                            "kind": "internal_error",
                            "message": "Top-level payload must be an object",
                        },
                    ),
                }
            )
            continue

        response = run_plan(payload, session)
        emit(
            {
                "type": "run_completed" if response["ok"] else "run_failed",
                "response": response,
            }
        )

    return 0


def main() -> int:
    if "--session" in sys.argv:
        return run_session()

    install_default_copy_handlers()

    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        response = build_response(
            False,
            "run_graph",
            None,
            [],
            [],
            {},
            None,
            {"kind": "internal_error", "message": f"Failed to decode JSON payload: {exc}"},
        )
        emit({"type": "run_failed", "response": response})
        return 1

    if not isinstance(payload, dict):
        response = build_response(
            False,
            "run_graph",
            None,
            [],
            [],
            {},
            None,
            {"kind": "internal_error", "message": "Top-level payload must be an object"},
        )
        emit({"type": "run_failed", "response": response})
        return 1

    response = run_plan(payload)
    emit(
        {
            "type": "run_completed" if response["ok"] else "run_failed",
            "response": response,
        }
    )
    return 0 if response["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
