from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from nodebook.runtime import RuntimeSession
from nodebook.runtime.worker import run_worker


DOCUMENT_PATH = str(Path("/tmp/worker_doc.py"))
RESOLVED_DOCUMENT_PATH = str(Path(DOCUMENT_PATH).resolve())


HELLO_SOURCE = """
from nodebook import node

@node(id="hello", outputs=["message"])
def hello():
    print("hello stdout")
    return {"message": "hello"}

@node(id="world", outputs=["text"])
def world(message):
    return {"text": message + " world"}

world.depends_on(hello)
""".lstrip()


GLOBALS_SOURCE = """
from nodebook import node

PREFIX = "hello"

@node(id="hello", outputs=["message"])
def hello():
    return {"message": PREFIX}

@node(id="world", outputs=["text"])
def world(message):
    return {"text": message + " world"}

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
from nodebook import node

@node(id="same", outputs=["x"])
def first():
    return {"x": 1}

@node(id="same", outputs=["y"])
def second():
    return {"y": 2}
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

    def test_session_run_node_uses_cache_and_executes_only_target(self) -> None:
        session = RuntimeSession()

        seed = session.run_to_node(HELLO_SOURCE, DOCUMENT_PATH, "world")
        single = session.run_node(
            HELLO_SOURCE.replace('message + " world"', 'message + " again"'),
            DOCUMENT_PATH,
            "world",
        )

        self.assertTrue(seed["ok"])
        self.assertTrue(single["ok"])
        self.assertEqual(single["runType"], "run_node")
        self.assertEqual(single["executedNodeIds"], ["world"])
        self.assertNotIn("hello", single["resultsByNode"])
        self.assertEqual(single["finalOutputsByNode"]["world"]["text"]["jsonValue"], "hello again")

    def test_session_run_node_rejects_missing_or_stale_upstream_cache(self) -> None:
        session = RuntimeSession()

        missing = session.run_node(HELLO_SOURCE, DOCUMENT_PATH, "world")
        self.assertFalse(missing["ok"])
        self.assertEqual(missing["error"]["kind"], "cache_miss")
        self.assertIn("missing", missing["error"]["message"])

        seed = session.run_to_node(HELLO_SOURCE, DOCUMENT_PATH, "world")
        self.assertTrue(seed["ok"])
        stale = session.run_node(
            HELLO_SOURCE.replace('return {"message": "hello"}', 'return {"message": "hi"}'),
            DOCUMENT_PATH,
            "world",
        )
        self.assertFalse(stale["ok"])
        self.assertEqual(stale["error"]["kind"], "cache_miss")
        self.assertIn("stale", stale["error"]["message"])
        self.assertIn("node hello", stale["error"]["message"])

    def test_session_run_node_rejects_stale_upstream_cache_after_globals_only_edit(self) -> None:
        session = RuntimeSession()

        seed = session.run_to_node(GLOBALS_SOURCE, DOCUMENT_PATH, "world")
        stale = session.run_node(
            GLOBALS_SOURCE.replace('PREFIX = "hello"', 'PREFIX = "hi"'),
            DOCUMENT_PATH,
            "world",
        )

        self.assertTrue(seed["ok"])
        self.assertFalse(stale["ok"])
        self.assertEqual(stale["error"]["kind"], "cache_miss")
        self.assertIn("stale", stale["error"]["message"])
        self.assertIn("node hello", stale["error"]["message"])

    def test_session_clear_cache_reports_cleared_entries(self) -> None:
        session = RuntimeSession()
        seed = session.run_to_node(HELLO_SOURCE, DOCUMENT_PATH, "world")

        self.assertTrue(seed["ok"])
        self.assertEqual(session.clear_session_cache(), {"ok": True, "clearedEntries": 2})
        self.assertEqual(session.clear_session_cache(), {"ok": True, "clearedEntries": 0})

    def test_worker_run_node_emits_single_node_events(self) -> None:
        session = RuntimeSession()
        seed = session.run_to_node(HELLO_SOURCE, DOCUMENT_PATH, "world")
        self.assertTrue(seed["ok"])

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
            ["run_started", "run_plan", "node_started", "node_completed", "run_completed"],
        )
        self.assertEqual(events[1]["plan"]["steps"], [{"nodeId": "world", "dependsOn": ["hello"]}])
        self.assertEqual(events[2]["nodeId"], "world")
        self.assertEqual(events[3]["result"]["outputs"]["text"]["jsonValue"], "hello world")
        self.assertEqual(events[-1]["response"]["runType"], "run_node")
        self.assertEqual(events[-1]["response"]["executedNodeIds"], ["world"])

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

    def test_worker_shutdown_returns_event_and_exits(self) -> None:
        events = self.run_lines([request("shutdown", request_id="bye")])

        self.assertEqual(events, [{"id": "bye", "ok": True, "protocolVersion": 1, "type": "shutdown"}])

    def test_worker_module_subprocess_shutdown(self) -> None:
        process = subprocess.run(
            [sys.executable, "-m", "nodebook.runtime.worker"],
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
