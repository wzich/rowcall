from __future__ import annotations

import base64
import json
import sys
import types
import unittest
from unittest.mock import patch

import rowcall.runtime.previews as previews


HUGE_TEXT = "🔥" * 10_000
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class HugeText:
    def __str__(self) -> str:
        return HUGE_TEXT

    def __repr__(self) -> str:
        return HUGE_TEXT


class HugeDatetime:
    def isoformat(self) -> str:
        return HUGE_TEXT


class FailedRepr:
    def __repr__(self) -> str:
        raise RuntimeError(HUGE_TEXT)


class FailedCopy:
    def __deepcopy__(self, memo: dict) -> object:
        del memo
        raise RuntimeError(HUGE_TEXT)


class PngFigure:
    def __init__(self) -> None:
        self.calls = 0

    def _repr_png_(self) -> bytes:
        self.calls += 1
        return PNG_1X1


class BrokenPngFigure:
    def _repr_png_(self) -> bytes:
        raise RuntimeError("renderer unavailable")


class RuntimePreviewTests(unittest.TestCase):
    def assert_bounded_with_marker(self, text: str, byte_limit: int) -> None:
        self.assertLessEqual(len(text.encode("utf-8")), byte_limit)
        self.assertTrue(text.endswith(previews.TEXT_TRUNCATION_MARKER))

    def test_copy_failure_warning_is_utf8_byte_bounded(self) -> None:
        value = FailedCopy()
        with patch.object(previews, "COPY_HANDLERS", []):
            copied, warning = previews.copy_for_node_input("input", value)

        self.assertIs(copied, value)
        self.assertIsNotNone(warning)
        assert warning is not None
        self.assert_bounded_with_marker(warning, previews.COPY_WARNING_BYTE_LIMIT)

    def test_all_table_cell_text_variants_are_utf8_byte_bounded(self) -> None:
        string_cell = previews.table_cell_preview(HUGE_TEXT)
        datetime_cell = previews.table_cell_preview(HugeDatetime())
        repr_cell = previews.table_cell_preview(HugeText())
        failed_repr_cell = previews.table_cell_preview(FailedRepr())

        self.assert_bounded_with_marker(
            string_cell,
            previews.TABLE_PREVIEW_CELL_TEXT_BYTE_LIMIT,
        )
        for cell in (datetime_cell, repr_cell, failed_repr_cell):
            self.assertIsInstance(cell, dict)
            self.assert_bounded_with_marker(
                cell["value"],
                previews.TABLE_PREVIEW_CELL_TEXT_BYTE_LIMIT,
            )

    def test_table_big_integers_have_a_serializable_bounded_preview(self) -> None:
        small = previews.table_cell_preview(42)
        large = previews.table_cell_preview(10**5000)

        self.assertEqual(small, 42)
        self.assertEqual(large["kind"], "integer")
        self.assertIn("bits", large["value"])
        json.dumps(large)

    def test_text_bounds_escape_unpaired_surrogates(self) -> None:
        bounded = previews.truncate_utf8_text("before\ud800after", 100)

        self.assertEqual(bounded, "before\\ud800after")
        bounded.encode("utf-8")

    def test_pandas_and_polars_metadata_fields_are_utf8_byte_bounded(self) -> None:
        pandas_preview = self._make_fake_pandas_preview()
        polars_preview = self._make_fake_polars_preview()

        for table in (pandas_preview, polars_preview):
            self.assertIsNotNone(table)
            assert table is not None
            column = table["columns"][0]
            self.assert_bounded_with_marker(
                column["name"],
                previews.TABLE_PREVIEW_METADATA_TEXT_BYTE_LIMIT,
            )
            self.assert_bounded_with_marker(
                column["dtype"],
                previews.TABLE_PREVIEW_METADATA_TEXT_BYTE_LIMIT,
            )

    def test_pandas_preview_preserves_its_index(self) -> None:
        table = self._make_fake_pandas_preview()

        self.assertIsNotNone(table)
        assert table is not None
        self.assertEqual(table["indexLabel"], "index")
        self.assertEqual(table["index"], [previews.table_cell_preview(HUGE_TEXT)])

    def test_polars_preview_adds_source_row_numbers(self) -> None:
        table = self._make_fake_polars_preview()

        self.assertIsNotNone(table)
        assert table is not None
        self.assertEqual(table["indexLabel"], "row")
        self.assertEqual(table["index"], [0])

    def test_preview_identity_repr_and_warning_fields_are_byte_bounded(self) -> None:
        value_type = type(
            "HugeType",
            (),
            {
                "__module__": HUGE_TEXT,
                "__repr__": lambda self: HUGE_TEXT,
            },
        )

        preview = previews.preview_value(HUGE_TEXT, value_type(), warning=HUGE_TEXT)

        self.assert_bounded_with_marker(
            preview["name"],
            previews.PREVIEW_IDENTITY_BYTE_LIMIT,
        )
        self.assert_bounded_with_marker(
            preview["type"],
            previews.PREVIEW_IDENTITY_BYTE_LIMIT,
        )
        self.assert_bounded_with_marker(
            preview["repr"],
            previews.REPR_PREVIEW_BYTE_LIMIT,
        )
        self.assert_bounded_with_marker(
            preview["warning"],
            previews.PREVIEW_WARNING_BYTE_LIMIT,
        )

    def test_json_preview_accepts_an_mvp_sized_record_list(self) -> None:
        records = [
            {
                "id": index,
                "label": f"record-{index}",
                "amount": index + 0.25,
            }
            for index in range(500)
        ]

        preview = previews.make_json_preview_value(records)

        self.assertEqual(preview, records)
        self.assertGreater(
            len(json.dumps(preview).encode("utf-8")),
            16_000,
        )

    def test_json_preview_still_rejects_pathological_container_sizes(self) -> None:
        value = list(range(previews.JSON_PREVIEW_MAX_CONTAINER_ITEMS + 1))

        with self.assertRaisesRegex(ValueError, "too many container items"):
            previews.make_json_preview_value(value)

    def test_json_preview_still_enforces_its_encoded_byte_limit(self) -> None:
        value = "x" * previews.JSON_PREVIEW_BYTE_LIMIT

        with self.assertRaisesRegex(ValueError, "JSON preview too large"):
            previews.make_json_preview_value(value)

    def test_declared_view_accepts_raw_png_bytes(self) -> None:
        preview, used_bytes = previews.preview_view(
            "chart",
            PNG_1X1,
            remaining_image_bytes=previews.VIEW_PNG_RUN_MAX_BYTES,
        )

        self.assertEqual(used_bytes, len(PNG_1X1))
        self.assertEqual(preview["image"]["mimeType"], "image/png")
        self.assertEqual(preview["image"]["width"], 1)
        self.assertEqual(preview["image"]["height"], 1)
        self.assertEqual(base64.b64decode(preview["image"]["dataBase64"]), PNG_1X1)

    def test_png_hook_is_only_called_for_view_preview(self) -> None:
        figure = PngFigure()

        ordinary = previews.preview_value("figure", figure)
        rendered, used_bytes = previews.preview_view(
            "figure",
            figure,
            remaining_image_bytes=previews.VIEW_PNG_RUN_MAX_BYTES,
        )

        self.assertNotIn("image", ordinary)
        self.assertEqual(figure.calls, 1)
        self.assertEqual(used_bytes, len(PNG_1X1))
        self.assertIn("image", rendered)

    def test_png_render_failure_becomes_a_warning(self) -> None:
        preview, used_bytes = previews.preview_view(
            "chart",
            BrokenPngFigure(),
            remaining_image_bytes=previews.VIEW_PNG_RUN_MAX_BYTES,
        )

        self.assertEqual(used_bytes, 0)
        self.assertNotIn("image", preview)
        self.assertIn("Could not render view", preview["warning"])

    def test_unsupported_rich_view_falls_back_to_repr_with_warning(self) -> None:
        preview, used_bytes = previews.preview_view(
            "chart",
            object(),
            remaining_image_bytes=previews.VIEW_PNG_RUN_MAX_BYTES,
        )

        self.assertEqual(used_bytes, 0)
        self.assertNotIn("image", preview)
        self.assertIn("showing its repr only", preview["warning"])

    def test_png_view_limits_omit_image_without_failing_preview(self) -> None:
        oversized = PNG_1X1 + b"x" * previews.VIEW_PNG_MAX_BYTES

        preview, used_bytes = previews.preview_view(
            "chart",
            oversized,
            remaining_image_bytes=previews.VIEW_PNG_RUN_MAX_BYTES,
        )

        self.assertEqual(used_bytes, 0)
        self.assertNotIn("image", preview)
        self.assertIn("per-view limit", preview["warning"])

    def test_truncated_png_header_is_rejected(self) -> None:
        truncated = (
            previews.PNG_SIGNATURE
            + (13).to_bytes(4, "big")
            + b"IHDR"
            + (1).to_bytes(4, "big")
            + (1).to_bytes(4, "big")
        )

        preview, used_bytes = previews.preview_view(
            "chart",
            truncated,
            remaining_image_bytes=previews.VIEW_PNG_RUN_MAX_BYTES,
        )

        self.assertEqual(used_bytes, 0)
        self.assertNotIn("image", preview)
        self.assertIn("valid PNG", preview["warning"])

    def _make_fake_pandas_preview(self) -> dict | None:
        class FakeSeries:
            pass

        class FakeIndex:
            def tolist(self) -> list[str]:
                return [HUGE_TEXT]

        class FakeIloc:
            def __init__(self, frame: object) -> None:
                self.frame = frame

            def __getitem__(self, key: object) -> object:
                del key
                return self.frame

        class FakeFrame:
            shape = (1, 1)
            columns = [HugeText()]
            dtypes = [HugeText()]
            index = FakeIndex()

            def __init__(self) -> None:
                self.iloc = FakeIloc(self)

            def itertuples(self, *, index: bool, name: object) -> list[tuple[str]]:
                del index, name
                return [(HUGE_TEXT,)]

        fake_pandas = types.SimpleNamespace(
            DataFrame=FakeFrame,
            Series=FakeSeries,
            isna=lambda value: False,
        )
        with patch.dict(sys.modules, {"pandas": fake_pandas}):
            return previews.make_pandas_table_preview(FakeFrame())

    def _make_fake_polars_preview(self) -> dict | None:
        class FakeSeries:
            pass

        class FakeFrame:
            shape = (1, 1)
            columns = [HUGE_TEXT]
            dtypes = [HugeText()]

            def head(self, rows: int) -> FakeFrame:
                del rows
                return self

            def select(self, columns: list[str]) -> FakeFrame:
                del columns
                return self

            def iter_rows(self) -> list[tuple[str]]:
                return [(HUGE_TEXT,)]

        fake_polars = types.SimpleNamespace(DataFrame=FakeFrame, Series=FakeSeries)
        with patch.dict(sys.modules, {"polars": fake_polars}):
            return previews.make_polars_table_preview(FakeFrame())


if __name__ == "__main__":
    unittest.main()
