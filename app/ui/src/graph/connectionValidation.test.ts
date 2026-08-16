import { assertEquals } from "@std/assert";
import type { RowcallDocumentV1 } from "./documentTypes.ts";
import { getConnectionConflict } from "./connectionValidation.ts";

function createDocument(
  edges: RowcallDocumentV1["edges"] = [],
): RowcallDocumentV1 {
  return {
    version: 1,
    nodes: [
      { id: "split", code: "pass", outputs: ["train", "test"] },
      { id: "other", code: "pass", outputs: ["train"] },
      { id: "fit", code: "pass", outputs: [] },
    ],
    edges,
  };
}

Deno.test("connection validation identifies an exact duplicate route", () => {
  const document = createDocument([
    {
      fromNode: "split",
      fromOutput: "train",
      toNode: "fit",
      toInput: "train",
    },
  ]);

  assertEquals(
    getConnectionConflict(document, "split", "train", "fit", "train"),
    "duplicate",
  );
});

Deno.test("connection validation rejects a second owner for one input", () => {
  const document = createDocument([
    {
      fromNode: "split",
      fromOutput: "train",
      toNode: "fit",
      toInput: "training_data",
    },
  ]);

  assertEquals(
    getConnectionConflict(
      document,
      "other",
      "train",
      "fit",
      "training_data",
    ),
    "input_bound",
  );
});

Deno.test("connection validation allows parallel routes to different inputs", () => {
  const document = createDocument([
    {
      fromNode: "split",
      fromOutput: "train",
      toNode: "fit",
      toInput: "train",
    },
  ]);

  assertEquals(
    getConnectionConflict(document, "split", "test", "fit", "test"),
    null,
  );
});
