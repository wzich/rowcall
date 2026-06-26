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

    def test_validate_failure_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.py"
            path.write_text(
                """
from nodebook import node

@node(id="a", outputs=["value"])
def first():
    return {"value": 1}

@node(id="a", outputs=["other"])
def second():
    return {"other": 2}
""".lstrip()
            )
            stdout = io.StringIO()
            stderr = io.StringIO()

            exit_code = main(["validate", str(path), "--json"], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 1)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["command"], "validate")
        self.assertIn("issues", payload)
        self.assertIn("duplicate_node_id", [issue["kind"] for issue in payload["issues"]])
        self.assertEqual(stderr.getvalue(), "")

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
        self.assertEqual(payload["response"]["executedNodeIds"], ["n_load", "n_shout"])
        self.assertEqual(payload["response"]["finalOutputsByNode"]["n_shout"]["message"]["jsonValue"], "HELLO!")

    def test_usage_failure_exits_2(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = main(["validate", "--trace", "examples/hello_world.py"], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("`validate` does not accept --trace.", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
