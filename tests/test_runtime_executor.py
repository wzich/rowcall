from __future__ import annotations

import json
import py_compile
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rowcall.runtime import RuntimeSession, run_document, run_source


class RuntimeExecutorTests(unittest.TestCase):
    def test_bytecode_cleanup_failure_stops_before_stale_import_can_run(self) -> None:
        helper_name = "rowcall_unremovable_bytecode_helper"
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                helper_path = root / f"{helper_name}.py"
                helper_path.write_text("VALUE = 'first'\n")
                source = f'''
from rowcall import node

@node(id="load", outputs=["value"])
def load():
    from {helper_name} import VALUE
    value = VALUE
    return {{"value": value}}
'''.lstrip()

                first = run_source(source, root / "doc.py")
                helper_path.write_text("VALUE = 'updated value'\n")
                with patch(
                    "rowcall.runtime.executor.Path.unlink",
                    side_effect=PermissionError("permission denied"),
                ):
                    blocked = run_source(source, root / "doc.py")
                recovered = run_source(source, root / "doc.py")

            self.assertTrue(first["ok"])
            self.assertFalse(blocked["ok"])
            self.assertEqual(blocked["error"]["kind"], "import_freshness_error")
            self.assertEqual(blocked["error"]["phase"], "runtime_preparation")
            self.assertEqual(blocked["executedNodeIds"], [])
            self.assertIn("Execution did not start", blocked["error"]["message"])
            self.assertEqual(
                recovered["finalOutputsByNode"]["load"]["value"]["jsonValue"],
                "updated value",
            )
        finally:
            sys.modules.pop(helper_name, None)

    def test_fresh_run_keeps_sourceless_local_bytecode_importable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            helper_name = "rowcall_sourceless_helper"
            helper_source = root / f"{helper_name}.py"
            helper_bytecode = root / f"{helper_name}.pyc"
            helper_source.write_text("VALUE = 'from bytecode'\n")
            py_compile.compile(
                str(helper_source),
                cfile=str(helper_bytecode),
                doraise=True,
            )
            helper_source.unlink()
            source = f'''
from rowcall import node

@node(id="load", outputs=["value"])
def load():
    from {helper_name} import VALUE
    value = VALUE
    return {{"value": value}}
'''.lstrip()

            first = run_source(source, root / "doc.py")
            second = run_source(source, root / "doc.py")

            self.assertTrue(helper_bytecode.exists())
            self.assertEqual(first["finalOutputsByNode"]["load"]["value"]["jsonValue"], "from bytecode")
            self.assertEqual(second["finalOutputsByNode"]["load"]["value"]["jsonValue"], "from bytecode")

    def test_dynamic_module_metadata_does_not_break_repeated_runs(self) -> None:
        proxy_name = "rowcall_dynamic_module_proxy"
        relative_proxy_name = "rowcall_relative_module_proxy"
        source = f'''
import sys
import types

class DynamicModule(types.ModuleType):
    def __getattr__(self, name):
        self.metadata_reads.append(name)
        if name == "__file__":
            return "_ops.py"
        if name == "__cached__":
            return object()
        raise AttributeError(name)

dynamic_proxy = DynamicModule({proxy_name!r})
dynamic_proxy.metadata_reads = []
sys.modules[{proxy_name!r}] = dynamic_proxy

relative_proxy = types.ModuleType({relative_proxy_name!r})
relative_proxy.__file__ = "_ops.py"
relative_proxy.__cached__ = object()
sys.modules[{relative_proxy_name!r}] = relative_proxy

from rowcall import node

@node(id="load", outputs=["value"])
def load():
    value = "ok"
    return {{"value": value}}
'''.lstrip()

        try:
            with tempfile.TemporaryDirectory() as directory:
                document_path = Path(directory) / "doc.py"
                session = RuntimeSession()

                first = session.run_graph(source, document_path)
                second = session.run_graph(source, document_path)

            self.assertTrue(first["ok"])
            self.assertTrue(second["ok"])
            self.assertEqual(
                second["finalOutputsByNode"]["load"]["value"]["jsonValue"],
                "ok",
            )
            self.assertEqual(sys.modules[proxy_name].metadata_reads, [])
        finally:
            sys.modules.pop(proxy_name, None)
            sys.modules.pop(relative_proxy_name, None)

    def test_document_local_module_shadows_preloaded_top_level_module(self) -> None:
        original_json_modules = {
            name: module
            for name, module in sys.modules.items()
            if name == "json" or name.startswith("json.")
        }
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                first_root = root / "first"
                second_root = root / "second"
                first_root.mkdir()
                second_root.mkdir()
                for document_root, value in (
                    (first_root, "first local json"),
                    (second_root, "second local json"),
                ):
                    package = document_root / "json"
                    package.mkdir()
                    (package / "__init__.py").write_text("")
                    (package / "decoder.py").write_text(f"VALUE = {value!r}\n")
                source = '''
from rowcall import node

@node(id="load", outputs=["value"])
def load():
    from json.decoder import VALUE
    value = VALUE
    return {"value": value}
'''.lstrip()

                first = run_source(source, first_root / "doc.py")
                second = run_source(source, second_root / "doc.py")

            self.assertEqual(
                first["finalOutputsByNode"]["load"]["value"]["jsonValue"],
                "first local json",
            )
            self.assertEqual(
                second["finalOutputsByNode"]["load"]["value"]["jsonValue"],
                "second local json",
            )
        finally:
            for name in tuple(sys.modules):
                if name == "json" or name.startswith("json."):
                    sys.modules.pop(name, None)
            sys.modules.update(original_json_modules)

    def test_namespace_package_from_previous_document_root_is_evicted(self) -> None:
        helper_name = "rowcall_namespace_helper"
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                first_root = root / "first"
                second_root = root / "second"
                first_root.mkdir()
                second_root.mkdir()
                package = first_root / helper_name
                package.mkdir()
                (package / "values.py").write_text("VALUE = 'first root'\n")
                source = f'''
from rowcall import node

@node(id="load", outputs=["value"])
def load():
    from {helper_name}.values import VALUE
    value = VALUE
    return {{"value": value}}
'''.lstrip()

                first = run_source(source, first_root / "doc.py")
                switched = run_source(source, second_root / "doc.py")

            self.assertTrue(first["ok"])
            self.assertFalse(switched["ok"])
            self.assertEqual(switched["error"]["kind"], "missing_module")
        finally:
            for name in tuple(sys.modules):
                if name == helper_name or name.startswith(f"{helper_name}."):
                    sys.modules.pop(name, None)

    def test_run_node_is_fresh_across_document_roots_and_symlinked_helpers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            external = root / "external"
            first_root = root / "first"
            second_root = root / "second"
            external.mkdir()
            first_root.mkdir()
            second_root.mkdir()
            helper_name = "rowcall_fresh_helper"
            external_helper = external / f"{helper_name}.py"
            external_helper.write_text("VALUE = 'first'\n")
            (first_root / f"{helper_name}.py").symlink_to(external_helper)
            (second_root / f"{helper_name}.py").write_text("VALUE = 'second'\n")
            source = f'''
from rowcall import node

@node(id="load", outputs=["value"])
def load():
    from {helper_name} import VALUE
    value = VALUE
    return {{"value": value}}
'''.lstrip()
            session = RuntimeSession()

            first = session.run_node(source, first_root / "doc.py", "load")
            external_helper.write_text("VALUE = 'updated'\n")
            updated = session.run_node(source, first_root / "doc.py", "load")
            switched = session.run_node(source, second_root / "doc.py", "load")

        self.assertEqual(first["finalOutputsByNode"]["load"]["value"]["jsonValue"], "first")
        self.assertEqual(updated["finalOutputsByNode"]["load"]["value"]["jsonValue"], "updated")
        self.assertEqual(switched["finalOutputsByNode"]["load"]["value"]["jsonValue"], "second")

    def test_captured_output_and_display_events_are_bounded(self) -> None:
        source = '''
from rowcall import display, node

@node(id="loud", outputs=["x"])
def loud():
    print("z" * (1024 * 1024 + 100))
    import sys
    print("e" * (1024 * 1024 + 100), file=sys.stderr)
    for value in range(105):
        display(value)
    x = 1
    return {"x": x}
'''.lstrip()
        result = run_source(source, Path("/tmp/loud.py"))

        node = result["resultsByNode"]["loud"]
        self.assertTrue(result["ok"])
        self.assertLessEqual(len(node["stdout"].encode("utf-8")), 1024 * 1024)
        self.assertLessEqual(len(node["stderr"].encode("utf-8")), 1024 * 1024)
        self.assertEqual(len(node["displays"]), 100)
        self.assertTrue(any("stdout was truncated" in item for item in node["warnings"]))
        self.assertTrue(any("stderr was truncated" in item for item in node["warnings"]))
        self.assertTrue(any("display events were truncated" in item for item in node["warnings"]))

    def test_preview_hooks_cannot_create_unbounded_telemetry(self) -> None:
        source = '''
from rowcall import node

class Noisy:
    def __repr__(self):
        print("p" * 100_000)
        return "Noisy()"

@node(id="make", outputs=["value"])
def make():
    value = Noisy()
    return {"value": value}
'''.lstrip()
        result = run_source(source, Path("/tmp/noisy_preview.py"))

        preview = result["resultsByNode"]["make"]["outputs"]["value"]
        self.assertTrue(result["ok"])
        self.assertIn("truncated", preview["warning"])
        self.assertLess(len(json.dumps(result)), 25_000)

    def test_exception_messages_are_bounded_without_losing_classification(self) -> None:
        source = '''
from rowcall import node

@node(id="bad", outputs=["value"])
def bad():
    raise RuntimeError("🔥" * 100_000)
    value = None
    return {"value": value}
'''.lstrip()

        result = run_source(source, Path("/tmp/huge_error.py"), trace=True)

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["kind"], "runtime_error")
        node_error = result["resultsByNode"]["bad"]["error"]
        response_error = result["error"]["error"]
        trace_error = result["trace"][0]["error"]
        for message in (node_error, response_error, trace_error):
            self.assertLessEqual(len(message.encode("utf-8")), 16 * 1024)
            self.assertTrue(message.endswith("[error message truncated]"))

    def test_runs_hello_world_chain(self) -> None:
        source = """
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
from rowcall import node

@node(id="a", outputs=["x"])
def first():
    x = 1
    return {"x": x}

@node(id="b", outputs=["y"])
def second(x):
    y = x + 1
    return {"y": y}

@node(id="c", outputs=["z"])
def third(y):
    z = y + 1
    return {"z": z}

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
from rowcall import node

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
from rowcall import node

COUNTER = Path("counter.txt")
previous = int(COUNTER.read_text()) if COUNTER.exists() else 0
COUNTER.write_text(str(previous + 1))

@node(id="first", outputs=["x"])
def first():
    x = previous + 1
    return {"x": x}

@node(id="second", outputs=["y"])
def second(x):
    y = x + 1
    return {"y": y}

second.depends_on(first)
""".lstrip()
            )

            result = run_document(document_path)

            self.assertTrue(result["ok"])
            self.assertEqual(counter_path.read_text(), "1")
            self.assertEqual(result["finalOutputsByNode"]["second"]["y"]["jsonValue"], 2)

    def test_missing_module_in_document_globals_is_classified(self) -> None:
        source = """
import definitely_missing_rowcall_globals_package
from rowcall import node

@node(id="first", outputs=["x"])
def first():
    x = 1
    return {"x": x}
""".lstrip()

        result = run_source(source, Path("/tmp/missing_globals.py"))

        self.assertFalse(result["ok"])
        self.assertEqual(result["executedNodeIds"], [])
        self.assertEqual(result["error"]["kind"], "missing_module")
        self.assertEqual(result["error"]["phase"], "document_globals")
        self.assertEqual(
            result["error"]["missingModule"],
            "definitely_missing_rowcall_globals_package",
        )
        self.assertEqual(result["error"]["pythonExecutable"], sys.executable)

    def test_missing_module_in_node_execution_is_classified(self) -> None:
        source = """
from rowcall import node

@node(id="first", outputs=["x"])
def first():
    import definitely_missing_rowcall_node_package
    x = 1
    return {"x": x}
""".lstrip()

        result = run_source(source, Path("/tmp/missing_node.py"))

        self.assertFalse(result["ok"])
        self.assertEqual(result["executedNodeIds"], ["first"])
        self.assertEqual(result["error"]["kind"], "missing_module")
        self.assertEqual(result["error"]["phase"], "node_execution")
        self.assertEqual(result["error"]["nodeId"], "first")
        self.assertEqual(
            result["error"]["missingModule"],
            "definitely_missing_rowcall_node_package",
        )
        node_error = result["resultsByNode"]["first"]["errorDetails"]
        self.assertEqual(node_error["kind"], "missing_module")

    def test_captures_stdout_and_display(self) -> None:
        source = """
from rowcall import display, node

@node(id="talk", outputs=["value"])
def talk():
    print("hello stdout")
    display({"seen": True})
    value = 3
    return {"value": value}
""".lstrip()

        result = run_source(source, Path("/tmp/display.py"), trace=True)

        self.assertTrue(result["ok"])
        node_result = result["resultsByNode"]["talk"]
        self.assertEqual(node_result["stdout"], "hello stdout\n")
        self.assertEqual(node_result["displays"][0]["value"]["jsonValue"], {"seen": True})
        self.assertEqual(node_result["outputEvents"][0]["kind"], "stdout")
        self.assertEqual(node_result["outputEvents"][1]["kind"], "display")
        self.assertEqual(result["trace"][0]["stdout"], "hello stdout\n")

    def test_surrogate_output_repr_and_diagnostics_are_escaped_safely(self) -> None:
        stdout_source = '''
from rowcall import node

@node(id="value", outputs=["x"])
def value():
    print(chr(0xD800))
    x = 1
    return {"x": x}
'''.lstrip()
        repr_source = '''
from rowcall import node

class Value:
    def __repr__(self):
        return chr(0xD800)

@node(id="value", outputs=["x"])
def value():
    x = Value()
    return {"x": x}
'''.lstrip()
        error_source = '''
from rowcall import node

class Broken(Exception):
    def __str__(self):
        return chr(0xD800)

@node(id="value", outputs=["x"])
def value():
    raise Broken()
    x = None
    return {"x": x}
'''.lstrip()

        stdout_result = run_source(stdout_source, Path("/tmp/surrogate_stdout.py"))
        repr_result = run_source(repr_source, Path("/tmp/surrogate_repr.py"))
        error_result = run_source(error_source, Path("/tmp/surrogate_error.py"))

        self.assertTrue(stdout_result["ok"])
        self.assertEqual(
            stdout_result["resultsByNode"]["value"]["stdout"],
            "\\ud800\n",
        )
        self.assertTrue(repr_result["ok"])
        self.assertEqual(
            repr_result["resultsByNode"]["value"]["outputs"]["x"]["repr"],
            "\\ud800",
        )
        self.assertFalse(error_result["ok"])
        self.assertEqual(
            error_result["resultsByNode"]["value"]["error"],
            "\\ud800",
        )
        json.dumps(stdout_result).encode("utf-8")
        json.dumps(repr_result).encode("utf-8")
        json.dumps(error_result).encode("utf-8")

    def test_captures_display_through_rowcall_module_alias(self) -> None:
        source = """
import rowcall as nb
from rowcall import node

@node(id="talk", outputs=["value"])
def talk():
    nb.display({"seen": True})
    value = 3
    return {"value": value}
""".lstrip()

        result = run_source(source, Path("/tmp/display_alias.py"), trace=True)

        self.assertTrue(result["ok"])
        node_result = result["resultsByNode"]["talk"]
        self.assertEqual(node_result["displays"][0]["value"]["jsonValue"], {"seen": True})
        self.assertEqual(node_result["outputEvents"][0]["kind"], "display")

    def test_rejects_return_that_omits_declared_output(self) -> None:
        source = """
from rowcall import node

@node(id="bad", outputs=["value"])
def bad():
    return {}
""".lstrip()

        result = run_source(source, Path("/tmp/bad.py"))

        self.assertFalse(result["ok"])
        self.assertEqual(result["executedNodeIds"], [])
        self.assertEqual(result["error"]["kind"], "validation_error")
        issue = result["error"]["issues"][0]
        self.assertEqual(issue["kind"], "invalid_node_return")
        self.assertIn("decorator declares ['value']", issue["message"])


if __name__ == "__main__":
    unittest.main()
