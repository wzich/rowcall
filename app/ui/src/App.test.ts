import { assertEquals } from "@std/assert";
import type { DocumentOperation } from "./api/documents.ts";
import {
  coalesceDocumentOperations,
  hasCustomManagedDownstream,
} from "./documentOperations.ts";
import type { NodebookDocumentV1 } from "./graph/documentTypes.ts";

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
    { type: "add_edge", fromNode: "n_existing", toNode: "n_new" },
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
    { type: "remove_edge", fromNode: "n_parent", toNode: "n_existing" },
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
    toNode: "n_child",
  };
  const removeEdge: DocumentOperation = {
    type: "remove_edge",
    fromNode: "n_parent",
    toNode: "n_child",
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
    toNode: "n_child",
  };
  const removeEdge: DocumentOperation = {
    type: "remove_edge",
    fromNode: "n_parent",
    toNode: "n_child",
  };

  assertEquals(coalesceDocumentOperations([addEdge, removeEdge]), []);
  assertEquals(coalesceDocumentOperations([removeEdge, addEdge]), []);
});

Deno.test("hasCustomManagedDownstream detects non-editable downstream nodes", () => {
  const document: NodebookDocumentV1 = {
    version: 1,
    nodes: [
      { id: "n_source", code: "x = 1", outputs: ["x"] },
      { id: "n_editable", code: "y = x", outputs: ["y"], editable: true },
      { id: "n_custom", code: "z = x", outputs: ["z"], editable: false },
    ],
    edges: [
      { fromNode: "n_source", toNode: "n_editable" },
      { fromNode: "n_source", toNode: "n_custom" },
    ],
  };

  assertEquals(hasCustomManagedDownstream(document, "n_source"), true);
  assertEquals(hasCustomManagedDownstream(document, "n_editable"), false);
});
