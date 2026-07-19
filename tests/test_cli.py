from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from nodebook.cli import main


REPO_ROOT = Path(__file__).resolve().parents[1]


class CliTests(unittest.TestCase):
    def test_help_accepts_standard_flags(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = main(["--help"], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 0)
        self.assertIn("nodebook run <folder-or-document.py>", stdout.getvalue())
        self.assertEqual(stderr.getvalue(), "")

    def test_validate_success_json(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = main(
            ["validate", str(REPO_ROOT / "examples/hello_world.py"), "--json"],
            stdout=stdout,
            stderr=stderr,
        )

        self.assertEqual(exit_code, 0, stderr.getvalue())
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["command"], "validate")
        self.assertEqual(payload["summary"]["nodeCount"], 2)
        self.assertEqual(stderr.getvalue(), "")

    def test_validate_folder_path_resolves_to_graph_py(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "graph.py"
            path.write_text(
                """
from nodebook import node

@node(id="n_start", outputs=["value"])
def start():
    value = 1
    return {"value": value}
""".lstrip()
            )
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = main(
                ["validate", directory, "--json"], stdout=stdout, stderr=stderr
            )

        self.assertEqual(exit_code, 0, stderr.getvalue())
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["documentPath"].endswith("graph.py"))

    def test_validate_failure_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.py"
            path.write_text(
                """
from nodebook import node

@node(id="a", outputs=["value"])
def first():
    value = 1
    return {"value": value}

@node(id="a", outputs=["other"])
def second():
    other = 2
    return {"other": other}
""".lstrip()
            )
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = main(
                ["validate", str(path), "--json"], stdout=stdout, stderr=stderr
            )

        self.assertEqual(exit_code, 1)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["command"], "validate")
        self.assertIn("issues", payload)
        self.assertIn(
            "duplicate_node_id", [issue["kind"] for issue in payload["issues"]]
        )
        self.assertEqual(stderr.getvalue(), "")

    def test_validate_rejects_inline_return_expression_with_precise_fix(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad_return.py"
            path.write_text(
                """
from nodebook import node

@node(id="total", outputs=["total"])
def total_numbers(numbers):
    return {"total": sum(numbers)}
""".lstrip()
            )
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = main(
                ["validate", str(path), "--json"], stdout=stdout, stderr=stderr
            )

        self.assertEqual(exit_code, 1)
        self.assertEqual(stderr.getvalue(), "")
        payload = json.loads(stdout.getvalue())
        issue = next(
            issue for issue in payload["issues"]
            if issue["kind"] == "invalid_node_return"
        )
        self.assertEqual(issue["nodeId"], "total")
        self.assertIn("same-named variable 'total'", issue["message"])
        self.assertIn("not the expression 'sum(numbers)'", issue["message"])
        self.assertIn("nodebook help format", issue["message"])

    def test_run_console_prints_precise_return_validation_issue(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad_return.py"
            path.write_text(
                """
from nodebook import node

@node(id="total", outputs=["total"])
def total_numbers():
    return {"total": 1}
""".lstrip()
            )
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = main(["run", str(path)], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("invalid_node_return", stderr.getvalue())
        self.assertIn("not the expression '1'", stderr.getvalue())
        self.assertIn("nodebook help format", stderr.getvalue())

    def test_run_success_json_with_python_module_entrypoint(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "nodebook",
                "run",
                str(REPO_ROOT / "examples/hello_world.py"),
                "--json",
            ],
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["command"], "run")
        self.assertEqual(
            payload["response"]["executedNodeIds"], ["n_load", "n_shout"]
        )
        self.assertEqual(
            payload["response"]["finalOutputsByNode"]["n_shout"]["message"][
                "jsonValue"
            ],
            "HELLO!",
        )

    def test_run_folder_path_resolves_to_graph_py(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "graph.py"
            path.write_text(
                """
from nodebook import node

@node(id="n_start", outputs=["value"])
def start():
    value = 2
    return {"value": value}
""".lstrip()
            )
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = main(
                ["run", directory, "--json"], stdout=stdout, stderr=stderr
            )

        self.assertEqual(exit_code, 0, stderr.getvalue())
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["documentPath"].endswith("graph.py"))
        self.assertEqual(
            payload["response"]["finalOutputsByNode"]["n_start"]["value"]["jsonValue"],
            2,
        )

    def test_run_missing_module_json_is_structured(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.py"
            path.write_text(
                """
import definitely_missing_nodebook_cli_json_package
from nodebook import node

@node(id="first", outputs=["x"])
def first():
    x = 1
    return {"x": x}
""".lstrip()
            )
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = main(["run", str(path), "--json"], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 1)
        self.assertEqual(stderr.getvalue(), "")
        payload = json.loads(stdout.getvalue())
        error = payload["response"]["error"]
        self.assertEqual(error["kind"], "missing_module")
        self.assertEqual(error["phase"], "document_globals")
        self.assertEqual(
            error["missingModule"],
            "definitely_missing_nodebook_cli_json_package",
        )
        self.assertEqual(error["pythonExecutable"], sys.executable)

    def test_run_missing_module_console_output_is_actionable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.py"
            path.write_text(
                """
import definitely_missing_nodebook_cli_console_package
from nodebook import node

@node(id="first", outputs=["x"])
def first():
    x = 1
    return {"x": x}
""".lstrip()
            )
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = main(["run", str(path)], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout.getvalue(), "")
        console_error = stderr.getvalue()
        self.assertIn("FAILED run document", console_error)
        self.assertIn(
            "Missing Python package while loading document globals: "
            "definitely_missing_nodebook_cli_console_package",
            console_error,
        )
        self.assertIn(f"Python used: {sys.executable}", console_error)
        self.assertIn("Run Nodebook with a Python environment", console_error)
        self.assertNotIn("Traceback", console_error)

    def test_run_missing_module_console_trace_includes_traceback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.py"
            path.write_text(
                """
import definitely_missing_nodebook_cli_trace_package
from nodebook import node

@node(id="first", outputs=["x"])
def first():
    x = 1
    return {"x": x}
""".lstrip()
            )
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = main(["run", str(path), "--trace"], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 1)
        self.assertIn("Traceback", stderr.getvalue())

    def test_usage_failure_exits_2(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = main(["validate", "--trace", "examples/hello_world.py"], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("`validate` does not accept --trace.", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
