from __future__ import annotations

import unittest
from pathlib import Path

from rowcall.document import (
    add_edge,
    apply_document_operations,
    remove_edge,
    update_node_body,
    update_node_outputs,
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
double.depends_on(load.output("x"))
""".lstrip()

        result = update_node_body(source, DOCUMENT_PATH, "n_double", "y = helper(x)")

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        self.assertIn("GLOBAL_OFFSET = 3", result.source)
        self.assertIn("def helper(value):", result.source)
        self.assertIn('double.depends_on(load.output("x"))', result.source)
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

double.depends_on(load.output("x"))
""".lstrip()

        added = add_edge(source, DOCUMENT_PATH, "n_double", "y", "n_format")

        self.assertTrue(added.ok, [issue.to_dict() for issue in added.issues])
        self.assertIn("# Rowcall graph", added.source)
        self.assertIn('double.depends_on(load.output("x"))', added.source)
        self.assertIn('format_text.depends_on(double.output("y"))', added.source)
        assert added.parse_result.document is not None
        self.assertEqual(
            [(edge.from_node, edge.to_node) for edge in added.parse_result.document.edges],
            [("n_load", "n_double"), ("n_double", "n_format")],
        )

        removed = remove_edge(added.source, DOCUMENT_PATH, "n_double", "y", "n_format", "y")

        self.assertTrue(removed.ok, [issue.to_dict() for issue in removed.issues])
        self.assertIn('double.depends_on(load.output("x"))', removed.source)
        self.assertNotIn('format_text.depends_on(double.output("y"))', removed.source)
        self.assertIn("VALUE = 1", removed.source)
        assert removed.parse_result.document is not None
        self.assertEqual(
            [(edge.from_node, edge.to_node) for edge in removed.parse_result.document.edges],
            [("n_load", "n_double")],
        )

        detached = remove_edge(added.source, DOCUMENT_PATH, "n_load", "x", "n_double", "x")

        self.assertTrue(detached.ok, [issue.to_dict() for issue in detached.issues])
        self.assertIn("def double():", detached.source)
        self.assertNotIn('double.depends_on(load.output("x"))', detached.source)

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

double.depends_on(load.output("x"))
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
                {"type": "add_edge", "fromNode": "double", "fromOutput": "y", "toNode": "format", "toInput": "y"},
            ],
        )
        self.assertTrue(added.ok, [issue.to_dict() for issue in added.issues])
        assert added.source is not None
        self.assertIn('format_text.depends_on(double.output("y"))', added.source)
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

    def test_apply_operations_can_replace_every_node_after_deleting_them_first(self) -> None:
        source = """
from rowcall import node

@node(id="first", outputs=["x"])
def first():
    x = 1
    return {"x": x}

@node(id="second", outputs=["y"])
def second():
    y = 2
    return {"y": y}
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {"type": "delete_node", "nodeId": "first"},
                {"type": "delete_node", "nodeId": "second"},
                {
                    "type": "add_node",
                    "node": {
                        "id": "replacement",
                        "functionName": "replacement",
                        "outputs": [],
                        "code": "pass",
                    },
                },
            ],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertNotIn("def first", result.source)
        self.assertNotIn("def second", result.source)
        self.assertIn('node(id="replacement", outputs=[])', result.source)
        self.assertIn("def replacement():", result.source)

    def test_apply_operations_still_rejects_a_document_that_ends_with_no_nodes(self) -> None:
        source = """
from rowcall import node

@node(id="only", outputs=[])
def only():
    pass
    return {}
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{"type": "delete_node", "nodeId": "only"}],
        )

        self.assertFalse(result.ok)
        self.assertIsNone(result.source)
        self.assertIn("missing_node", [issue.kind for issue in result.issues])

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

double.depends_on(load.output("x"))
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {"type": "remove_edge", "fromNode": "load", "fromOutput": "x", "toNode": "double", "toInput": "x"},
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

double.depends_on(load.output("x"))
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {"type": "remove_edge", "fromNode": "load", "fromOutput": "x", "toNode": "double", "toInput": "x"},
                {"type": "update_node_body", "nodeId": "load", "code": "value = 1"},
                {"type": "update_node_outputs", "nodeId": "load", "outputs": ["value"]},
                {"type": "add_edge", "fromNode": "load", "fromOutput": "value", "toNode": "double", "toInput": "x"},
            ],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn("def double(x):", result.source)
        self.assertIn('    return {"value": value}', result.source)
        self.assertIn('double.depends_on(x=load.output("value"))', result.source)

    def test_output_rename_batch_preserves_multiline_downstream_input(self) -> None:
        source = """
from rowcall import node

@node(id="fit", outputs=["model", "training_summary"])
def fit_model():
    model = {"slope": 1}
    training_summary = {"rows": 3}
    return {"model": model, "training_summary": training_summary}

@node(id="summarize", outputs=["report"])
def summarize_run(
    training_summary,
):
    report = training_summary
    return {"report": report}

summarize_run.depends_on(fit_model.output("training_summary"))
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {
                    "type": "update_node_body",
                    "nodeId": "fit",
                    "code": 'model = {"slope": 1}\ntraining_summar = {"rows": 3}',
                },
                {
                    "type": "remove_edge",
                    "fromNode": "fit",
                    "fromOutput": "training_summary",
                    "toNode": "summarize",
                    "toInput": "training_summary",
                },
                {
                    "type": "add_edge",
                    "fromNode": "fit",
                    "fromOutput": "training_summar",
                    "toNode": "summarize",
                    "toInput": "training_summary",
                },
            ],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn(
            "def summarize_run(\n    training_summary,\n):",
            result.source,
        )
        self.assertIn(
            'summarize_run.depends_on(training_summary=fit_model.output("training_summar"))',
            result.source,
        )
        self.assertIn('outputs=["training_summar"]', result.source)
        self.assertIn(
            'return {"training_summar": training_summar}',
            result.source,
        )

    def test_add_and_remove_edge_rewrite_multiline_downstream_signature(self) -> None:
        source = """
from rowcall import node

@node(id="load", outputs=["x"])
def load():
    x = 1
    return {"x": x}

@node(id="format", outputs=["text"])
def format_text(
):
    text = "ready"
    return {"text": text}
""".lstrip()

        added = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{
                "type": "add_edge",
                "fromNode": "load",
                "fromOutput": "x",
                "toNode": "format",
                "toInput": "x",
            }],
        )

        self.assertTrue(added.ok, [issue.to_dict() for issue in added.issues])
        assert added.source is not None
        self.assertIn("def format_text(\n    x,\n):", added.source)

        removed = apply_document_operations(
            added.source,
            DOCUMENT_PATH,
            [{
                "type": "remove_edge",
                "fromNode": "load",
                "fromOutput": "x",
                "toNode": "format",
                "toInput": "x",
            }],
        )

        self.assertTrue(removed.ok, [issue.to_dict() for issue in removed.issues])
        assert removed.source is not None
        self.assertIn("def format_text(\n):", removed.source)
        self.assertNotIn("depends_on", removed.source)
        self.assertIn('@node(id="load", outputs=[])', removed.source)
        self.assertIn("    return {}", removed.source)

    def test_add_edge_promotes_an_assigned_variable_to_output(self) -> None:
        source = """
from rowcall import node

@node(id="split", outputs=[])
def split_dataset():
    train = [1, 2, 3]
    return {}

@node(id="fit", outputs=[])
def fit_model():
    pass
    return {}
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{
                "type": "add_edge",
                "fromNode": "split",
                "fromOutput": "train",
                "toNode": "fit",
                "toInput": "train",
            }],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn('@node(id="split", outputs=["train"])', result.source)
        self.assertIn('    return {"train": train}', result.source)
        self.assertIn("def fit_model(train):", result.source)
        self.assertIn('fit_model.depends_on(split_dataset.output("train"))', result.source)

    def test_remove_edge_keeps_output_while_another_route_uses_it(self) -> None:
        source = """
from rowcall import node

@node(id="split", outputs=["train"])
def split_dataset():
    train = [1, 2, 3]
    return {"train": train}

@node(id="fit", outputs=[])
def fit_model(train):
    pass
    return {}

@node(id="review", outputs=[])
def review_train(train):
    pass
    return {}

fit_model.depends_on(split_dataset.output("train"))
review_train.depends_on(split_dataset.output("train"))
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{
                "type": "remove_edge",
                "fromNode": "split",
                "fromOutput": "train",
                "toNode": "fit",
                "toInput": "train",
            }],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn('@node(id="split", outputs=["train"])', result.source)
        self.assertIn('review_train.depends_on(split_dataset.output("train"))', result.source)
        self.assertNotIn("fit_model.depends_on", result.source)

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
        self.assertIn('@node(id="load", outputs=["x"])', result.source)
        self.assertIn('    pass\n    return {"x": x}', result.source)

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
        self.assertIn('@node(id="load", outputs=["message"])', result.source)
        self.assertIn('    answer = 42\n    return {"message": message}', result.source)
        self.assertNotIn('outputs=["answer"]', result.source)

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

passthrough.depends_on(source.output("value"))
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{"type": "update_node_body", "nodeId": "source", "code": "pass"}],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn('@node(id="source", outputs=["value"])', result.source)
        self.assertIn('@node(id="passthrough", outputs=["value"])', result.source)
        self.assertIn("def passthrough(value):", result.source)
        self.assertIn('passthrough.depends_on(source.output("value"))', result.source)

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
            [{"type": "add_edge", "fromNode": "load", "fromOutput": "x", "toNode": "format", "toInput": "x"}],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn("def format_text(x):", result.source)
        self.assertIn('format_text.depends_on(load.output("x"))', result.source)

    def test_adds_parallel_named_routes_between_the_same_nodes(self) -> None:
        source = """
from rowcall import node

@node(id="split", outputs=["train", "test"])
def split_data():
    train = [1]
    test = [2]
    return {"train": train, "test": test}

@node(id="inspect", outputs=["summary"])
def inspect_split():
    summary = "ready"
    return {"summary": summary}
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {"type": "add_edge", "fromNode": "split", "fromOutput": "train", "toNode": "inspect", "toInput": "train"},
                {"type": "add_edge", "fromNode": "split", "fromOutput": "test", "toNode": "inspect", "toInput": "test"},
            ],
        )

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.source is not None
        self.assertIn("def inspect_split(train, test):", result.source)
        self.assertIn(
            'inspect_split.depends_on(split_data.output("train"), split_data.output("test"))',
            result.source,
        )

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

make_y.depends_on(make_x.output("x"))
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {"type": "add_edge", "fromNode": "b", "fromOutput": "y", "toNode": "a", "toInput": "y"},
                {"type": "remove_edge", "fromNode": "b", "fromOutput": "y", "toNode": "a", "toInput": "y"},
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

make_y.depends_on(make_x.output("x"))
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [
                {"type": "add_edge", "fromNode": "b", "fromOutput": "y", "toNode": "a", "toInput": "y"},
                {"type": "remove_edge", "fromNode": "b", "fromOutput": "y", "toNode": "a", "toInput": "y"},
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

use_x.depends_on(load.output("x"))
""".lstrip()

        result = apply_document_operations(
            source,
            DOCUMENT_PATH,
            [{"type": "remove_edge", "fromNode": "load", "fromOutput": "x", "toNode": "custom", "toInput": "x"}],
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
            [{"type": "add_edge", "fromNode": "load", "fromOutput": "x", "toNode": "custom", "toInput": "x"}],
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

use_x.depends_on(load.output("x"))
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

    def test_apply_operations_reports_node_body_syntax_location_in_editor_coordinates(self) -> None:
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
            [{"type": "update_node_body", "nodeId": "n_test", "code": "x = 1\nresult = )"}],
        )

        self.assertFalse(result.ok)
        self.assertIn(
            {
                "kind": "invalid_python",
                "message": "unmatched ')'",
                "path": "2:10",
                "nodeId": "n_test",
                "field": "code",
                "operationIndex": 0,
                "operationType": "update_node_body",
            },
            [issue.to_dict() for issue in result.issues],
        )

    def test_apply_operations_reports_globals_syntax_location_in_editor_coordinates(self) -> None:
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
            [{"type": "update_globals", "code": "import math\nvalue = )"}],
        )

        self.assertFalse(result.ok)
        self.assertIn(
            {
                "kind": "invalid_python",
                "message": "unmatched ')'",
                "path": "2:9",
                "field": "globalsCode",
                "operationIndex": 0,
                "operationType": "update_globals",
            },
            [issue.to_dict() for issue in result.issues],
        )

    def test_apply_operations_points_incomplete_suite_at_end_of_editor_code(self) -> None:
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
            [{"type": "update_node_body", "nodeId": "n_test", "code": "if ready:"}],
        )

        self.assertFalse(result.ok)
        syntax_issue = next(issue for issue in result.issues if issue.kind == "invalid_python")
        self.assertEqual(syntax_issue.path, "1:10")
        self.assertEqual(syntax_issue.node_id, "n_test")
        self.assertEqual(syntax_issue.field, "code")


if __name__ == "__main__":
    unittest.main()
