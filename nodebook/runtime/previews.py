"""Runtime value copying and preview helpers."""

from __future__ import annotations

import contextlib
import copy
import io
import json
import math
from collections.abc import Callable
from typing import Any


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


def register_copy_handler(predicate: Callable[[Any], bool], copier: Callable[[Any], Any], label: str) -> None:
    COPY_HANDLERS.append((predicate, copier, label))


def install_default_copy_handlers() -> None:
    if COPY_HANDLERS:
        return

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
        parts.append(f"stdout={truncate_text(stdout_text, CAPTURED_OUTPUT_PREVIEW_LIMIT)!r}")
    if stderr_text:
        parts.append(f"stderr={truncate_text(stderr_text, CAPTURED_OUTPUT_PREVIEW_LIMIT)!r}")
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
            return [to_json_preview_value(item, seen, budget, depth + 1) for item in value]
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


def make_pandas_table_preview(value: Any) -> dict[str, Any] | None:
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
        "truncated": row_count > TABLE_PREVIEW_MAX_ROWS or column_count > TABLE_PREVIEW_MAX_COLUMNS,
    }


def make_polars_table_preview(value: Any) -> dict[str, Any] | None:
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
        "rows": [[table_cell_preview(item) for item in row] for row in sliced.iter_rows()],
        "rowCount": row_count,
        "columnCount": column_count,
        "truncated": row_count > TABLE_PREVIEW_MAX_ROWS or column_count > TABLE_PREVIEW_MAX_COLUMNS,
    }


def make_table_preview(value: Any) -> dict[str, Any] | None:
    for previewer in (make_pandas_table_preview, make_polars_table_preview):
        try:
            preview = previewer(value)
        except Exception:
            preview = None
        if preview is not None:
            return preview
    return None


def preview_value(name: str, value: Any, warning: str | None = None) -> dict[str, Any]:
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

    preview: dict[str, Any] = {
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
            matches, predicate_stdout, predicate_stderr = run_with_captured_stdio(lambda: predicate(value))
            predicate_warning = captured_stdio_warning(
                f"Copy predicate {label} for input '{name}'",
                predicate_stdout,
                predicate_stderr,
            )
            if matches:
                copied, copier_stdout, copier_stderr = run_with_captured_stdio(lambda: copier(value))
                copier_warning = captured_stdio_warning(
                    f"Copy handler {label} for input '{name}'",
                    copier_stdout,
                    copier_stderr,
                )
                return copied, combine_warnings(predicate_warning, copier_warning)
        except Exception as exc:
            return value, f"Could not copy input '{name}' with {label}; passed by reference: {exc}"

    try:
        copied, stdout_text, stderr_text = run_with_captured_stdio(lambda: copy.deepcopy(value))
        return copied, captured_stdio_warning(
            f"Deepcopy for input '{name}'",
            stdout_text,
            stderr_text,
        )
    except Exception as exc:
        return value, f"Could not deepcopy input '{name}'; passed by reference: {exc}"
