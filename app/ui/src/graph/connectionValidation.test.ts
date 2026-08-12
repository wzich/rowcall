import { assertEquals } from "@std/assert";
import type { RowcallDocumentV1 } from "./documentTypes.ts";
import { getDirectOutputConflictsForConnection } from "./connectionValidation.ts";

function createDocument(
  nodes: RowcallDocumentV1["nodes"],
  edges: RowcallDocumentV1["edges"] = [],
): RowcallDocumentV1 {
  return { version: 1, nodes, edges };
}

Deno.test("connection conflict finds duplicate outputs from direct parents", () => {
  const document = createDocument(
    [
      { id: "left", code: "pass", outputs: ["df"], views: [] },
      { id: "right", code: "pass", outputs: ["df"], views: [] },
      { id: "merge", code: "pass", outputs: [], views: [] },
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
      { id: "first", code: "pass", outputs: ["df", "count"], views: [] },
      { id: "second", code: "pass", outputs: ["df"], views: [] },
      { id: "third", code: "pass", outputs: ["count"], views: [] },
      { id: "merge", code: "pass", outputs: [], views: [] },
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
      { id: "ancestor", code: "pass", outputs: ["df"], views: [] },
      { id: "parent", code: "pass", outputs: ["prepared"], views: [] },
      { id: "other", code: "pass", outputs: ["df"], views: [] },
      { id: "merge", code: "pass", outputs: [], views: [] },
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
      { id: "left", code: "pass", outputs: ["customers"], views: [] },
      { id: "right", code: "pass", outputs: ["orders"], views: [] },
      { id: "merge", code: "pass", outputs: [], views: [] },
    ],
    [{ fromNode: "left", toNode: "merge" }],
  );

  assertEquals(
    getDirectOutputConflictsForConnection(document, "right", "merge"),
    [],
  );
});
