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
TEXT_TRUNCATION_MARKER = "...<truncated>"
CAPTURED_OUTPUT_PREVIEW_BYTE_LIMIT = 500
CAPTURED_OUTPUT_RETAIN_LIMIT = 16_000
REPR_PREVIEW_BYTE_LIMIT = 2_000
PREVIEW_IDENTITY_BYTE_LIMIT = 1_024
PREVIEW_WARNING_BYTE_LIMIT = 16_000
COPY_WARNING_BYTE_LIMIT = 4_096
JSON_PREVIEW_BYTE_LIMIT = 512_000
JSON_PREVIEW_MAX_DEPTH = 6
JSON_PREVIEW_MAX_NODES = 20_000
JSON_PREVIEW_MAX_CONTAINER_ITEMS = 2_000
TABLE_PREVIEW_MAX_ROWS = 50
TABLE_PREVIEW_MAX_COLUMNS = 30
TABLE_PREVIEW_CELL_TEXT_BYTE_LIMIT = 512
TABLE_PREVIEW_METADATA_TEXT_BYTE_LIMIT = 512
TABLE_PREVIEW_MAX_INTEGER_BITS = 1_024


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


def truncate_utf8_text(text: str, limit_bytes: int) -> str:
    """Bound text by encoded size and make any truncation explicit."""
    encoded = text.encode("utf-8", errors="backslashreplace")
    if len(encoded) <= limit_bytes:
        return encoded.decode("utf-8")
    marker = TEXT_TRUNCATION_MARKER.encode("utf-8")
    if limit_bytes <= len(marker):
        return marker[: max(0, limit_bytes)].decode("utf-8", errors="ignore")
    retained = encoded[: limit_bytes - len(marker)].decode("utf-8", errors="ignore")
    return retained + TEXT_TRUNCATION_MARKER


class _BoundedPreviewCapture(io.StringIO):
    def __init__(self, limit: int = CAPTURED_OUTPUT_RETAIN_LIMIT) -> None:
        super().__init__()
        self.limit = limit
        self.retained = 0
        self.dropped = 0

    def write(self, text: str) -> int:
        remaining = max(0, self.limit - self.retained)
        kept = text[:remaining]
        self.retained += len(kept)
        self.dropped += len(text) - len(kept)
        super().write(kept)
        return len(text)

    def retained_value(self) -> str:
        value = self.getvalue()
        if self.dropped:
            return f"{value}...<{self.dropped} characters truncated>"
        return value


def run_with_captured_stdio(action: Callable[[], Any]) -> tuple[Any, str, str]:
    stdout_buffer = _BoundedPreviewCapture()
    stderr_buffer = _BoundedPreviewCapture()
    with contextlib.redirect_stdout(stdout_buffer):
        with contextlib.redirect_stderr(stderr_buffer):
            result = action()
    return result, stdout_buffer.retained_value(), stderr_buffer.retained_value()


def captured_stdio_warning(operation: str, stdout_text: str, stderr_text: str) -> str | None:
    parts = []
    if stdout_text:
        parts.append(
            f"stdout={truncate_utf8_text(stdout_text, CAPTURED_OUTPUT_PREVIEW_BYTE_LIMIT)!r}"
        )
    if stderr_text:
        parts.append(
            f"stderr={truncate_utf8_text(stderr_text, CAPTURED_OUTPUT_PREVIEW_BYTE_LIMIT)!r}"
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

    if type(value) is bool:
        return value

    if type(value) is int:
        if value.bit_length() <= TABLE_PREVIEW_MAX_INTEGER_BITS:
            return value
        return {
            "kind": "integer",
            "value": f"<large integer omitted: {value.bit_length()} bits>",
        }

    if type(value) is str:
        return truncate_utf8_text(value, TABLE_PREVIEW_CELL_TEXT_BYTE_LIMIT)

    if type(value) is float:
        if not math.isfinite(value):
            return {"kind": "repr", "value": repr(value)}
        return value

    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return {
                "kind": "datetime",
                "value": truncate_utf8_text(
                    str(isoformat()),
                    TABLE_PREVIEW_CELL_TEXT_BYTE_LIMIT,
                ),
            }
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

    return {
        "kind": "repr",
        "value": truncate_utf8_text(text, TABLE_PREVIEW_CELL_TEXT_BYTE_LIMIT),
    }


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

    return _pandas_table_payload(
        frame,
        frame.iloc[:TABLE_PREVIEW_MAX_ROWS, :TABLE_PREVIEW_MAX_COLUMNS],
    )


def _pandas_table_payload(frame: Any, sliced: Any) -> dict[str, Any]:
    row_count, column_count = frame.shape
    return {
        "columns": [
            {
                "name": truncate_utf8_text(
                    str(column),
                    TABLE_PREVIEW_METADATA_TEXT_BYTE_LIMIT,
                ),
                "dtype": truncate_utf8_text(
                    str(dtype),
                    TABLE_PREVIEW_METADATA_TEXT_BYTE_LIMIT,
                ),
            }
            for column, dtype in zip(sliced.columns, sliced.dtypes)
        ],
        "index": [table_cell_preview(item) for item in sliced.index.tolist()],
        "indexLabel": "index",
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
    rows = [[table_cell_preview(item) for item in row] for row in sliced.iter_rows()]

    return {
        "columns": [
            {
                "name": truncate_utf8_text(
                    str(column),
                    TABLE_PREVIEW_METADATA_TEXT_BYTE_LIMIT,
                ),
                "dtype": truncate_utf8_text(
                    str(dtype_by_column[column]),
                    TABLE_PREVIEW_METADATA_TEXT_BYTE_LIMIT,
                ),
            }
            for column in sliced.columns
        ],
        "index": list(range(len(rows))),
        "indexLabel": "row",
        "rows": rows,
        "rowCount": row_count,
        "columnCount": column_count,
        "truncated": row_count > TABLE_PREVIEW_MAX_ROWS or column_count > TABLE_PREVIEW_MAX_COLUMNS,
    }


def query_table_preview(
    value: Any,
    *,
    offset: int,
    sort: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, int]:
    """Return one bounded table page without mutating the retained object."""

    if type(offset) is not int or offset < 0:
        raise ValueError("Table offset must be a non-negative integer.")
    normalized_sort = _validate_table_sort(sort)

    pandas_result = _query_pandas_table(value, offset, normalized_sort)
    if pandas_result is not None:
        return pandas_result

    polars_result = _query_polars_table(value, offset, normalized_sort)
    if polars_result is not None:
        return polars_result

    return None, 0


def _validate_table_sort(sort: dict[str, Any] | None) -> dict[str, Any] | None:
    if sort is None:
        return None
    if not isinstance(sort, dict):
        raise ValueError("Table sort must be an object.")
    kind = sort.get("kind")
    descending = sort.get("descending")
    if kind not in {"index", "column"} or type(descending) is not bool:
        raise ValueError("Table sort requires a valid target and direction.")
    if kind == "column":
        column_index = sort.get("columnIndex")
        if type(column_index) is not int or column_index < 0:
            raise ValueError("Column sorting requires a non-negative column index.")
        return {
            "kind": "column",
            "columnIndex": column_index,
            "descending": descending,
        }
    return {"kind": "index", "descending": descending}


def _resolved_table_offset(offset: int, row_count: int) -> int:
    if row_count <= 0:
        return 0
    last_page_offset = ((row_count - 1) // TABLE_PREVIEW_MAX_ROWS) * TABLE_PREVIEW_MAX_ROWS
    return min(offset, last_page_offset)


def _query_pandas_table(
    value: Any,
    offset: int,
    sort: dict[str, Any] | None,
) -> tuple[dict[str, Any], int] | None:
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

    ordered = frame
    if sort is not None:
        descending = sort["descending"]
        if sort["kind"] == "index":
            ordered = frame.sort_index(ascending=not descending, kind="mergesort")
        else:
            column_index = sort["columnIndex"]
            if column_index >= frame.shape[1]:
                raise ValueError("The selected sort column is no longer available.")
            positions = (
                frame.iloc[:, column_index]
                .reset_index(drop=True)
                .sort_values(
                    ascending=not descending,
                    kind="mergesort",
                    na_position="last",
                )
                .index.tolist()
            )
            ordered = frame.iloc[positions]

    row_count = ordered.shape[0]
    resolved_offset = _resolved_table_offset(offset, row_count)
    sliced = ordered.iloc[
        resolved_offset : resolved_offset + TABLE_PREVIEW_MAX_ROWS,
        :TABLE_PREVIEW_MAX_COLUMNS,
    ]
    return _pandas_table_payload(ordered, sliced), resolved_offset


def _query_polars_table(
    value: Any,
    offset: int,
    sort: dict[str, Any] | None,
) -> tuple[dict[str, Any], int] | None:
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

    source_row_name = "__rowcall_source_row__"
    while source_row_name in frame.columns:
        source_row_name += "_"
    ordered = frame.with_row_index(source_row_name)
    if sort is not None:
        if sort["kind"] == "index":
            sort_column = source_row_name
        else:
            column_index = sort["columnIndex"]
            if column_index >= frame.shape[1]:
                raise ValueError("The selected sort column is no longer available.")
            sort_column = frame.columns[column_index]
        ordered = ordered.sort(
            sort_column,
            descending=sort["descending"],
            nulls_last=True,
            maintain_order=True,
        )

    row_count, column_count = frame.shape
    resolved_offset = _resolved_table_offset(offset, row_count)
    page = ordered.slice(resolved_offset, TABLE_PREVIEW_MAX_ROWS)
    columns = frame.columns[:TABLE_PREVIEW_MAX_COLUMNS]
    data_page = page.select(columns) if columns else page.select([])
    dtype_by_column = dict(zip(frame.columns, frame.dtypes))
    rows = [[table_cell_preview(item) for item in row] for row in data_page.iter_rows()]
    table = {
        "columns": [
            {
                "name": truncate_utf8_text(
                    str(column),
                    TABLE_PREVIEW_METADATA_TEXT_BYTE_LIMIT,
                ),
                "dtype": truncate_utf8_text(
                    str(dtype_by_column[column]),
                    TABLE_PREVIEW_METADATA_TEXT_BYTE_LIMIT,
                ),
            }
            for column in columns
        ],
        "index": [table_cell_preview(item) for item in page.get_column(source_row_name).to_list()],
        "indexLabel": "row",
        "rows": rows,
        "rowCount": row_count,
        "columnCount": column_count,
        "truncated": row_count > len(rows) or column_count > len(columns),
    }
    return table, resolved_offset


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

    repr_text = truncate_utf8_text(repr_text, REPR_PREVIEW_BYTE_LIMIT)

    preview: dict[str, Any] = {
        "name": truncate_utf8_text(name, PREVIEW_IDENTITY_BYTE_LIMIT),
        "type": truncate_utf8_text(
            f"{type(value).__module__}.{type(value).__qualname__}",
            PREVIEW_IDENTITY_BYTE_LIMIT,
        ),
        "repr": repr_text,
    }

    table_preview = None
    table_warning = None
    try:
        table_preview, stdout_text, stderr_text = run_with_captured_stdio(
            lambda: make_table_preview(value)
        )
        table_warning = captured_stdio_warning(
            f"Table preview for '{name}'",
            stdout_text,
            stderr_text,
        )
    except Exception:
        # Table previews are optional telemetry and must not fail execution.
        pass
    if table_preview is not None:
        preview["table"] = table_preview

    combined_warning = combine_warnings(warning, stdio_warning, table_warning)
    if combined_warning:
        preview["warning"] = truncate_utf8_text(
            combined_warning,
            PREVIEW_WARNING_BYTE_LIMIT,
        )

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
                return copied, _bounded_copy_warning(
                    combine_warnings(predicate_warning, copier_warning)
                )
        except Exception as exc:
            return value, _bounded_copy_warning(
                f"Could not copy input '{name}' with {label}; passed by reference: {exc}"
            )

    try:
        copied, stdout_text, stderr_text = run_with_captured_stdio(lambda: copy.deepcopy(value))
        return copied, _bounded_copy_warning(
            captured_stdio_warning(
                f"Deepcopy for input '{name}'",
                stdout_text,
                stderr_text,
            )
        )
    except Exception as exc:
        return value, _bounded_copy_warning(
            f"Could not deepcopy input '{name}'; passed by reference: {exc}"
        )


def _bounded_copy_warning(warning: str | None) -> str | None:
    if warning is None:
        return None
    return truncate_utf8_text(warning, COPY_WARNING_BYTE_LIMIT)
