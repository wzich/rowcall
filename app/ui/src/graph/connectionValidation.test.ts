import { assertEquals } from "@std/assert";
import type { NodebookDocumentV1 } from "./documentTypes.ts";
import { getDirectOutputConflictsForConnection } from "./connectionValidation.ts";

function createDocument(
  nodes: NodebookDocumentV1["nodes"],
  edges: NodebookDocumentV1["edges"] = [],
): NodebookDocumentV1 {
  return { version: 1, nodes, edges };
}

Deno.test("connection conflict finds duplicate outputs from direct parents", () => {
  const document = createDocument(
    [
      { id: "left", code: "pass", outputs: ["df"] },
      { id: "right", code: "pass", outputs: ["df"] },
      { id: "merge", code: "pass", outputs: [] },
    ],
    [{ fromNode: "left", toNode: "merge" }],
  );

  assertEquals(
    getDirectOutputConflictsForConnection(document, "right", "merge"),
    [{ outputName: "df", upstreamNodeIds: ["left", "right"] }],
  );
});

Deno.test("connection conflict reports each ambiguous output and its owners", () => {
  const document = createDocument(
    [
      { id: "first", code: "pass", outputs: ["df", "count"] },
      { id: "second", code: "pass", outputs: ["df"] },
      { id: "third", code: "pass", outputs: ["count"] },
      { id: "merge", code: "pass", outputs: [] },
    ],
    [
      { fromNode: "first", toNode: "merge" },
      { fromNode: "second", toNode: "merge" },
    ],
  );

  assertEquals(
    getDirectOutputConflictsForConnection(document, "third", "merge"),
    [
      { outputName: "df", upstreamNodeIds: ["first", "second"] },
      { outputName: "count", upstreamNodeIds: ["first", "third"] },
    ],
  );
});

Deno.test("connection conflict ignores matching outputs on transitive ancestors", () => {
  const document = createDocument(
    [
      { id: "ancestor", code: "pass", outputs: ["df"] },
      { id: "parent", code: "pass", outputs: ["prepared"] },
      { id: "other", code: "pass", outputs: ["df"] },
      { id: "merge", code: "pass", outputs: [] },
    ],
    [
      { fromNode: "ancestor", toNode: "parent" },
      { fromNode: "parent", toNode: "merge" },
    ],
  );

  assertEquals(
    getDirectOutputConflictsForConnection(document, "other", "merge"),
    [],
  );
});

Deno.test("connection conflict allows direct parents with distinct outputs", () => {
  const document = createDocument(
    [
      { id: "left", code: "pass", outputs: ["customers"] },
      { id: "right", code: "pass", outputs: ["orders"] },
      { id: "merge", code: "pass", outputs: [] },
    ],
    [{ fromNode: "left", toNode: "merge" }],
  );

  assertEquals(
    getDirectOutputConflictsForConnection(document, "right", "merge"),
    [],
  );
});
