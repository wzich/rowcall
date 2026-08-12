from __future__ import annotations

import unittest
from pathlib import Path

from rowcall.document import (
    build_full_graph_plan,
    build_run_plan,
    get_sink_node_ids,
    parse_source,
)


REPO_ROOT = Path(__file__).resolve().parents[1]


class DocumentParserTests(unittest.TestCase):
    def parse_fixture(self, relative_path: str):
        path = REPO_ROOT / relative_path
        return parse_source(path.read_text(), path)

    def test_rejects_python_file_without_nodes_with_actionable_issue(self) -> None:
        result = parse_source("VALUE = 1\n", Path("/tmp/not_a_rowcall.py"))

        self.assertFalse(result.ok)
        self.assertEqual(result.issues[0].kind, "missing_node")
        self.assertIn("at least one node", result.issues[0].message)

    def test_diagnoses_async_and_qualified_node_near_misses(self) -> None:
        async_result = parse_source(
            'from rowcall import node\n\n@node(id="a", outputs=["x"])\nasync def a():\n    return {"x": 1}\n',
            Path("/tmp/async_node.py"),
        )
        qualified_result = parse_source(
            'import rowcall\n\n@rowcall.node(id="a", outputs=["x"])\ndef a():\n    return {"x": 1}\n',
            Path("/tmp/qualified_node.py"),
        )

        self.assertEqual(async_result.issues[0].kind, "unsupported_node_syntax")
        self.assertIn("Async node", async_result.issues[0].message)
        self.assertEqual(qualified_result.issues[0].kind, "unsupported_node_syntax")
        self.assertIn("from rowcall import node", qualified_result.issues[0].message)

    def test_diagnoses_aliased_qualified_node_decorator(self) -> None:
        result = parse_source(
            'import rowcall as nb\n\n@nb.node(id="a", outputs=["x"])\ndef a():\n    return {"x": 1}\n',
            Path("/tmp/aliased_qualified_node.py"),
        )

        self.assertFalse(result.ok)
        self.assertEqual([issue.kind for issue in result.issues], ["unsupported_node_syntax"])
        self.assertIn("Qualified node decorator", result.issues[0].message)
        self.assertIn("from rowcall import node", result.issues[0].message)

    def test_rejects_node_decorator_without_rowcall_binding_provenance(self) -> None:
        unrelated_import = parse_source(
            'from unrelated import node\n\n@node(id="a", outputs=["x"])\ndef a():\n    return {"x": 1}\n',
            Path("/tmp/unrelated_node.py"),
        )
        shadowed_import = parse_source(
            "from rowcall import node\n"
            "node = lambda **kwargs: lambda fn: fn\n\n"
            '@node(id="a", outputs=["x"])\n'
            "def a():\n"
            '    return {"x": 1}\n',
            Path("/tmp/shadowed_node.py"),
        )

        for result in (unrelated_import, shadowed_import):
            self.assertFalse(result.ok)
            self.assertEqual(
                [issue.kind for issue in result.issues],
                ["unsupported_node_syntax"],
            )
            self.assertIn("top-level 'from rowcall import node'", result.issues[0].message)

    def test_accepts_rowcall_binding_until_it_is_shadowed(self) -> None:
        source = '''
from rowcall import node

@node(id="first", outputs=["x"])
def first():
    x = 1
    return {"x": x}

node = lambda **kwargs: lambda fn: fn

@node(id="second", outputs=["y"])
def second():
    return {"y": 2}
'''.lstrip()

        result = parse_source(source, Path("/tmp/partially_shadowed_node.py"))

        self.assertFalse(result.ok)
        self.assertEqual([node.id for node in result.document.nodes], ["first"])
        self.assertEqual([issue.kind for issue in result.issues], ["unsupported_node_syntax"])

    def test_dynamic_module_namespace_access_invalidates_node_binding(self) -> None:
        statements = (
            'exec("node = print")',
            'globals()["node"] = print',
            'locals().update({"node": print})',
            'vars()["node"] = print',
            'vars(*[])["node"] = print',
            'vars(**{})["node"] = print',
            'if True:\n    exec("node = print")',
        )
        for index, statement in enumerate(statements):
            with self.subTest(statement=statement):
                result = parse_source(
                    f'''\
from rowcall import node

{statement}

@node(id="a", outputs=["x"])
def a():
    return {{"x": 1}}
''',
                    Path(f"/tmp/dynamic_binding_{index}.py"),
                )

                self.assertFalse(result.ok)
                self.assertEqual(
                    [issue.kind for issue in result.issues],
                    ["unsupported_node_syntax"],
                )

    def test_vars_of_an_object_does_not_invalidate_node_binding(self) -> None:
        result = parse_source(
            '''\
from rowcall import node

class Config:
    value = 1

INFO = vars(Config)

@node(id="a", outputs=["x"])
def a():
    x = INFO["value"]
    return {"x": x}
''',
            Path("/tmp/object_vars.py"),
        )

        self.assertTrue(result.ok, result.issues)
        self.assertEqual([node.id for node in result.document.nodes], ["a"])

    def test_comprehension_named_expression_shadows_rowcall_binding(self) -> None:
        shadowed = parse_source(
            '''
from rowcall import node

[item for item in [1] if (node := lambda **kwargs: lambda fn: fn)]

@node(id="a", outputs=["x"])
def a():
    x = 1
    return {"x": x}
'''.lstrip(),
            Path("/tmp/comprehension_named_expression.py"),
        )
        comprehension_target = parse_source(
            '''
from rowcall import node

[node for node in []]

@node(id="a", outputs=["x"])
def a():
    x = 1
    return {"x": x}
'''.lstrip(),
            Path("/tmp/comprehension_target.py"),
        )

        self.assertFalse(shadowed.ok)
        self.assertEqual(
            [issue.kind for issue in shadowed.issues],
            ["unsupported_node_syntax"],
        )
        self.assertTrue(comprehension_target.ok)

    def test_pattern_and_exception_captures_shadow_rowcall_binding(self) -> None:
        capture_statements = (
            "match object():\n    case node:\n        pass",
            "match []:\n    case [*node]:\n        pass",
            "match {}:\n    case {**node}:\n        pass",
            "try:\n    raise RuntimeError()\nexcept RuntimeError as node:\n    pass",
        )
        for index, statement in enumerate(capture_statements):
            with self.subTest(statement=statement):
                source = f'''
from rowcall import node

{statement}

@node(id="a", outputs=["x"])
def a():
    return {{"x": 1}}
'''.lstrip()
                result = parse_source(source, Path(f"/tmp/captured_node_{index}.py"))

                self.assertFalse(result.ok)
                self.assertEqual(
                    [issue.kind for issue in result.issues],
                    ["unsupported_node_syntax"],
                )

    def test_nested_wildcard_import_invalidates_node_binding_provenance(self) -> None:
        source = '''
from rowcall import node

if False:
    from unrelated import *

@node(id="a", outputs=["x"])
def a():
    return {"x": 1}
'''.lstrip()

        result = parse_source(source, Path("/tmp/nested_wildcard_import.py"))

        self.assertFalse(result.ok)
        self.assertEqual(
            [issue.kind for issue in result.issues],
            ["unsupported_node_syntax"],
        )

    def test_rejects_invalid_metadata_and_reserved_outputs(self) -> None:
        source = '''
from rowcall import node

@node(id="", outputs=["x", "x", "", "__rowcall_result"])
def first():
    return {"x": 1}

@node(id="second", outputs=["y"])
def second(x):
    return {"y": x}

second.depends_on(first)
second.depends_on(first)
'''.lstrip()
        result = parse_source(source, Path("/tmp/metadata.py"))

        kinds = [issue.kind for issue in result.issues]
        self.assertIn("invalid_node_id", kinds)
        self.assertIn("duplicate_output", kinds)
        self.assertEqual(kinds.count("invalid_output"), 2)
        self.assertIn("duplicate_edge", kinds)
        assert result.document is not None
        self.assertEqual(result.document.nodes[0].id, "")

    def test_parse_valid_document_and_plan(self) -> None:
        source = """
from rowcall import node

GLOBAL = 2

@node(id="load", outputs=["x"])
def load():
    x = GLOBAL
    return {"x": x}

@node(id="double", outputs=["y"])
def double(x):
    y = x * 2
    return {"y": y}

@node(id="format", outputs=["text"])
def format_text(y):
    text = str(y)
    return {"text": text}

double.depends_on(load)
format_text.depends_on(double)
""".lstrip()

        result = parse_source(source, Path("/tmp/example.py"))

        self.assertTrue(result.ok)
        self.assertIsNotNone(result.document)
        assert result.document is not None
        self.assertEqual([node.id for node in result.document.nodes], ["load", "double", "format"])
        self.assertEqual(
            [(edge.from_node, edge.to_node) for edge in result.document.edges],
            [("load", "double"), ("double", "format")],
        )
        self.assertEqual(result.document.nodes[1].parameters, ("x",))
        self.assertEqual(result.document.nodes[1].display_code, "y = x * 2")
        self.assertIn("GLOBAL = 2", result.document.globals_code)

        app_document = result.document.to_app_dict()
        self.assertEqual(app_document["version"], 1)
        self.assertEqual(app_document["readOnly"], False)
        self.assertEqual(app_document["globalsCode"], result.document.globals_code)
        self.assertNotIn("path", app_document)
        self.assertNotIn("issues", app_document)
        self.assertEqual(
            app_document["edges"],
            [
                {"fromNode": "load", "toNode": "double"},
                {"fromNode": "double", "toNode": "format"},
            ],
        )
        self.assertNotIn("functionSource", app_document["nodes"][0])
        self.assertIn("GLOBAL = 2", app_document["nodes"][0]["runtimeCode"])

        target_plan = build_run_plan(result.document, "format")
        self.assertEqual(
            target_plan.to_dict(),
            {
                "targetNodeIds": ["format"],
                "steps": [
                    {"nodeId": "load", "dependsOn": []},
                    {"nodeId": "double", "dependsOn": ["load"]},
                    {"nodeId": "format", "dependsOn": ["double"]},
                ],
            },
        )
        self.assertEqual(build_full_graph_plan(result.document).to_dict(), target_plan.to_dict())

    def test_preserves_rowcall_module_imports_in_globals(self) -> None:
        source = """
import rowcall as nb
from rowcall import node

@node(id="show", outputs=["x"])
def show():
    nb.display({"seen": True})
    x = 1
    return {"x": x}
""".lstrip()

        result = parse_source(source, Path("/tmp/import_rowcall.py"))

        self.assertTrue(result.ok)
        self.assertIsNotNone(result.document)
        assert result.document is not None
        self.assertIn("import rowcall as nb", result.document.globals_code)
        self.assertNotIn("from rowcall import node", result.document.globals_code)

    def test_rejects_aliased_from_rowcall_imports(self) -> None:
        source = """
from rowcall import display as show, node

@node(id="show", outputs=["x"])
def show_value():
    show({"seen": True})
    return {"x": 1}
""".lstrip()

        result = parse_source(source, Path("/tmp/aliased_rowcall_import.py"))

        self.assertFalse(result.ok)
        self.assertEqual(result.issues[0].kind, "unsupported_python")
        self.assertEqual(result.issues[0].message, "from rowcall imports may not use aliases")

    def test_rejects_expression_in_return_dictionary_with_precise_fix(self) -> None:
        source = """
from rowcall import node

@node(id="show", outputs=["x"])
def show_value():
    return {"x": 1}
""".lstrip()

        result = parse_source(source, Path("/tmp/literal_return.py"))

        self.assertFalse(result.ok)
        self.assertEqual(len(result.issues), 1)
        issue = result.issues[0]
        self.assertEqual(issue.kind, "invalid_node_return")
        self.assertEqual(issue.node_id, "show")
        self.assertEqual(issue.path, "5:18")
        self.assertIn("same-named variable 'x'", issue.message)
        self.assertIn("not the expression '1'", issue.message)
        self.assertIn("Assign the expression to 'x' before the return", issue.message)
        self.assertIn("rowcall help format", issue.message)

    def test_rejects_return_keys_that_do_not_match_declared_outputs(self) -> None:
        source = """
from rowcall import node

@node(id="show", outputs=["x", "y"])
def show_value():
    x = 1
    y = 2
    return {"y": y, "x": x}
""".lstrip()

        result = parse_source(source, Path("/tmp/mismatched_return.py"))

        self.assertFalse(result.ok)
        self.assertEqual(len(result.issues), 1)
        issue = result.issues[0]
        self.assertEqual(issue.kind, "invalid_node_return")
        self.assertIn("returns outputs ['y', 'x']", issue.message)
        self.assertIn("declares ['x', 'y']", issue.message)

    def test_reports_every_inline_return_expression_in_one_validation(self) -> None:
        source = """
from rowcall import node

@node(id="load", outputs=["path", "shape"])
def load():
    original_path = "image.jpg"
    image = object()
    return {"path": str(original_path), "shape": image.shape}
""".lstrip()

        result = parse_source(source, Path("/tmp/multiple_inline_outputs.py"))

        self.assertFalse(result.ok)
        return_issues = [
            issue for issue in result.issues if issue.kind == "invalid_node_return"
        ]
        self.assertEqual([issue.node_id for issue in return_issues], ["load", "load"])
        self.assertIn("not the expression 'str(original_path)'", return_issues[0].message)
        self.assertIn("not the expression 'image.shape'", return_issues[1].message)

    def test_allows_an_input_parameter_to_be_returned_as_an_output(self) -> None:
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

        result = parse_source(source, Path("/tmp/parameter_output.py"))

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])

    def test_rejects_module_global_returned_as_a_node_output(self) -> None:
        source = """
from rowcall import node

result = 41

@node(id="global", outputs=["result"])
def use_global():
    return {"result": result}
""".lstrip()

        parsed = parse_source(source, Path("/tmp/global_output.py"))

        self.assertFalse(parsed.ok)
        issue = parsed.issues[0]
        self.assertEqual(issue.kind, "invalid_node_return")
        self.assertEqual(issue.node_id, "global")
        self.assertEqual(issue.path, "7:23")
        self.assertIn("must be a local variable or parameter", issue.message)
        self.assertIn("resolves outside the node function", issue.message)

    def test_rejects_global_declaration_as_a_node_output_binding(self) -> None:
        source = """
from rowcall import node

result = 41

@node(id="global", outputs=["result"])
def update_global():
    global result
    result += 1
    return {"result": result}
""".lstrip()

        parsed = parse_source(source, Path("/tmp/global_declaration_output.py"))

        self.assertFalse(parsed.ok)
        self.assertEqual(parsed.issues[0].kind, "invalid_node_return")

    def test_nested_scope_binding_does_not_define_a_node_output(self) -> None:
        source = """
from rowcall import node

@node(id="nested", outputs=["result"])
def nested():
    def helper():
        result = 41
        return result
    helper()
    return {"result": result}
""".lstrip()

        parsed = parse_source(source, Path("/tmp/nested_output.py"))

        self.assertFalse(parsed.ok)
        self.assertEqual(parsed.issues[0].kind, "invalid_node_return")

    def test_rejects_multiple_or_conditional_node_returns(self) -> None:
        source = """
from rowcall import node

@node(id="choose", outputs=["x"])
def choose(flag):
    if flag:
        x = 1
        return {"x": x}
    x = 2
    return {"x": x}
""".lstrip()

        result = parse_source(source, Path("/tmp/multiple_returns.py"))

        self.assertFalse(result.ok)
        issue = next(item for item in result.issues if item.kind == "invalid_node_return")
        self.assertIn("exactly one return statement", issue.message)

    def test_nested_helper_return_does_not_make_node_return_custom(self) -> None:
        source = """
from rowcall import node

@node(id="show", outputs=["x"])
def show_value():
    def helper():
        return 1
    x = helper()
    return {"x": x}
""".lstrip()

        result = parse_source(source, Path("/tmp/nested_return.py"))

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        assert result.document is not None
        self.assertTrue(result.document.nodes[0].editable)
        self.assertFalse(result.document.nodes[0].custom_return)

    def test_rejects_unsupported_from_rowcall_import_names(self) -> None:
        source = """
from rowcall import RowcallNodeError, node

@node(id="show", outputs=["x"])
def show_value():
    error_type = RowcallNodeError
    return {"x": error_type.__name__}
""".lstrip()

        result = parse_source(source, Path("/tmp/unsupported_rowcall_import.py"))

        self.assertFalse(result.ok)
        self.assertEqual(result.issues[0].kind, "unsupported_python")
        self.assertEqual(
            result.issues[0].message,
            "from rowcall imports may only include display and node",
        )

    def test_reports_shape_and_graph_validation_issues(self) -> None:
        source = """
from rowcall import node

@node(id="a", outputs=["value"])
def first():
    return {"value": 1}

@node(id="a", outputs=["value"])
def second(*args):
    return first()

second.depends_on(first, missing, 1)
first.depends_on(second)
""".lstrip()

        result = parse_source(source, Path("/tmp/bad.py"))

        self.assertFalse(result.ok)
        kinds = [issue.kind for issue in result.issues]
        self.assertIn("duplicate_node_id", kinds)
        self.assertIn("unsupported_python", kinds)
        self.assertIn("missing_node_reference", kinds)
        self.assertIn("cycle", kinds)

    def test_rejects_node_parameters_without_upstream_outputs(self) -> None:
        source = """
from rowcall import node

@node(id="root", outputs=["value"])
def root(missing):
    return {"value": missing}

@node(id="child", outputs=["result"])
def child(value, also_missing):
    return {"result": value + also_missing}

child.depends_on(root)
""".lstrip()

        result = parse_source(source, Path("/tmp/missing_inputs.py"))

        self.assertFalse(result.ok)
        issues = [issue.to_dict() for issue in result.issues]
        self.assertIn(
            {
                "kind": "unsupported_python",
                "message": "Node 'root' has parameters without direct upstream outputs: missing",
                "nodeId": "root",
            },
            issues,
        )
        self.assertIn(
            {
                "kind": "unsupported_python",
                "message": "Node 'child' has parameters without direct upstream outputs: also_missing",
                "nodeId": "child",
            },
            issues,
        )

    def test_rejects_extra_node_function_decorators(self) -> None:
        source = """
from rowcall import node

def wrap(fn):
    return fn

@wrap
@node(id="decorated", outputs=["value"])
def decorated():
    return {"value": 1}
""".lstrip()

        result = parse_source(source, Path("/tmp/decorated.py"))

        self.assertFalse(result.ok)
        issues = [issue.to_dict() for issue in result.issues]
        self.assertIn(
            {
                "kind": "unsupported_python",
                "message": "Node functions may not use decorators other than @node(...)",
                "nodeId": "decorated",
                "path": "6:2",
            },
            issues,
        )

    def test_hello_world_example_graph_and_plan(self) -> None:
        result = self.parse_fixture("examples/hello_world.py")

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        self.assertIsNotNone(result.document)
        assert result.document is not None
        self.assertEqual([node.id for node in result.document.nodes], ["n_load", "n_shout"])
        self.assertEqual(
            [(edge.from_node, edge.to_node) for edge in result.document.edges],
            [("n_load", "n_shout")],
        )
        self.assertEqual(get_sink_node_ids(result.document), ("n_shout",))
        self.assertEqual(
            build_full_graph_plan(result.document).to_dict(),
            {
                "targetNodeIds": ["n_shout"],
                "steps": [
                    {"nodeId": "n_load", "dependsOn": []},
                    {"nodeId": "n_shout", "dependsOn": ["n_load"]},
                ],
            },
        )

    def test_ecommerce_example_graph_sinks_and_target_plan(self) -> None:
        result = self.parse_fixture("examples/ecommerce/analysis.py")

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        self.assertIsNotNone(result.document)
        assert result.document is not None
        self.assertEqual(
            [node.id for node in result.document.nodes],
            [
                "n_load_orders",
                "n_load_customers",
                "n_load_campaigns",
                "n_load_support",
                "n_prepare_orders",
                "n_prepare_customers",
                "n_prepare_campaigns",
                "n_summarize_support",
                "n_build_customer_facts",
                "n_campaign_roi",
                "n_segment_revenue",
                "n_retention_risk",
            ],
        )
        self.assertEqual(
            [(edge.from_node, edge.to_node) for edge in result.document.edges],
            [
                ("n_load_orders", "n_prepare_orders"),
                ("n_load_customers", "n_prepare_customers"),
                ("n_load_campaigns", "n_prepare_campaigns"),
                ("n_load_support", "n_summarize_support"),
                ("n_prepare_orders", "n_build_customer_facts"),
                ("n_prepare_customers", "n_build_customer_facts"),
                ("n_summarize_support", "n_build_customer_facts"),
                ("n_build_customer_facts", "n_campaign_roi"),
                ("n_prepare_campaigns", "n_campaign_roi"),
                ("n_build_customer_facts", "n_segment_revenue"),
                ("n_build_customer_facts", "n_retention_risk"),
            ],
        )
        self.assertEqual(
            get_sink_node_ids(result.document),
            ("n_campaign_roi", "n_segment_revenue", "n_retention_risk"),
        )
        self.assertEqual(
            build_run_plan(result.document, "n_build_customer_facts").to_dict(),
            {
                "targetNodeIds": ["n_build_customer_facts"],
                "steps": [
                    {"nodeId": "n_load_orders", "dependsOn": []},
                    {"nodeId": "n_load_customers", "dependsOn": []},
                    {"nodeId": "n_load_support", "dependsOn": []},
                    {"nodeId": "n_prepare_orders", "dependsOn": ["n_load_orders"]},
                    {"nodeId": "n_prepare_customers", "dependsOn": ["n_load_customers"]},
                    {"nodeId": "n_summarize_support", "dependsOn": ["n_load_support"]},
                    {
                        "nodeId": "n_build_customer_facts",
                        "dependsOn": [
                            "n_prepare_orders",
                            "n_prepare_customers",
                            "n_summarize_support",
                        ],
                    },
                ],
            },
        )

    def test_realistic_examples_smoke_parse_without_execution(self) -> None:
        for relative_path in [
            "examples/polars_orders.py",
            "examples/transit_reliability/challenge.py",
        ]:
            with self.subTest(relative_path=relative_path):
                result = self.parse_fixture(relative_path)
                self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
                self.assertIsNotNone(result.document)
                assert result.document is not None
                self.assertGreater(len(result.document.nodes), 0)
                self.assertGreater(len(result.document.edges), 0)

    def test_conflicting_direct_upstream_outputs_are_invalid(self) -> None:
        source = """
from rowcall import node

@node(id="left", outputs=["value"])
def left():
    value = 1
    return {"value": value}

@node(id="right", outputs=["value"])
def right():
    value = 2
    return {"value": value}

@node(id="merge", outputs=["total"])
def merge(value):
    total = value
    return {"total": total}

merge.depends_on(left, right)
""".lstrip()

        result = parse_source(source, Path("/tmp/conflict.py"))

        self.assertFalse(result.ok)
        self.assertIn("conflicting_outputs", [issue.kind for issue in result.issues])

    def test_sequential_duplicate_output_names_are_valid(self) -> None:
        source = """
from rowcall import node

@node(id="first", outputs=["value"])
def first():
    value = 1
    return {"value": value}

@node(id="second", outputs=["value"])
def second(value):
    value = value + 1
    return {"value": value}

@node(id="third", outputs=["total"])
def third(value):
    total = value * 2
    return {"total": total}

second.depends_on(first)
third.depends_on(second)
""".lstrip()

        result = parse_source(source, Path("/tmp/sequential.py"))

        self.assertTrue(result.ok, [issue.to_dict() for issue in result.issues])
        self.assertIsNotNone(result.document)
        assert result.document is not None
        self.assertEqual(
            build_run_plan(result.document, "third").to_dict(),
            {
                "targetNodeIds": ["third"],
                "steps": [
                    {"nodeId": "first", "dependsOn": []},
                    {"nodeId": "second", "dependsOn": ["first"]},
                    {"nodeId": "third", "dependsOn": ["second"]},
                ],
            },
        )

    def test_invalid_node_decorators_and_non_literal_outputs_are_reported(self) -> None:
        source = """
from rowcall import node

OUTPUTS = ["x"]

@node("bad", outputs=["x"])
def positional_decorator():
    x = 1
    return {"x": x}

@node(id="dynamic", outputs=OUTPUTS)
def dynamic_outputs():
    x = 2
    return {"x": x}
""".lstrip()

        result = parse_source(source, Path("/tmp/invalid_decorators.py"))

        self.assertFalse(result.ok)
        self.assertEqual([issue.kind for issue in result.issues], ["wrong_type", "wrong_type"])

    def test_missing_upstream_and_downstream_references_are_reported(self) -> None:
        source = """
from rowcall import node

@node(id="present", outputs=["value"])
def present():
    value = 1
    return {"value": value}

present.depends_on(missing_upstream)
missing_downstream.depends_on(present)
""".lstrip()

        result = parse_source(source, Path("/tmp/missing_refs.py"))

        self.assertFalse(result.ok)
        self.assertEqual(
            [(issue.kind, issue.node_id) for issue in result.issues],
            [
                ("missing_node_reference", "present"),
                ("missing_node_reference", None),
            ],
        )

    def test_direct_node_calls_are_reported(self) -> None:
        source = """
from rowcall import node

@node(id="a", outputs=["x"])
def a():
    x = 1
    return {"x": x}

@node(id="b", outputs=["y"])
def b():
    y = a()["x"] + 1
    return {"y": y}
""".lstrip()

        result = parse_source(source, Path("/tmp/direct_call.py"))

        self.assertFalse(result.ok)
        self.assertEqual([issue.kind for issue in result.issues], ["unsupported_python"])
        self.assertIn("calls node 'a' directly", result.issues[0].message)

    def test_unsupported_parameters_and_depends_on_arguments_are_reported(self) -> None:
        source = """
from rowcall import node

@node(id="source", outputs=["x"])
def source():
    x = 1
    return {"x": x}

@node(id="bad_params", outputs=["y"])
def bad_params(__rowcall_reserved, *args, **kwargs):
    y = __rowcall_reserved
    return {"y": y}

bad_params.depends_on(source, 1, extra=source)
bad_params.depends_on()
""".lstrip()

        result = parse_source(source, Path("/tmp/unsupported_params.py"))

        self.assertFalse(result.ok)
        messages_by_kind = [(issue.kind, issue.message) for issue in result.issues]
        self.assertIn(
            ("unsupported_python", "Node functions may not use *args or **kwargs"),
            messages_by_kind,
        )
        self.assertIn(
            (
                "unsupported_python",
                "Node parameter names may not start with __rowcall_",
            ),
            messages_by_kind,
        )
        self.assertIn(
            (
                "unsupported_python",
                "depends_on declarations may not use keyword arguments",
            ),
            messages_by_kind,
        )
        self.assertIn(
            (
                "unsupported_python",
                "depends_on arguments must be node function names",
            ),
            messages_by_kind,
        )
        self.assertIn(
            (
                "unsupported_python",
                "depends_on declarations must include at least one upstream node",
            ),
            messages_by_kind,
        )


if __name__ == "__main__":
    unittest.main()
