from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

from nodebook.runtime import run_document, run_source


class RuntimeExecutorTests(unittest.TestCase):
    def test_runs_hello_world_chain(self) -> None:
        source = """
from nodebook import node

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

        result = run_source(source, Path("/tmp/hello.py"))

        self.assertTrue(result["ok"])
        self.assertEqual(result["executedNodeIds"], ["hello", "world"])
        self.assertEqual(
            result["finalOutputsByNode"]["world"]["text"]["jsonValue"],
            "hello world",
        )
        json.dumps(result)

    def test_target_run_by_node_id_and_function_name(self) -> None:
        source = """
from nodebook import node

@node(id="a", outputs=["x"])
def first():
    return {"x": 1}

@node(id="b", outputs=["y"])
def second(x):
    return {"y": x + 1}

@node(id="c", outputs=["z"])
def third(y):
    return {"z": y + 1}

second.depends_on(first)
third.depends_on(second)
""".lstrip()

        by_id = run_source(source, Path("/tmp/target.py"), target="b")
        by_function = run_source(source, Path("/tmp/target.py"), target="second")

        self.assertTrue(by_id["ok"])
        self.assertEqual(by_id["runType"], "run_to_node")
        self.assertEqual(by_id["targetNodeId"], "b")
        self.assertEqual(by_id["executedNodeIds"], ["a", "b"])
        self.assertEqual(by_function["executedNodeIds"], ["a", "b"])

    def test_scopes_cwd_file_and_sibling_imports_to_document_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            document_path = root / "doc.py"
            (root / "data.txt").write_text("relative-data")
            (root / "helper.py").write_text("VALUE = 'imported-data'\n")
            document_path.write_text(
                """
from nodebook import node

@node(id="load", outputs=["payload"])
def load():
    from pathlib import Path
    from helper import VALUE
    payload = {
        "file": Path(__file__).name,
        "text": Path("data.txt").read_text(),
        "imported": VALUE,
    }
    return {"payload": payload}
""".lstrip()
            )

            previous_cwd = Path.cwd()
            previous_path = list(sys.path)
            result = run_document(document_path)

        self.assertTrue(result["ok"])
        payload = result["finalOutputsByNode"]["load"]["payload"]["jsonValue"]
        self.assertEqual(
            payload,
            {"file": "doc.py", "text": "relative-data", "imported": "imported-data"},
        )
        self.assertEqual(Path.cwd(), previous_cwd)
        self.assertEqual(sys.path, previous_path)

    def test_document_globals_execute_once_per_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            counter_path = root / "counter.txt"
            document_path = root / "doc.py"
            document_path.write_text(
                """
from pathlib import Path
from nodebook import node

COUNTER = Path("counter.txt")
previous = int(COUNTER.read_text()) if COUNTER.exists() else 0
COUNTER.write_text(str(previous + 1))

@node(id="first", outputs=["x"])
def first():
    return {"x": previous + 1}

@node(id="second", outputs=["y"])
def second(x):
    return {"y": x + 1}

second.depends_on(first)
""".lstrip()
            )

            result = run_document(document_path)

            self.assertTrue(result["ok"])
            self.assertEqual(counter_path.read_text(), "1")
            self.assertEqual(result["finalOutputsByNode"]["second"]["y"]["jsonValue"], 2)

    def test_missing_module_in_document_globals_is_classified(self) -> None:
        source = """
import definitely_missing_nodebook_globals_package
from nodebook import node

@node(id="first", outputs=["x"])
def first():
    return {"x": 1}
""".lstrip()

        result = run_source(source, Path("/tmp/missing_globals.py"))

        self.assertFalse(result["ok"])
        self.assertEqual(result["executedNodeIds"], [])
        self.assertEqual(result["error"]["kind"], "missing_module")
        self.assertEqual(result["error"]["phase"], "document_globals")
        self.assertEqual(
            result["error"]["missingModule"],
            "definitely_missing_nodebook_globals_package",
        )
        self.assertEqual(result["error"]["pythonExecutable"], sys.executable)

    def test_missing_module_in_node_execution_is_classified(self) -> None:
        source = """
from nodebook import node

@node(id="first", outputs=["x"])
def first():
    import definitely_missing_nodebook_node_package
    return {"x": 1}
""".lstrip()

        result = run_source(source, Path("/tmp/missing_node.py"))

        self.assertFalse(result["ok"])
        self.assertEqual(result["executedNodeIds"], ["first"])
        self.assertEqual(result["error"]["kind"], "missing_module")
        self.assertEqual(result["error"]["phase"], "node_execution")
        self.assertEqual(result["error"]["nodeId"], "first")
        self.assertEqual(
            result["error"]["missingModule"],
            "definitely_missing_nodebook_node_package",
        )
        node_error = result["resultsByNode"]["first"]["errorDetails"]
        self.assertEqual(node_error["kind"], "missing_module")

    def test_captures_stdout_and_display(self) -> None:
        source = """
from nodebook import display, node

@node(id="talk", outputs=["value"])
def talk():
    print("hello stdout")
    display({"seen": True})
    return {"value": 3}
""".lstrip()

        result = run_source(source, Path("/tmp/display.py"), trace=True)

        self.assertTrue(result["ok"])
        node_result = result["resultsByNode"]["talk"]
        self.assertEqual(node_result["stdout"], "hello stdout\n")
        self.assertEqual(node_result["displays"][0]["value"]["jsonValue"], {"seen": True})
        self.assertEqual(node_result["outputEvents"][0]["kind"], "stdout")
        self.assertEqual(node_result["outputEvents"][1]["kind"], "display")
        self.assertEqual(result["trace"][0]["stdout"], "hello stdout\n")

    def test_fails_when_declared_output_is_missing(self) -> None:
        source = """
from nodebook import node

@node(id="bad", outputs=["value"])
def bad():
    return {}
""".lstrip()

        result = run_source(source, Path("/tmp/bad.py"))

        self.assertFalse(result["ok"])
        self.assertEqual(result["executedNodeIds"], ["bad"])
        self.assertEqual(result["error"]["nodeId"], "bad")
        self.assertIn("declared outputs", result["resultsByNode"]["bad"]["error"])


if __name__ == "__main__":
    unittest.main()
