import { assertEquals } from "@std/assert";
import type { DocumentOperation } from "./api/documents.ts";
import {
  coalesceDocumentOperations,
  deriveRoutedOutputs,
  documentOperationAffectsExecution,
  hasCustomManagedDownstream,
} from "./documentOperations.ts";
import type { RowcallDocumentV1 } from "./graph/documentTypes.ts";
import { detectPureOutputRename } from "./graph/outputRename.ts";

Deno.test("only executable document operations invalidate results", () => {
  assertEquals(
    [
      {
        type: "move_node",
        nodeId: "n_test",
        position: { x: 10, y: 20 },
      },
      { type: "update_node_title", nodeId: "n_test", title: "Test" },
      {
        type: "update_node_description",
        nodeId: "n_test",
        description: "A test step.",
      },
    ].map((operation) =>
      documentOperationAffectsExecution(operation as DocumentOperation)
    ),
    [false, false, false],
  );

  assertEquals(
    [
      { type: "update_globals", code: "value = 1" },
      { type: "update_node_body", nodeId: "n_test", code: "value = 2" },
      { type: "delete_node", nodeId: "n_test" },
    ].map((operation) =>
      documentOperationAffectsExecution(operation as DocumentOperation)
    ),
    [true, true, true],
  );
});

Deno.test("coalesceDocumentOperations cancels a new node deleted before save", () => {
  const operations: DocumentOperation[] = [
    {
      type: "add_node",
      node: {
        id: "n_new",
        functionName: "new_step",
        code: "value = 1",
        outputs: ["value"],
      },
    },
    {
      type: "move_node",
      nodeId: "n_new",
      position: { x: 10, y: 20 },
    },
    {
      type: "add_edge",
      fromNode: "n_existing",
      fromOutput: "value",
      toNode: "n_new",
      toInput: "value",
    },
    { type: "delete_node", nodeId: "n_new" },
  ];

  assertEquals(coalesceDocumentOperations(operations), []);
});

Deno.test("coalesceDocumentOperations keeps only delete after existing node edits", () => {
  const operations: DocumentOperation[] = [
    { type: "update_node_body", nodeId: "n_existing", code: "value = 2" },
    {
      type: "move_node",
      nodeId: "n_existing",
      position: { x: 10, y: 20 },
    },
    {
      type: "remove_edge",
      fromNode: "n_parent",
      fromOutput: "value",
      toNode: "n_existing",
      toInput: "value",
    },
    { type: "delete_node", nodeId: "n_existing" },
  ];

  assertEquals(coalesceDocumentOperations(operations), [
    { type: "delete_node", nodeId: "n_existing" },
  ]);
});

Deno.test("coalesceDocumentOperations preserves delete after replacement node is deleted", () => {
  const operations: DocumentOperation[] = [
    { type: "delete_node", nodeId: "n_reused" },
    {
      type: "add_node",
      node: {
        id: "n_reused",
        functionName: "new_step",
        code: "value = 1",
        outputs: ["value"],
      },
    },
    {
      type: "move_node",
      nodeId: "n_reused",
      position: { x: 10, y: 20 },
    },
    { type: "delete_node", nodeId: "n_reused" },
  ];

  assertEquals(coalesceDocumentOperations(operations), [
    { type: "delete_node", nodeId: "n_reused" },
  ]);
});

Deno.test("coalesceDocumentOperations keeps the latest replaceable operation", () => {
  const operations: DocumentOperation[] = [
    {
      type: "move_node",
      nodeId: "n_test",
      position: { x: 10, y: 20 },
    },
    {
      type: "move_node",
      nodeId: "n_test",
      position: { x: 30, y: 40 },
    },
  ];

  assertEquals(coalesceDocumentOperations(operations), [
    {
      type: "move_node",
      nodeId: "n_test",
      position: { x: 30, y: 40 },
    },
  ]);
});

Deno.test("coalesceDocumentOperations deduplicates repeated add node operations", () => {
  const firstAdd: DocumentOperation = {
    type: "add_node",
    node: {
      id: "n_new",
      functionName: "new_step",
      code: "value = 1",
      outputs: ["value"],
    },
  };
  const secondAdd: DocumentOperation = {
    type: "add_node",
    node: {
      id: "n_new",
      functionName: "new_step",
      code: "value = 2",
      outputs: ["value"],
    },
  };

  assertEquals(coalesceDocumentOperations([firstAdd, secondAdd]), [secondAdd]);
});

Deno.test("coalesceDocumentOperations deduplicates repeated edge operations", () => {
  const addEdge: DocumentOperation = {
    type: "add_edge",
    fromNode: "n_parent",
    fromOutput: "value",
    toNode: "n_child",
    toInput: "value",
  };
  const removeEdge: DocumentOperation = {
    type: "remove_edge",
    fromNode: "n_parent",
    fromOutput: "value",
    toNode: "n_child",
    toInput: "value",
  };

  assertEquals(coalesceDocumentOperations([addEdge, addEdge]), [addEdge]);
  assertEquals(coalesceDocumentOperations([removeEdge, removeEdge]), [
    removeEdge,
  ]);
});

Deno.test("coalesceDocumentOperations cancels inverse edge operations", () => {
  const addEdge: DocumentOperation = {
    type: "add_edge",
    fromNode: "n_parent",
    fromOutput: "value",
    toNode: "n_child",
    toInput: "value",
  };
  const removeEdge: DocumentOperation = {
    type: "remove_edge",
    fromNode: "n_parent",
    fromOutput: "value",
    toNode: "n_child",
    toInput: "value",
  };

  assertEquals(coalesceDocumentOperations([addEdge, removeEdge]), []);
  assertEquals(coalesceDocumentOperations([removeEdge, addEdge]), []);
});

Deno.test("hasCustomManagedDownstream detects non-editable downstream nodes", () => {
  const document: RowcallDocumentV1 = {
    version: 1,
    nodes: [
      { id: "n_source", code: "x = 1", outputs: ["x"] },
      {
        id: "n_editable",
        code: "y = x",
        outputs: ["y"],
        editable: true,
      },
      {
        id: "n_custom",
        code: "z = x",
        outputs: ["z"],
        editable: false,
      },
    ],
    edges: [
      {
        fromNode: "n_source",
        fromOutput: "x",
        toNode: "n_editable",
        toInput: "x",
      },
      {
        fromNode: "n_source",
        fromOutput: "x",
        toNode: "n_custom",
        toInput: "x",
      },
    ],
  };

  assertEquals(hasCustomManagedDownstream(document, "n_source"), true);
  assertEquals(hasCustomManagedDownstream(document, "n_editable"), false);
});

Deno.test("deriveRoutedOutputs keeps only uniquely routed source variables", () => {
  const document: RowcallDocumentV1 = {
    version: 1,
    nodes: [
      {
        id: "split",
        code: "train = []\ntest = []",
        outputs: ["test", "train", "unused"],
      },
      { id: "fit", code: "pass", outputs: [] },
      { id: "evaluate", code: "pass", outputs: [] },
    ],
    edges: [
      {
        fromNode: "split",
        fromOutput: "train",
        toNode: "fit",
        toInput: "train",
      },
      {
        fromNode: "split",
        fromOutput: "test",
        toNode: "evaluate",
        toInput: "test",
      },
      {
        fromNode: "split",
        fromOutput: "train",
        toNode: "evaluate",
        toInput: "train",
      },
    ],
  };

  assertEquals(deriveRoutedOutputs(document, "split"), ["test", "train"]);
  assertEquals(deriveRoutedOutputs(document, "missing"), []);
});

Deno.test("pure output renames are tracked but ambiguous edits are not", () => {
  assertEquals(
    detectPureOutputRename(
      "train = rows[:8]\nmodel = fit(train)",
      "training = rows[:8]\nmodel = fit(training)",
      ["train"],
      ["train", "model"],
      ["training", "model"],
    ),
    { fromOutput: "train", toOutput: "training" },
  );
  assertEquals(
    detectPureOutputRename(
      "train = rows[:8]",
      "test = rows[8:]",
      ["train"],
      ["train"],
      ["test"],
    ),
    null,
  );
});
