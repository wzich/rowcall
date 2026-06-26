from __future__ import annotations

import io
import json
import subprocess
import sys
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

        self.assertEqual([event["type"] for event in events], ["run_started", "run_plan", "run_completed"])
        completed = events[-1]
        self.assertTrue(completed["ok"])
        response = completed["response"]
        self.assertEqual(response["executedNodeIds"], ["hello", "world"])
        self.assertEqual(response["resultsByNode"]["hello"]["stdout"], "hello stdout\n")
        self.assertEqual(response["finalOutputsByNode"]["world"]["text"]["jsonValue"], "hello world")

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

    def run_lines(self, requests: list[dict]) -> list[dict]:
        return self.run_raw_lines([json.dumps(item) for item in requests])

    def run_raw_lines(self, lines: list[str]) -> list[dict]:
        input_stream = io.StringIO("\n".join(lines) + "\n")
        output_stream = io.StringIO()

        exit_code = run_worker(input_stream, output_stream)

        self.assertEqual(exit_code, 0)
        return [json.loads(line) for line in output_stream.getvalue().splitlines()]


if __name__ == "__main__":
    unittest.main()
