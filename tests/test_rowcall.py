import importlib.util
import unittest
from pathlib import Path

from rowcall import RowcallNodeError, node


class RowcallPackageTest(unittest.TestCase):
    def test_node_decorator_attaches_metadata_without_wrapping_function(self):
        @node(id="n_test", outputs=["x", "y"])
        def make_values():
            x = 1
            y = 2
            return {"x": x, "y": y}

        self.assertEqual(make_values(), {"x": 1, "y": 2})
        self.assertEqual(make_values.__rowcall_id__, "n_test")
        self.assertEqual(make_values.__rowcall_outputs__, ["x", "y"])

    def test_depends_on_records_upstream_functions_and_returns_downstream(self):
        @node(id="n_parent", outputs=["x"])
        def parent():
            x = 1
            return {"x": x}

        @node(id="n_child", outputs=["y"])
        def child(x):
            y = x + 1
            return {"y": y}

        result = child.depends_on(parent)

        self.assertIs(result, child)
        self.assertEqual(child.__rowcall_dependencies__, [parent])

    def test_node_rejects_non_string_outputs(self):
        with self.assertRaises(RowcallNodeError):
            node(id="n_test", outputs=["x", 1])

        with self.assertRaises(RowcallNodeError):
            node(id="n_test", outputs="x")

    def test_display_is_not_part_of_the_public_api(self):
        import rowcall

        self.assertFalse(hasattr(rowcall, "display"))

    def test_generated_example_imports(self):
        path = Path("examples/hello_world.py")
        spec = importlib.util.spec_from_file_location("hello_world_example", path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)

        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        self.assertEqual(module.read_message.__rowcall_id__, "n_load")
        self.assertEqual(module.shout_message.__rowcall_dependencies__, [
            module.read_message,
        ])


if __name__ == "__main__":
    unittest.main()
