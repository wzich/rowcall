from __future__ import annotations

import unittest
from pathlib import Path

from nodebook.document import add_edge, remove_edge, update_node_body, update_node_outputs


DOCUMENT_PATH = Path("/tmp/rewrite.py")


class DocumentRewriteTests(unittest.TestCase):
    def test_update_body_preserves_globals_and_graph_edges(self) -> None:
        source = """
from nodebook import node

GLOBAL_OFFSET = 3

def helper(value):
    return value + GLOBAL_OFFSET

@node(id="n_load", outputs=["x"])
def load():
    x = 1
    return {"x": x}

@node(id="n_double", outputs=["y"])
def double(x):
    y = x * 2
    return {"y": y}

# NodeBook graph
double.depends_on(load)
""".lstrip()

        result = update_node_body(source, DOCUMENT_PATH, "n_double", "y = helper(x)")

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        self.assertIn("GLOBAL_OFFSET = 3", result.source)
        self.assertIn("def helper(value):", result.source)
        self.assertIn("double.depends_on(load)", result.source)
        self.assertIn("    y = helper(x)\n    return {\"y\": y}", result.source)
        assert result.parse_result.document is not None
        self.assertEqual(result.parse_result.document.nodes[1].display_code, "y = helper(x)")
        self.assertEqual(
            [(edge.from_node, edge.to_node) for edge in result.parse_result.document.edges],
            [("n_load", "n_double")],
        )

    def test_update_outputs_rewrites_decorator_and_return(self) -> None:
        source = """
from nodebook import node

@node(id="n_test", outputs=["x"])
def make_x():
    x = 1
    y = x + 1
    return {"x": x}
""".lstrip()

        result = update_node_outputs(source, DOCUMENT_PATH, "n_test", ("x", "y"))

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        self.assertIn('@node(id="n_test", outputs=["x", "y"])', result.source)
        self.assertIn('    return {"x": x, "y": y}', result.source)
        assert result.parse_result.document is not None
        self.assertEqual(result.parse_result.document.nodes[0].outputs, ("x", "y"))

    def test_add_and_remove_edge_rewrite_depends_on_block(self) -> None:
        source = """
from nodebook import node

VALUE = 1

@node(id="n_load", outputs=["x"])
def load():
    x = VALUE
    return {"x": x}

@node(id="n_double", outputs=["y"])
def double(x):
    y = x * 2
    return {"y": y}

@node(id="n_format", outputs=["text"])
def format_text(y):
    text = str(y)
    return {"text": text}

double.depends_on(load)
""".lstrip()

        added = add_edge(source, DOCUMENT_PATH, "n_double", "n_format")

        self.assertTrue(added.ok, [issue.to_dict() for issue in added.issues])
        self.assertIn("# NodeBook graph", added.source)
        self.assertIn("double.depends_on(load)", added.source)
        self.assertIn("format_text.depends_on(double)", added.source)
        assert added.parse_result.document is not None
        self.assertEqual(
            [(edge.from_node, edge.to_node) for edge in added.parse_result.document.edges],
            [("n_load", "n_double"), ("n_double", "n_format")],
        )

        removed = remove_edge(added.source, DOCUMENT_PATH, "n_load", "n_double")

        self.assertTrue(removed.ok, [issue.to_dict() for issue in removed.issues])
        self.assertNotIn("double.depends_on(load)", removed.source)
        self.assertIn("format_text.depends_on(double)", removed.source)
        self.assertIn("VALUE = 1", removed.source)
        assert removed.parse_result.document is not None
        self.assertEqual(
            [(edge.from_node, edge.to_node) for edge in removed.parse_result.document.edges],
            [("n_double", "n_format")],
        )

    def test_reject_editing_custom_return_node(self) -> None:
        source = """
from nodebook import node

@node(id="n_test", outputs=["x"])
def make_x():
    if True:
        return {"x": 1}
    return {"x": 2}
""".lstrip()

        result = update_node_body(source, DOCUMENT_PATH, "n_test", "x = 3")

        self.assertFalse(result.ok)
        self.assertEqual(result.source, source)
        self.assertIn("unsupported_python", [issue.kind for issue in result.issues])
        self.assertIn("Custom-return node n_test", result.issues[-1].message)

    def test_preserve_unrelated_top_level_code_when_updating_outputs(self) -> None:
        source = """
from nodebook import node

# Keep module setup.
SETTINGS = {"scale": 2}

def helper(value):
    return value * SETTINGS["scale"]

@node(id="n_test", outputs=["x"])
def make_x():
    x = helper(1)
    y = x + 1
    return {"x": x}
""".lstrip()

        result = update_node_outputs(source, DOCUMENT_PATH, "n_test", ("x", "y"))

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        self.assertIn("# Keep module setup.", result.source)
        self.assertIn('SETTINGS = {"scale": 2}', result.source)
        self.assertIn("def helper(value):", result.source)


if __name__ == "__main__":
    unittest.main()
