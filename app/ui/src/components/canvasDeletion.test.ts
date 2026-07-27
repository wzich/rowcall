import { assertEquals } from "@std/assert";
import { getCanvasDeletionIntent } from "./canvasDeletion.ts";

Deno.test("canvas deletion immediately targets selected edges", () => {
  assertEquals(
    getCanvasDeletionIntent({
      key: "Delete",
      repeat: false,
      selectedNodeId: null,
      selectedEdgeIds: ["a->b"],
    }),
    { type: "edges", edgeIds: ["a->b"] },
  );
});

Deno.test("canvas deletion requests node deletion when no edge is selected", () => {
  assertEquals(
    getCanvasDeletionIntent({
      key: "Backspace",
      repeat: false,
      selectedNodeId: "a",
      selectedEdgeIds: [],
    }),
    { type: "node", nodeId: "a" },
  );
});

Deno.test("selected edges take precedence during a transient mixed selection", () => {
  assertEquals(
    getCanvasDeletionIntent({
      key: "Delete",
      repeat: false,
      selectedNodeId: "a",
      selectedEdgeIds: ["a->b"],
    }),
    { type: "edges", edgeIds: ["a->b"] },
  );
});

Deno.test("canvas deletion ignores held keys and unrelated keys", () => {
  assertEquals(
    getCanvasDeletionIntent({
      key: "Delete",
      repeat: true,
      selectedNodeId: "a",
      selectedEdgeIds: [],
    }),
    null,
  );
  assertEquals(
    getCanvasDeletionIntent({
      key: "Enter",
      repeat: false,
      selectedNodeId: "a",
      selectedEdgeIds: [],
    }),
    null,
  );
});
