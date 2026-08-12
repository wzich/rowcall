from __future__ import annotations

import io
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from rowcall.runtime import RuntimeSession
from rowcall.runtime.worker import run_worker


DOCUMENT_PATH = str(Path("/tmp/worker_doc.py"))
RESOLVED_DOCUMENT_PATH = str(Path(DOCUMENT_PATH).resolve())


HELLO_SOURCE = """
from rowcall import node

@node(id="hello", outputs=["message"])
def hello():
    print("hello stdout")
    message = "hello"
    return {"message": message}

@node(id="world", outputs=["text"])
def world(message):
    text = message + " world"
    return {"text": text}

world.depends_on(hello)
""".lstrip()


def request(operation: str, payload: dict | None = None, request_id: str = "r1") -> dict:
    return {
        "protocolVersion": 1,
        "id": request_id,
        "operation": operation,
        "payload": {} if payload is None else payload,
    }


class RuntimeWorkerTests(unittest.TestCase):
    def test_session_validate_and_plan_target(self) -> None:
        session = RuntimeSession()

        validation = session.validate_source(HELLO_SOURCE, DOCUMENT_PATH)
        plan = session.plan_run(HELLO_SOURCE, DOCUMENT_PATH, target="world")

        self.assertTrue(validation["ok"])
        self.assertEqual(validation["documentPath"], RESOLVED_DOCUMENT_PATH)
        self.assertTrue(plan["ok"])
        self.assertEqual(plan["targetNodeId"], "world")
        self.assertEqual(
            plan["plan"]["steps"],
            [
                {"nodeId": "hello", "dependsOn": []},
                {"nodeId": "world", "dependsOn": ["hello"]},
            ],
        )

    def test_worker_validate_source_success(self) -> None:
        events = self.run_lines(
            [
                request(
                    "validate_source",
                    {"source": HELLO_SOURCE, "documentPath": DOCUMENT_PATH},
                )
            ]
        )

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "validate_source_completed")
        self.assertEqual(events[0]["protocolVersion"], 1)
        self.assertTrue(events[0]["ok"])
        self.assertEqual(events[0]["issues"], [])

    def test_worker_load_document_reads_path_and_returns_app_document(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            document_path = Path(directory) / "graph.py"
            document_path.write_text(HELLO_SOURCE)

            events = self.run_lines(
                [
                    request(
                        "load_document",
                        {"documentPath": str(document_path)},
                    )
                ]
            )

        self.assertEqual(events[0]["type"], "load_document_completed")
        self.assertTrue(events[0]["ok"])
        self.assertEqual(events[0]["issues"], [])
        self.assertEqual(events[0]["documentPath"], str(document_path.resolve()))
        document = events[0]["document"]
        self.assertEqual(document["version"], 1)
        self.assertEqual(document["readOnly"], False)
        self.assertEqual(document["nodes"][0]["id"], "hello")
        self.assertEqual(
            document["edges"],
            [{"fromNode": "hello", "toNode": "world"}],
        )
        self.assertNotIn("path", document)
        self.assertNotIn("issues", document)
        self.assertNotIn("functionSource", document["nodes"][0])

    def test_worker_inspect_source_returns_app_document(self) -> None:
        events = self.run_lines(
            [
                request(
                    "inspect_source",
                    {"source": HELLO_SOURCE, "documentPath": DOCUMENT_PATH},
                )
            ]
        )

        self.assertEqual(events[0]["type"], "inspect_source_completed")
        self.assertTrue(events[0]["ok"])
        self.assertEqual(events[0]["issues"], [])
        self.assertEqual(events[0]["documentPath"], RESOLVED_DOCUMENT_PATH)
        document = events[0]["document"]
        self.assertEqual(document["version"], 1)
        self.assertEqual(document["readOnly"], False)
        self.assertEqual(
            [node["id"] for node in document["nodes"]],
            ["hello", "world"],
        )
        self.assertEqual(
            document["edges"],
            [{"fromNode": "hello", "toNode": "world"}],
        )

    def test_worker_render_source_echoes_valid_source_and_document(self) -> None:
        events = self.run_lines(
            [
                request(
                    "render_source",
                    {"source": HELLO_SOURCE, "documentPath": DOCUMENT_PATH},
                )
            ]
        )

        self.assertEqual(events[0]["type"], "render_source_completed")
        self.assertTrue(events[0]["ok"])
        self.assertEqual(events[0]["source"], HELLO_SOURCE)
        self.assertEqual(events[0]["document"]["readOnly"], False)

    def test_worker_validate_candidate_source_reports_validation_issues(self) -> None:
        candidate_source = """
from rowcall import node

@node(id="same", outputs=["x"])
def first():
    x = 1
    return {"x": x}

@node(id="same", outputs=["y"])
def second():
    y = 2
    return {"y": y}
""".lstrip()

        events = self.run_lines(
            [
                request(
                    "validate_candidate_source",
                    {"source": candidate_source, "documentPath": DOCUMENT_PATH},
                )
            ]
        )

        self.assertEqual(events[0]["type"], "validate_candidate_source_completed")
        self.assertFalse(events[0]["ok"])
        self.assertEqual(events[0]["issues"][0]["kind"], "duplicate_node_id")
        self.assertNotIn("document", events[0])

    def test_worker_apply_operations_returns_completed_event(self) -> None:
        editable_source = """
from rowcall import node

@node(id="hello", outputs=["message"])
def hello():
    message = "hello"
    return {"message": message}

@node(id="world", outputs=["text"])
def world(message):
    text = message + " world"
    return {"text": text}

world.depends_on(hello)
""".lstrip()

        events = self.run_lines(
            [
                request(
                    "apply_operations",
                    {
                        "source": editable_source,
                        "documentPath": DOCUMENT_PATH,
                        "operations": [
                            {
                                "type": "update_node_body",
                                "nodeId": "world",
                                "bodyCode": 'text = message + " applied"',
                            }
                        ],
                        "sidecarMetadata": {"nodes": {"world": {"title": "World"}}},
                    },
                )
            ]
        )

        self.assertEqual(events[0]["type"], "apply_operations_completed")
        self.assertTrue(events[0]["ok"], events[0]["issues"])
        self.assertIn('text = message + " applied"', events[0]["source"])
        self.assertEqual(events[0]["sidecarMetadata"], {"nodes": {"world": {"title": "World"}}})
        self.assertEqual(events[0]["document"]["nodes"][1]["code"], 'text = message + " applied"')

    def test_worker_plan_run_target(self) -> None:
        events = self.run_lines(
            [
                request(
                    "plan_run",
                    {"source": HELLO_SOURCE, "documentPath": DOCUMENT_PATH, "target": "world"},
                )
            ]
        )

        self.assertEqual(events[0]["type"], "plan_run_completed")
        self.assertTrue(events[0]["ok"])
        self.assertEqual(events[0]["targetNodeId"], "world")
        self.assertEqual([step["nodeId"] for step in events[0]["plan"]["steps"]], ["hello", "world"])

    def test_worker_run_graph_hello_world_keeps_stdout_in_result(self) -> None:
        events = self.run_lines(
            [
                request(
                    "run_graph",
                    {"source": HELLO_SOURCE, "documentPath": DOCUMENT_PATH},
                )
            ]
        )

        event_types = [event["type"] for event in events]
        self.assertEqual(event_types[:2], ["run_started", "run_plan"])
        self.assertEqual(
            event_types[2:-1],
            ["node_started", "node_completed", "node_started", "node_completed"],
        )
        self.assertEqual(event_types[-1], "run_completed")
        completed = events[-1]
        self.assertTrue(completed["ok"])
        response = completed["response"]
        self.assertEqual(response["executedNodeIds"], ["hello", "world"])
        self.assertEqual(response["resultsByNode"]["hello"]["stdout"], "hello stdout\n")
        self.assertEqual(response["finalOutputsByNode"]["world"]["text"]["jsonValue"], "hello world")

    def test_worker_run_graph_writes_node_events_during_execution(self) -> None:
        output_stream = io.StringIO()

        class LiveEventSession(RuntimeSession):
            output_after_node_started = ""

            def plan_run(self, source, document_path, target=None):
                return {
                    "ok": True,
                    "documentPath": RESOLVED_DOCUMENT_PATH,
                    "targetNodeId": "slow",
                    "plan": {
                        "targetNodeIds": ["slow"],
                        "steps": [{"nodeId": "slow", "dependsOn": []}],
                    },
                    "issues": [],
                }

            def run_graph(self, source, document_path, *, trace=False, inputs=None, on_node_event=None):
                assert on_node_event is not None
                on_node_event({"type": "node_started", "index": 0, "nodeId": "slow", "dependsOn": []})
                self.output_after_node_started = output_stream.getvalue()
                on_node_event(
                    {
                        "type": "node_completed",
                        "index": 0,
                        "nodeId": "slow",
                        "dependsOn": [],
                        "result": {"ok": True, "outputs": {}},
                    }
                )
                return {
                    "ok": True,
                    "runType": "run_graph",
                    "executedNodeIds": ["slow"],
                    "resultsByNode": {"slow": {"ok": True, "outputs": {}}},
                    "finalOutputsByNode": {},
                }

        session = LiveEventSession()
        input_stream = io.StringIO(
            json.dumps(request("run_graph", {"source": HELLO_SOURCE, "documentPath": DOCUMENT_PATH})) + "\n"
        )

        exit_code = run_worker(input_stream, output_stream, session=session)

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            [json.loads(line)["type"] for line in session.output_after_node_started.splitlines()],
            ["run_started", "run_plan", "node_started"],
        )
        self.assertEqual(
            [json.loads(line)["type"] for line in output_stream.getvalue().splitlines()],
            ["run_started", "run_plan", "node_started", "node_completed", "run_completed"],
        )

    def test_session_run_node_executes_fresh_through_upstream_nodes(self) -> None:
        session = RuntimeSession()

        single = session.run_node(
            HELLO_SOURCE.replace('message = "hello"', 'message = "fresh"'),
            DOCUMENT_PATH,
            "world",
        )

        self.assertTrue(single["ok"])
        self.assertEqual(single["runType"], "run_node")
        self.assertEqual(single["executedNodeIds"], ["hello", "world"])
        self.assertEqual(single["finalOutputsByNode"]["world"]["text"]["jsonValue"], "fresh world")

    def test_session_clear_cache_reports_that_caching_is_disabled(self) -> None:
        session = RuntimeSession()

        self.assertEqual(
            session.clear_session_cache(),
            {"ok": True, "clearedEntries": 0, "cachingDisabled": True},
        )

    def test_latest_result_store_replaces_only_after_success(self) -> None:
        session = RuntimeSession()

        first = session.run_graph(HELLO_SOURCE, DOCUMENT_PATH, run_id="run-1")
        self.assertTrue(first["ok"])
        self.assertEqual(
            first["resultStore"],
            {"runId": "run-1", "documentRevision": first["documentRevision"]},
        )
        retained = session.query_table(
            run_id="run-1",
            document_revision=first["documentRevision"],
            node_id="hello",
            output_name="message",
            offset=0,
            sort=None,
        )
        self.assertEqual(retained["error"]["kind"], "unsupported_output")

        failed = session.run_graph(
            HELLO_SOURCE.replace('message = "hello"', 'raise RuntimeError("nope")'),
            DOCUMENT_PATH,
            run_id="run-2",
        )
        self.assertFalse(failed["ok"])
        self.assertNotIn("resultStore", failed)
        still_retained = session.query_table(
            run_id="run-1",
            document_revision=first["documentRevision"],
            node_id="hello",
            output_name="message",
            offset=0,
            sort=None,
        )
        self.assertEqual(still_retained["error"]["kind"], "unsupported_output")

        second = session.run_to_node(
            HELLO_SOURCE,
            DOCUMENT_PATH,
            "hello",
            run_id="run-3",
        )
        self.assertTrue(second["ok"])
        stale = session.query_table(
            run_id="run-1",
            document_revision=first["documentRevision"],
            node_id="hello",
            output_name="message",
            offset=0,
            sort=None,
        )
        self.assertEqual(stale["error"]["kind"], "stale_result")
        missing_unexecuted = session.query_table(
            run_id="run-3",
            document_revision=second["documentRevision"],
            node_id="world",
            output_name="text",
            offset=0,
            sort=None,
        )
        self.assertEqual(missing_unexecuted["error"]["kind"], "missing_output")

    def test_table_query_captures_output_before_it_reaches_worker_stdout(self) -> None:
        session = RuntimeSession()
        result = session.run_graph(HELLO_SOURCE, DOCUMENT_PATH, run_id="run-1")

        def noisy_query(*args: object, **kwargs: object) -> tuple[dict, int]:
            del args, kwargs
            print("user-controlled protocol noise")
            return {
                "columns": [],
                "rows": [],
                "rowCount": 0,
                "columnCount": 0,
                "truncated": False,
            }, 0

        worker_stdout = io.StringIO()
        with patch("rowcall.runtime.session.query_table_preview", noisy_query):
            with redirect_stdout(worker_stdout):
                query = session.query_table(
                    run_id="run-1",
                    document_revision=result["documentRevision"],
                    node_id="hello",
                    output_name="message",
                    offset=0,
                    sort=None,
                )

        self.assertTrue(query["ok"])
        self.assertEqual(worker_stdout.getvalue(), "")

    def test_worker_table_query_rejects_stale_provenance(self) -> None:
        session = RuntimeSession()
        run_events = self.run_lines(
            [
                request(
                    "run_graph",
                    {
                        "source": HELLO_SOURCE,
                        "documentPath": DOCUMENT_PATH,
                        "runId": "published-run",
                    },
                )
            ],
            session=session,
        )
        revision = run_events[-1]["response"]["documentRevision"]

        events = self.run_lines(
            [
                request(
                    "query_table",
                    {
                        "runId": "other-run",
                        "documentRevision": revision,
                        "nodeId": "hello",
                        "outputName": "message",
                        "offset": 0,
                    },
                )
            ],
            session=session,
        )

        self.assertEqual(events[0]["type"], "table_query_completed")
        self.assertFalse(events[0]["ok"])
        self.assertEqual(events[0]["error"]["kind"], "stale_result")

    @unittest.skipUnless(importlib.util.find_spec("pandas"), "pandas is not installed")
    def test_pandas_table_query_pages_and_sorts_columns_and_index(self) -> None:
        source = """
import pandas as pd
from rowcall import node

@node(id="frame", outputs=["data"])
def frame():
    data = pd.DataFrame({"value": list(reversed(range(55)))}, index=list(reversed(range(100, 155))))
    return {"data": data}
""".lstrip()
        session = RuntimeSession()
        result = session.run_graph(source, DOCUMENT_PATH, run_id="pandas-run")
        revision = result["documentRevision"]

        second_page = session.query_table(
            run_id="pandas-run",
            document_revision=revision,
            node_id="frame",
            output_name="data",
            offset=50,
            sort=None,
        )
        self.assertTrue(second_page["ok"])
        self.assertEqual(second_page["offset"], 50)
        self.assertEqual(len(second_page["table"]["rows"]), 5)

        by_value = session.query_table(
            run_id="pandas-run",
            document_revision=revision,
            node_id="frame",
            output_name="data",
            offset=0,
            sort={"kind": "column", "columnIndex": 0, "descending": False},
        )
        self.assertEqual([row[0] for row in by_value["table"]["rows"][:3]], [0, 1, 2])
        self.assertEqual(by_value["table"]["index"][:3], [100, 101, 102])

        by_index = session.query_table(
            run_id="pandas-run",
            document_revision=revision,
            node_id="frame",
            output_name="data",
            offset=999,
            sort={"kind": "index", "descending": False},
        )
        self.assertEqual(by_index["offset"], 50)
        self.assertEqual(by_index["table"]["index"], [150, 151, 152, 153, 154])

    @unittest.skipUnless(importlib.util.find_spec("polars"), "polars is not installed")
    def test_polars_table_query_preserves_source_rows_while_sorting(self) -> None:
        source = """
import polars as pl
from rowcall import node

@node(id="frame", outputs=["data"])
def frame():
    data = pl.DataFrame({"value": list(reversed(range(55)))})
    return {"data": data}
""".lstrip()
        session = RuntimeSession()
        result = session.run_graph(source, DOCUMENT_PATH, run_id="polars-run")
        revision = result["documentRevision"]

        by_value = session.query_table(
            run_id="polars-run",
            document_revision=revision,
            node_id="frame",
            output_name="data",
            offset=0,
            sort={"kind": "column", "columnIndex": 0, "descending": False},
        )
        self.assertTrue(by_value["ok"])
        self.assertEqual([row[0] for row in by_value["table"]["rows"][:3]], [0, 1, 2])
        self.assertEqual(by_value["table"]["index"][:3], [54, 53, 52])

        by_source_row = session.query_table(
            run_id="polars-run",
            document_revision=revision,
            node_id="frame",
            output_name="data",
            offset=0,
            sort={"kind": "index", "descending": True},
        )
        self.assertEqual(by_source_row["table"]["index"][:3], [54, 53, 52])
        self.assertEqual([row[0] for row in by_source_row["table"]["rows"][:3]], [0, 1, 2])

    def test_worker_run_node_emits_fresh_upstream_events(self) -> None:
        session = RuntimeSession()

        events = self.run_lines(
            [
                request(
                    "run_node",
                    {"source": HELLO_SOURCE, "documentPath": DOCUMENT_PATH, "target": "world"},
                )
            ],
            session=session,
        )

        self.assertEqual(
            [event["type"] for event in events],
            [
                "run_started",
                "run_plan",
                "node_started",
                "node_completed",
                "node_started",
                "node_completed",
                "run_completed",
            ],
        )
        self.assertEqual(
            events[1]["plan"]["steps"],
            [
                {"nodeId": "hello", "dependsOn": []},
                {"nodeId": "world", "dependsOn": ["hello"]},
            ],
        )
        self.assertEqual(events[2]["nodeId"], "hello")
        self.assertEqual(events[4]["nodeId"], "world")
        self.assertEqual(events[5]["result"]["outputs"]["text"]["jsonValue"], "hello world")
        self.assertEqual(events[-1]["response"]["runType"], "run_node")
        self.assertEqual(events[-1]["response"]["executedNodeIds"], ["hello", "world"])

    def test_worker_malformed_request_returns_error_and_continues(self) -> None:
        events = self.run_raw_lines(
            [
                "{bad json",
                json.dumps(
                    request(
                        "validate_source",
                        {"source": HELLO_SOURCE, "documentPath": DOCUMENT_PATH},
                        request_id="r2",
                    )
                ),
            ]
        )

        self.assertEqual(events[0]["type"], "error")
        self.assertEqual(events[0]["error"]["kind"], "malformed_json")
        self.assertEqual(events[1]["type"], "validate_source_completed")
        self.assertEqual(events[1]["id"], "r2")

    def test_worker_error_messages_are_bounded(self) -> None:
        events = self.run_lines([request("x" * 100_000)])

        message = events[0]["error"]["message"]
        self.assertEqual(events[0]["error"]["kind"], "unknown_operation")
        self.assertLessEqual(len(message.encode("utf-8")), 16 * 1024)
        self.assertTrue(message.endswith("[error message truncated]"))

    def test_worker_shutdown_returns_event_and_exits(self) -> None:
        events = self.run_lines([request("shutdown", request_id="bye")])

        self.assertEqual(events, [{"id": "bye", "ok": True, "protocolVersion": 1, "type": "shutdown"}])

    def test_worker_module_subprocess_shutdown(self) -> None:
        process = subprocess.run(
            [sys.executable, "-m", "rowcall.runtime.worker"],
            input=json.dumps(request("shutdown", request_id="sub")) + "\n",
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout), {"id": "sub", "ok": True, "protocolVersion": 1, "type": "shutdown"})
        self.assertEqual(process.stderr, "")

    def run_lines(self, requests: list[dict], *, session: RuntimeSession | None = None) -> list[dict]:
        return self.run_raw_lines([json.dumps(item) for item in requests], session=session)

    def run_raw_lines(self, lines: list[str], *, session: RuntimeSession | None = None) -> list[dict]:
        input_stream = io.StringIO("\n".join(lines) + "\n")
        output_stream = io.StringIO()

        exit_code = run_worker(input_stream, output_stream, session=session)

        self.assertEqual(exit_code, 0)
        return [json.loads(line) for line in output_stream.getvalue().splitlines()]


if __name__ == "__main__":
    unittest.main()
