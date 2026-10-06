from __future__ import annotations

import json
import py_compile
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from rowcall.runtime import RuntimeSession, run_document, run_source
from rowcall.runtime.executor import invalidate_document_local_imports


class RuntimeExecutorTests(unittest.TestCase):
    def test_inputs_are_snapshotted_before_mutation_with_or_without_trace(self) -> None:
        source = """
from rowcall import node
@node(id="source", outputs=["items"])
def source():
    items = [1, 2]
    return {"items": items}
@node(id="change", outputs=["items"])
def change(items):
    items.append(3)
    return {"items": items}
change.depends_on(source.output("items"))
"""
        for trace in (False, True):
            result = run_source(source, (Path(tempfile.gettempdir()) / "input_snapshot.py"), trace=trace)
            self.assertTrue(result["ok"])
            changed = result["resultsByNode"]["change"]
            self.assertEqual(changed["inputs"]["items"]["jsonValue"], [1, 2])
            self.assertEqual(changed["outputs"]["items"]["jsonValue"], [1, 2, 3])
            if trace:
                self.assertEqual(result["trace"][1]["inputs"], changed["inputs"])

    def test_runtime_error_location_maps_to_editable_body(self) -> None:
        result = run_source("""
from rowcall import node
@node(id="bad", outputs=["value"])
def bad():
    value = 1
    raise ValueError("failed at body line two")
    return {"value": value}
""", (Path(tempfile.gettempdir()) / "error_location.py"))
        self.assertFalse(result["ok"])
        self.assertEqual(result["resultsByNode"]["bad"]["errorLocation"], {"line": 2, "column": 1})

    def test_import_freshness_preserves_packages_inside_document_venv(self) -> None:
        module_name = "rowcall_document_venv_dependency"
        module = types.ModuleType(module_name)
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                environment = root / ".venv"
                package_path = (
                    environment
                    / "lib"
                    / "python-test"
                    / "site-packages"
                    / f"{module_name}.py"
                )
                module.__file__ = str(package_path)
                sys.modules[module_name] = module

                with (
                    patch.object(sys, "prefix", str(environment)),
                    patch.object(sys, "exec_prefix", str(environment)),
                ):
                    invalidate_document_local_imports(root)

            self.assertIs(sys.modules.get(module_name), module)
        finally:
            sys.modules.pop(module_name, None)

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

    def test_run_to_node_is_fresh_across_document_roots_and_symlinked_helpers(self) -> None:
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

            first = session.run_to_node(source, first_root / "doc.py", "load")
            external_helper.write_text("VALUE = 'updated'\n")
            updated = session.run_to_node(source, first_root / "doc.py", "load")
            switched = session.run_to_node(source, second_root / "doc.py", "load")

        self.assertEqual(first["finalOutputsByNode"]["load"]["value"]["jsonValue"], "first")
        self.assertEqual(updated["finalOutputsByNode"]["load"]["value"]["jsonValue"], "updated")
        self.assertEqual(switched["finalOutputsByNode"]["load"]["value"]["jsonValue"], "second")

    def test_captured_output_is_bounded(self) -> None:
        source = '''
from rowcall import node

@node(id="loud", outputs=["x"])
def loud():
    print("z" * (1024 * 1024 + 100))
    import sys
    print("e" * (1024 * 1024 + 100), file=sys.stderr)
    x = 1
    return {"x": x}
'''.lstrip()
        result = run_source(source, (Path(tempfile.gettempdir()) / "loud.py"))

        node = result["resultsByNode"]["loud"]
        self.assertTrue(result["ok"])
        self.assertLessEqual(len(node["stdout"].encode("utf-8")), 1024 * 1024)
        self.assertLessEqual(len(node["stderr"].encode("utf-8")), 1024 * 1024)
        self.assertTrue(any("stdout was truncated" in item for item in node["warnings"]))
        self.assertTrue(any("stderr was truncated" in item for item in node["warnings"]))
        self.assertEqual(node["displays"], [])
        self.assertNotIn("outputEvents", node)

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
        result = run_source(source, (Path(tempfile.gettempdir()) / "noisy_preview.py"))

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

        result = run_source(source, (Path(tempfile.gettempdir()) / "huge_error.py"), trace=True)

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

world.depends_on(hello.output("message"))
""".lstrip()

        result = run_source(source, (Path(tempfile.gettempdir()) / "hello.py"))

        self.assertTrue(result["ok"])
        self.assertEqual(result["executedNodeIds"], ["hello", "world"])
        self.assertEqual(
            result["finalOutputsByNode"]["world"]["text"]["jsonValue"],
            "hello world",
        )
        json.dumps(result)

    def test_routes_only_selected_train_test_outputs(self) -> None:
        source = """
from rowcall import node

@node(id="split", outputs=["train", "test"])
def split_data():
    train = [1, 2]
    test = [10]
    return {"train": train, "test": test}

@node(id="fit", outputs=["model"])
def fit_model(train):
    model = sum(train)
    return {"model": model}

@node(id="evaluate", outputs=["score"])
def evaluate(test, model):
    score = sum(test) + model
    return {"score": score}

fit_model.depends_on(split_data.output("train"))
evaluate.depends_on(split_data.output("test"), fit_model.output("model"))
""".lstrip()

        result = run_source(source, (Path(tempfile.gettempdir()) / "train_test.py"))

        self.assertTrue(result["ok"])
        self.assertEqual(
            result["finalOutputsByNode"]["evaluate"]["score"]["jsonValue"],
            13,
        )

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

second.depends_on(first.output("x"))
third.depends_on(second.output("y"))
""".lstrip()

        by_id = run_source(source, (Path(tempfile.gettempdir()) / "target.py"), target="b")
        by_function = run_source(source, (Path(tempfile.gettempdir()) / "target.py"), target="second")

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

    def test_sibling_imports_take_precedence_when_document_directory_is_already_on_path(self) -> None:
        helper_name = "rowcall_import_precedence_helper"
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                document_dir = root / "document"
                other_dir = root / "other"
                document_dir.mkdir()
                other_dir.mkdir()
                (document_dir / f"{helper_name}.py").write_text("VALUE = 'sibling'\n")
                (other_dir / f"{helper_name}.py").write_text("VALUE = 'other'\n")
                source = f'''from rowcall import node

@node(id="load", outputs=["value"])
def load():
    from {helper_name} import VALUE
    value = VALUE
    return {{"value": value}}
'''
                original_path = [str(other_dir), *sys.path, str(document_dir)]
                with patch.object(sys, "path", original_path.copy()):
                    result = run_source(source, document_dir / "graph.py")
                    self.assertEqual(sys.path, original_path)

                self.assertTrue(result["ok"])
                self.assertEqual(
                    result["finalOutputsByNode"]["load"]["value"]["jsonValue"],
                    "sibling",
                )
        finally:
            sys.modules.pop(helper_name, None)

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

second.depends_on(first.output("x"))
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

        result = run_source(source, (Path(tempfile.gettempdir()) / "missing_globals.py"))

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

        result = run_source(source, (Path(tempfile.gettempdir()) / "missing_node.py"))

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

    def test_captures_stdout_and_ordered_displays_separately(self) -> None:
        source = """
from rowcall import node

@node(id="talk", outputs=["value"])
def talk():
    print("hello stdout")
    display({"seen": True}, label="Seen")
    display("done")
    value = 3
    return {"value": value}
""".lstrip()

        result = run_source(source, (Path(tempfile.gettempdir()) / "display.py"), trace=True)

        self.assertTrue(result["ok"])
        node_result = result["resultsByNode"]["talk"]
        self.assertEqual(node_result["stdout"], "hello stdout\n")
        self.assertEqual(
            [(item["name"], item["jsonValue"]) for item in node_result["displays"]],
            [("Seen", {"seen": True}), ("Display 2", "done")],
        )
        self.assertNotIn("outputEvents", node_result)
        self.assertEqual(result["trace"][0]["stdout"], "hello stdout\n")
        self.assertEqual(result["trace"][0]["displays"], node_result["displays"])

    def test_pyplot_figures_are_closed_between_nodes_and_repeated_runs(self) -> None:
        fake_matplotlib = types.ModuleType("matplotlib")
        fake_matplotlib.__path__ = []  # type: ignore[attr-defined]
        fake_pyplot = types.ModuleType("matplotlib.pyplot")
        fake_pyplot.layers = ["left over from an earlier run"]  # type: ignore[attr-defined]
        close_calls: list[str] = []

        def close(target: str) -> None:
            close_calls.append(target)
            fake_pyplot.layers.clear()  # type: ignore[attr-defined]

        fake_pyplot.close = close  # type: ignore[attr-defined]
        fake_matplotlib.pyplot = fake_pyplot  # type: ignore[attr-defined]
        source = """
import matplotlib.pyplot as plt
from rowcall import node

@node(id="first", outputs=["marker", "first_initial", "first_final"])
def first():
    first_initial = len(plt.layers)
    plt.layers.append("first")
    first_final = len(plt.layers)
    marker = True
    return {
        "marker": marker,
        "first_initial": first_initial,
        "first_final": first_final,
    }

@node(id="second", outputs=["second_initial", "second_final"])
def second(marker):
    second_initial = len(plt.layers)
    plt.layers.append("second")
    second_final = len(plt.layers)
    return {
        "second_initial": second_initial,
        "second_final": second_final,
    }

second.depends_on(first.output("marker"))
""".lstrip()

        with patch.dict(
            sys.modules,
            {
                "matplotlib": fake_matplotlib,
                "matplotlib.pyplot": fake_pyplot,
            },
        ):
            session = RuntimeSession()
            first_run = session.run_graph(source, (Path(tempfile.gettempdir()) / "plot_cleanup.py"))
            second_run = session.run_graph(source, (Path(tempfile.gettempdir()) / "plot_cleanup.py"))

        for result in (first_run, second_run):
            self.assertTrue(result["ok"])
            self.assertEqual(
                result["resultsByNode"]["first"]["outputs"]["first_initial"]["jsonValue"],
                0,
            )
            self.assertEqual(
                result["resultsByNode"]["first"]["outputs"]["first_final"]["jsonValue"],
                1,
            )
            self.assertEqual(
                result["resultsByNode"]["second"]["outputs"]["second_initial"]["jsonValue"],
                0,
            )
            self.assertEqual(
                result["resultsByNode"]["second"]["outputs"]["second_final"]["jsonValue"],
                1,
            )
        self.assertEqual(close_calls, ["all"] * 8)
        self.assertEqual(fake_pyplot.layers, [])  # type: ignore[attr-defined]

    def test_pyplot_figures_are_closed_when_a_node_fails(self) -> None:
        fake_matplotlib = types.ModuleType("matplotlib")
        fake_matplotlib.__path__ = []  # type: ignore[attr-defined]
        fake_pyplot = types.ModuleType("matplotlib.pyplot")
        fake_pyplot.layers = []  # type: ignore[attr-defined]
        close_calls: list[str] = []

        def close(target: str) -> None:
            close_calls.append(target)
            fake_pyplot.layers.clear()  # type: ignore[attr-defined]

        fake_pyplot.close = close  # type: ignore[attr-defined]
        fake_matplotlib.pyplot = fake_pyplot  # type: ignore[attr-defined]
        source = """
import matplotlib.pyplot as plt
from rowcall import node

@node(id="broken", outputs=[])
def broken():
    plt.layers.append("broken")
    raise RuntimeError("boom")
    return {}
""".lstrip()

        with patch.dict(
            sys.modules,
            {
                "matplotlib": fake_matplotlib,
                "matplotlib.pyplot": fake_pyplot,
            },
        ):
            result = run_source(source, (Path(tempfile.gettempdir()) / "plot_cleanup_error.py"))

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["nodeId"], "broken")
        self.assertEqual(close_calls, ["all", "all"])
        self.assertEqual(fake_pyplot.layers, [])  # type: ignore[attr-defined]

    def test_display_uses_repr_png_without_becoming_an_output(self) -> None:
        source = """
import base64
from rowcall import node

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)

class Figure:
    def _repr_png_(self):
        return PNG

@node(id="plot", outputs=[])
def plot():
    chart = Figure()
    display(chart, label="Chart")
    return {}
""".lstrip()

        result = run_source(
            source,
            (Path(tempfile.gettempdir()) / "png_display.py"),
            trace=True,
        )

        self.assertTrue(result["ok"])
        node_result = result["resultsByNode"]["plot"]
        self.assertEqual(node_result["outputs"], {})
        self.assertEqual(node_result["displays"][0]["image"]["width"], 1)
        self.assertEqual(result["finalOutputsByNode"]["plot"], {})

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

        stdout_result = run_source(stdout_source, (Path(tempfile.gettempdir()) / "surrogate_stdout.py"))
        repr_result = run_source(repr_source, (Path(tempfile.gettempdir()) / "surrogate_repr.py"))
        error_result = run_source(error_source, (Path(tempfile.gettempdir()) / "surrogate_error.py"))

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

    def test_displayed_output_remains_a_normal_graph_output(self) -> None:
        source = """
from rowcall import node

@node(id="talk", outputs=["value"])
def talk():
    value = 3
    display(value, label="Value")
    return {"value": value}
""".lstrip()

        result = run_source(source, (Path(tempfile.gettempdir()) / "display_alias.py"), trace=True)

        self.assertTrue(result["ok"])
        node_result = result["resultsByNode"]["talk"]
        self.assertEqual(node_result["outputs"]["value"]["jsonValue"], 3)
        self.assertEqual(node_result["displays"][0]["jsonValue"], 3)

    def test_display_snapshots_mutable_values_at_call_time(self) -> None:
        source = """
from rowcall import node

@node(id="snapshot", outputs=[])
def snapshot():
    values = [1]
    display(values)
    values.append(2)
    display(values)
    return {}
""".lstrip()

        result = run_source(source, (Path(tempfile.gettempdir()) / "display_snapshot.py"))

        self.assertTrue(result["ok"])
        displays = result["resultsByNode"]["snapshot"]["displays"]
        self.assertEqual([item["jsonValue"] for item in displays], [[1], [1, 2]])

    def test_display_count_is_bounded_per_execution(self) -> None:
        source = """
from rowcall import node

@node(id="many", outputs=[])
def many():
    for value in range(12):
        display(value)
    return {}
""".lstrip()

        result = run_source(source, (Path(tempfile.gettempdir()) / "display_limit.py"))

        self.assertTrue(result["ok"])
        node_result = result["resultsByNode"]["many"]
        self.assertEqual(len(node_result["displays"]), 10)
        self.assertEqual(node_result["displays"][-1]["jsonValue"], 9)
        self.assertIn(
            "display results were truncated after 10 values",
            node_result["warnings"],
        )

    def test_displays_before_an_error_are_returned_with_the_failure(self) -> None:
        source = """
from rowcall import node

@node(id="broken", outputs=[])
def broken():
    display("before", label="Checkpoint")
    raise RuntimeError("boom")
    return {}
""".lstrip()

        result = run_source(source, (Path(tempfile.gettempdir()) / "display_error.py"))

        self.assertFalse(result["ok"])
        node_result = result["resultsByNode"]["broken"]
        self.assertEqual(node_result["displays"][0]["name"], "Checkpoint")
        self.assertEqual(node_result["displays"][0]["jsonValue"], "before")
        self.assertEqual(node_result["error"], "boom")
        self.assertEqual(node_result["variables"], {})

    def test_success_snapshots_final_values_for_all_node_variables(self) -> None:
        source = """
from rowcall import node

@node(id="load", outputs=["value"])
def load():
    value = 2
    return {"value": value}

@node(id="transform", outputs=["routed"])
def transform(value):
    value = value + 1
    local = value * 2
    routed = local + 3
    return {"routed": routed}

transform.depends_on(load.output("value"))
""".lstrip()

        result = run_source(source, (Path(tempfile.gettempdir()) / "all_variables.py"))

        self.assertTrue(result["ok"])
        node_result = result["resultsByNode"]["transform"]
        self.assertEqual(list(node_result["outputs"]), ["routed"])
        self.assertEqual(
            {
                name: preview["jsonValue"]
                for name, preview in node_result["variables"].items()
            },
            {"value": 3, "local": 6, "routed": 9},
        )

    def test_document_global_helper_can_use_bare_display(self) -> None:
        source = """
from rowcall import node

def show(value):
    display(value, label="From helper")

@node(id="helper", outputs=[])
def helper():
    show({"ok": True})
    return {}
""".lstrip()

        result = run_source(source, (Path(tempfile.gettempdir()) / "display_helper.py"))

        self.assertTrue(result["ok"])
        display_result = result["resultsByNode"]["helper"]["displays"][0]
        self.assertEqual(display_result["name"], "From helper")
        self.assertEqual(display_result["jsonValue"], {"ok": True})

    def test_rejects_return_that_omits_declared_output(self) -> None:
        source = """
from rowcall import node

@node(id="bad", outputs=["value"])
def bad():
    return {}
""".lstrip()

        result = run_source(source, (Path(tempfile.gettempdir()) / "bad.py"))

        self.assertFalse(result["ok"])
        self.assertEqual(result["executedNodeIds"], [])
        self.assertEqual(result["error"]["kind"], "validation_error")
        issue = result["error"]["issues"][0]
        self.assertEqual(issue["kind"], "invalid_node_return")
        self.assertIn("decorator requires ['value']", issue["message"])


if __name__ == "__main__":
    unittest.main()
