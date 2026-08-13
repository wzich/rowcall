from __future__ import annotations

import unittest
from pathlib import Path

from rowcall.document import (
    add_edge,
    apply_document_operations,
    remove_edge,
    update_node_body,
    update_node_outputs,
    update_node_views,
)


DOCUMENT_PATH = Path("/tmp/rewrite.py")


class DocumentRewriteTests(unittest.TestCase):
    def test_update_body_preserves_globals_and_graph_edges(self) -> None:
        source = """
from rowcall import node

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

# Rowcall graph
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
from rowcall import node

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

    def test_update_outputs_preserves_quoted_node_id_literal(self) -> None:
        source = '''
from rowcall import node

@node(id='n"quote', outputs=["x"])
def make_x():
    x = 1
    y = x + 1
    return {"x": x}
'''.lstrip()

        result = update_node_outputs(source, DOCUMENT_PATH, 'n"quote', ("x", "y"))

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        self.assertIn('@node(id="n\\"quote", outputs=["x", "y"])', result.source)
        assert result.parse_result.document is not None
        self.assertEqual(result.parse_result.document.nodes[0].id, 'n"quote')

    def test_update_views_rewrites_decorator_and_union_return(self) -> None:
        source = """
from rowcall import node

@node(id="n_test", outputs=["x"])
def make_x():
    x = 1
    chart = {"kind": "bar"}
    return {"x": x}
""".lstrip()

        result = update_node_views(
            source,
            DOCUMENT_PATH,
            "n_test",
            ("chart", "x"),
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        self.assertIn(
            '@node(id="n_test", outputs=["x"], views=["chart", "x"])',
            result.source,
        )
        self.assertIn('    return {"x": x, "chart": chart}', result.source)
        assert result.parse_result.document is not None
        node = result.parse_result.document.nodes[0]
        self.assertEqual(node.outputs, ("x",))
        self.assertEqual(node.views, ("chart", "x"))

    def test_add_and_remove_edge_rewrite_depends_on_block(self) -> None:
        source = """
from rowcall import node

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
def format_text():
    text = "ready"
    return {"text": text}

double.depends_on(load)
""".lstrip()

        added = add_edge(source, DOCUMENT_PATH, "n_double", "n_format")

        self.assertTrue(added.ok, [issue.to_dict() for issue in added.issues])
        self.assertIn("# Rowcall graph", added.source)
        self.assertIn("double.depends_on(load)", added.source)
        self.assertIn("format_text.depends_on(double)", added.source)
        assert added.parse_result.document is not None
        self.assertEqual(
            [(edge.from_node, edge.to_node) for edge in added.parse_result.document.edges],
            [("n_load", "n_double"), ("n_double", "n_format")],
        )

        removed = remove_edge(added.source, DOCUMENT_PATH, "n_double", "n_format")

        self.assertTrue(removed.ok, [issue.to_dict() for issue in removed.issues])
        self.assertIn("double.depends_on(load)", removed.source)
        self.assertNotIn("format_text.depends_on(double)", removed.source)
        self.assertIn("VALUE = 1", removed.source)
        assert removed.parse_result.document is not None
        self.assertEqual(
            [(edge.from_node, edge.to_node) for edge in removed.parse_result.document.edges],
            [("n_load", "n_double")],
        )

        detached = remove_edge(added.source, DOCUMENT_PATH, "n_load", "n_double")

        self.assertTrue(detached.ok, [issue.to_dict() for issue in detached.issues])
        self.assertIn("def double():", detached.source)
        self.assertNotIn("double.depends_on(load)", detached.source)

    def test_reject_editing_node_with_invalid_return(self) -> None:
        source = """
from rowcall import node

@node(id="n_test", outputs=["x"])
def make_x():
    if True:
        return {"x": 1}
    return {"x": 2}
""".lstrip()

        result = update_node_body(source, DOCUMENT_PATH, "n_test", "x = 3")

        self.assertFalse(result.ok)
        self.assertEqual(result.source, source)
        self.assertEqual(result.issues[0].kind, "invalid_node_return")
        self.assertIn("exactly one return statement", result.issues[0].message)

    def test_preserve_unrelated_top_level_code_when_updating_outputs(self) -> None:
        source = """
from rowcall import node

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

    def test_apply_operations_updates_body_and_outputs_atomically(self) -> None:
        source = """
from rowcall import node

@node(id="n_test", outputs=["x"])
def make_x():
    x = 1
    return {"x": x}
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {"type": "update_node_body", "nodeId": "n_test", "bodyCode": "x = 2\ny = x + 1"},
                {"type": "update_node_outputs", "nodeId": "n_test", "outputs": ["x", "y"]},
            ],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn('outputs=["x", "y"]', result.source)
        self.assertIn('    return {"x": x, "y": y}', result.source)

    def test_apply_operations_add_and_delete_node_removes_incident_edges(self) -> None:
        source = """
from rowcall import node

@node(id="load", outputs=["x"])
def load():
    x = 1
    return {"x": x}

@node(id="double", outputs=["y"])
def double(x):
    y = x * 2
    return {"y": y}

double.depends_on(load)
""".lstrip()

        added = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {
                    "type": "add_node",
                    "node": {
                        "id": "format",
                        "functionName": "format_text",
                        "outputs": ["text"],
                        "code": "text = str(y)",
                        "position": {"x": 10, "y": 20},
                    },
                },
                {"type": "add_edge", "fromNode": "double", "toNode": "format"},
            ],
        )
        self.assertTrue(added.ok, [issue.to_dict() for issue in added.issues])
        assert added.source is not None
        self.assertIn("format_text.depends_on(double)", added.source)
        self.assertEqual(added.sidecar_metadata, {"nodes": {"format": {"position": {"x": 10, "y": 20}}}})

        deleted = apply_document_operations(
            added.source,
            DOCUMENT_PATH,
            [{"type": "delete_node", "nodeId": "double"}],
        )

        self.assertTrue(deleted.ok, [issue.to_dict() for issue in deleted.issues])
        assert deleted.source is not None
        self.assertNotIn("def double", deleted.source)
        self.assertNotIn("depends_on", deleted.source)
        assert deleted.parse_result.document is not None
        self.assertEqual([node.id for node in deleted.parse_result.document.nodes], ["load", "format"])
        self.assertEqual(deleted.parse_result.document.edges, ())

    def test_apply_operations_remove_edge_normalizes_downstream_signature(self) -> None:
        source = """
from rowcall import node

@node(id="load", outputs=["x"])
def load():
    x = 1
    return {"x": x}

@node(id="double", outputs=["y"])
def double(x):
    y = x * 2
    return {"y": y}

double.depends_on(load)
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {"type": "remove_edge", "fromNode": "load", "toNode": "double"},
                {"type": "update_node_body", "nodeId": "double", "code": "y = 2"},
            ],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn("def double():", result.source)
        self.assertNotIn("depends_on", result.source)

    def test_apply_operations_output_change_normalizes_downstream_signature(self) -> None:
        source = """
from rowcall import node

@node(id="load", outputs=["x"])
def load():
    x = 1
    return {"x": x}

@node(id="double", outputs=["y"])
def double(x):
    y = x * 2
    return {"y": y}

double.depends_on(load)
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {"type": "update_node_body", "nodeId": "load", "code": "value = 1"},
                {"type": "update_node_outputs", "nodeId": "load", "outputs": ["value"]},
                {"type": "update_node_body", "nodeId": "double", "code": "y = value * 2"},
            ],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn("def double(value):", result.source)
        self.assertIn('    return {"value": value}', result.source)

    def test_apply_operations_removes_output_deleted_from_updated_body(self) -> None:
        source = """
from rowcall import node

@node(id="load", outputs=["x"])
def load():
    x = 1
    return {"x": x}
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{"type": "update_node_body", "nodeId": "load", "code": "pass"}],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn('@node(id="load", outputs=[])', result.source)
        self.assertIn("    pass\n    return {}", result.source)

    def test_apply_operations_does_not_auto_export_new_body_bindings(self) -> None:
        source = """
from rowcall import node

@node(id="load", outputs=["message"])
def load():
    message = "hello"
    return {"message": message}
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{"type": "update_node_body", "nodeId": "load", "code": "answer = 42"}],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn('@node(id="load", outputs=[])', result.source)
        self.assertIn("    answer = 42\n    return {}", result.source)
        self.assertNotIn('outputs=["answer"]', result.source)

    def test_apply_operations_removes_view_deleted_from_updated_body(self) -> None:
        source = """
from rowcall import node

@node(id="show", outputs=["value"], views=["chart"])
def show():
    value = 1
    chart = {"kind": "bar"}
    return {"value": value, "chart": chart}
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{"type": "update_node_body", "nodeId": "show", "code": "value = 2"}],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn('@node(id="show", outputs=["value"])', result.source)
        self.assertNotIn("views=", result.source)
        self.assertIn('    return {"value": value}', result.source)

    def test_apply_operations_reconciles_downstream_parameter_outputs(self) -> None:
        source = """
from rowcall import node

@node(id="source", outputs=["value"])
def source():
    value = 1
    return {"value": value}

@node(id="passthrough", outputs=["value"])
def passthrough(value):
    return {"value": value}

passthrough.depends_on(source)
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{"type": "update_node_body", "nodeId": "source", "code": "pass"}],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn('@node(id="source", outputs=[])', result.source)
        self.assertIn('@node(id="passthrough", outputs=[])', result.source)
        self.assertIn("def passthrough():", result.source)
        self.assertEqual(result.source.count("return {}"), 2)

    def test_apply_operations_add_edge_normalizes_downstream_signature(self) -> None:
        source = """
from rowcall import node

@node(id="load", outputs=["x"])
def load():
    x = 1
    return {"x": x}

@node(id="format", outputs=["text"])
def format_text():
    text = "ready"
    return {"text": text}
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{"type": "add_edge", "fromNode": "load", "toNode": "format"}],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn("def format_text(x):", result.source)
        self.assertIn("format_text.depends_on(load)", result.source)

    def test_apply_operations_cancels_inverse_edge_operations_before_validation(self) -> None:
        source = """
from rowcall import node

@node(id="a", outputs=["x"])
def make_x():
    x = 1
    return {"x": x}

@node(id="b", outputs=["y"])
def make_y(x):
    y = x + 1
    return {"y": y}

make_y.depends_on(make_x)
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {"type": "add_edge", "fromNode": "b", "toNode": "a"},
                {"type": "remove_edge", "fromNode": "b", "toNode": "a"},
            ],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        self.assertEqual(result.source, source)

    def test_apply_operations_preserves_original_index_after_edge_coalescing(self) -> None:
        source = """
from rowcall import node

@node(id="a", outputs=["x"])
def make_x():
    x = 1
    return {"x": x}

@node(id="b", outputs=["y"])
def make_y(x):
    y = x + 1
    return {"y": y}

make_y.depends_on(make_x)
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {"type": "add_edge", "fromNode": "b", "toNode": "a"},
                {"type": "remove_edge", "fromNode": "b", "toNode": "a"},
                {"type": "update_node_body", "nodeId": "missing", "code": "x = 2"},
            ],
        )

        self.assertFalse(result.ok)
        self.assertIn(
            {
                "kind": "missing_node_reference",
                "message": "Node 'missing' was not found.",
                "nodeId": "missing",
                "operationIndex": 2,
                "operationType": "update_node_body",
            },
            [issue.to_dict() for issue in result.issues],
        )

    def test_apply_operations_add_node_to_bare_source_inserts_import(self) -> None:
        result = apply_document_operations(
            "",
            DOCUMENT_PATH,
            [{
                "type": "add_node",
                "node": {
                    "id": "start",
                    "functionName": "start",
                    "outputs": ["message"],
                    "code": "message = 'hello'",
                },
            }],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertEqual(
            result.source,
            "\n".join(
                [
                    "from rowcall import node",
                    "",
                    '@node(id="start", outputs=["message"])',
                    "def start():",
                    "    message = 'hello'",
                    '    return {"message": message}',
                ]
            ),
        )

    def test_apply_operations_add_node_inserts_import_after_future_imports(self) -> None:
        source = '''#!/usr/bin/env python3
"""Module docs."""

from __future__ import annotations

VALUE = 1
'''

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{
                "type": "add_node",
                "node": {
                    "id": "start",
                    "functionName": "start",
                    "outputs": ["message"],
                    "code": "message = str(VALUE)",
                },
            }],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn(
            '''#!/usr/bin/env python3
"""Module docs."""

from __future__ import annotations

from rowcall import node

VALUE = 1
''',
            result.source,
        )
        compile(result.source, str(DOCUMENT_PATH), "exec")

    def test_apply_operations_rejects_invalid_returns_before_edge_removal(self) -> None:
        source = """
from rowcall import node

@node(id="load", outputs=["x"])
def load():
    x = 1
    return {"x": x}

@node(id="custom", outputs=["y"])
def use_x(x):
    if x > 0:
        return {"y": x}
    return {"y": 0}

use_x.depends_on(load)
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{"type": "remove_edge", "fromNode": "load", "toNode": "custom"}],
        )

        self.assertFalse(result.ok)
        self.assertIsNone(result.source)
        issue = result.issues[0]
        self.assertEqual(issue.kind, "invalid_node_return")
        self.assertEqual(issue.node_id, "custom")
        self.assertIn("exactly one return statement", issue.message)
        self.assertIsNone(issue.operation_index)

    def test_apply_operations_rejects_invalid_returns_before_edge_addition(self) -> None:
        source = """
from rowcall import node

@node(id="load", outputs=["x"])
def load():
    x = 1
    return {"x": x}

@node(id="custom", outputs=["y"])
def use_x(x):
    if True:
        return {"y": x}
    return {"y": 0}
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{"type": "add_edge", "fromNode": "load", "toNode": "custom"}],
        )

        self.assertFalse(result.ok)
        issue = result.issues[0]
        self.assertEqual(issue.kind, "invalid_node_return")
        self.assertEqual(issue.node_id, "custom")
        self.assertIsNone(issue.operation_index)

    def test_apply_operations_rejects_invalid_returns_before_other_changes(self) -> None:
        source = """
from rowcall import node

@node(id="load", outputs=["x"])
def load():
    x = 1
    return {"x": x}

@node(id="custom", outputs=["y"])
def use_x(x):
    if True:
        return {"y": x}
    return {"y": 0}

use_x.depends_on(load)
""".lstrip()

        changed_outputs = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{"type": "update_node_outputs", "nodeId": "load", "outputs": ["x"]}],
        )
        deleted_upstream = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{"type": "delete_node", "nodeId": "load"}],
        )

        for result in [changed_outputs, deleted_upstream]:
            self.assertFalse(result.ok)
            issue = result.issues[0]
            self.assertEqual(issue.kind, "invalid_node_return")
            self.assertEqual(issue.node_id, "custom")
            self.assertIsNone(issue.operation_index)

    def test_apply_operations_rejects_invalid_returns_before_rename(self) -> None:
        source = """
from rowcall import node

@node(id="custom", outputs=["y"])
def use_x():
    if True:
        return {"y": 1}
    return {"y": 0}
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{
                "type": "rename_node_function",
                "nodeId": "custom",
                "functionName": "renamed",
            }],
        )

        self.assertFalse(result.ok)
        self.assertIsNone(result.source)
        issue = result.issues[0]
        self.assertEqual(issue.kind, "invalid_node_return")
        self.assertEqual(issue.node_id, "custom")
        self.assertIsNone(issue.operation_index)

    def test_apply_operations_returns_metadata_updates(self) -> None:
        source = """
from rowcall import node

@node(id="n_test", outputs=["x"])
def make_x():
    x = 1
    return {"x": x}
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {"type": "move_node", "nodeId": "n_test", "position": {"x": 10, "y": 20}},
                {"type": "update_node_title", "nodeId": "n_test", "title": "Make X"},
                {"type": "update_node_description", "nodeId": "n_test", "description": "Builds x."},
            ],
            sidecar_metadata={
                "nodes": [
                    {"id": "n_other", "position": {"x": 1, "y": 2}},
                    {"id": "n_test", "title": "Old"},
                ]
            },
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        self.assertEqual(
            result.sidecar_metadata,
            {
                "nodes": {
                    "n_other": {"position": {"x": 1, "y": 2}},
                    "n_test": {"title": "Make X", "position": {"x": 10, "y": 20}, "description": "Builds x."},
                }
            },
        )

    def test_apply_operations_invalid_operation_reports_index_and_type_without_source(self) -> None:
        source = """
from rowcall import node

@node(id="n_test", outputs=["x"])
def make_x():
    x = 1
    return {"x": x}
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{"type": "update_node_body", "nodeId": "missing", "bodyCode": "x = 2"}],
        )

        self.assertFalse(result.ok)
        self.assertIsNone(result.source)
        self.assertIn(
            {
                "kind": "missing_node_reference",
                "message": "Node 'missing' was not found.",
                "nodeId": "missing",
                "operationIndex": 0,
                "operationType": "update_node_body",
            },
            [issue.to_dict() for issue in result.issues],
        )


if __name__ == "__main__":
    unittest.main()
