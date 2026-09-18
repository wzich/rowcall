import { assertEquals } from "@std/assert";
import type { Edge, NodeRunResult } from "../../../../types.ts";
import { getUpstreamInputPreviews } from "./upstreamInputPreviews.ts";

const result: NodeRunResult = {
  ok: true,
  stdout: "",
  stderr: "",
  displays: [],
  warnings: [],
  variables: {},
  outputs: { frame: { name: "frame", type: "DataFrame", repr: "saved table" } },
};
const route: Edge = {
  fromNode: "parent",
  fromOutput: "frame",
  toNode: "child",
  toInput: "data",
};

Deno.test("unrun child resolves renamed inputs from successful parent outputs", () => {
  const inputs = getUpstreamInputPreviews(
    "child",
    [route],
    { parent: result },
    { parent: "Prepare data" },
    { parent: "completed" },
  );
  assertEquals(inputs.data, {
    preview: { ...result.outputs.frame, name: "data" },
    source: "Prepare data",
    status: "completed",
  });
  assertEquals(result.outputs.frame.name, "frame");
});

Deno.test("mixed inputs retain stale context and represent missing outputs independently", () => {
  const inputs = getUpstreamInputPreviews(
    "child",
    [route, { ...route, fromNode: "unrun", toInput: "other" }, {
      ...route,
      fromOutput: "removed",
      toInput: "missing",
    }],
    { parent: result },
    {},
    { parent: "stale" },
  );
  assertEquals(inputs.data.status, "stale");
  assertEquals(inputs.data.preview?.repr, "saved table");
  assertEquals(inputs.other.preview, undefined);
  assertEquals(inputs.missing.preview, undefined);
});

Deno.test("rewiring and removal use only current routes and never failed outputs", () => {
  const results = { parent: result, failed: { ...result, ok: false } };
  assertEquals(getUpstreamInputPreviews("child", [], results, {}, {}), {});
  const inputs = getUpstreamInputPreviews(
    "child",
    [
      { ...route, fromNode: "failed" },
      { ...route, toNode: "different-child" },
    ],
    results,
    {},
    {},
  );
  assertEquals(Object.keys(inputs), ["data"]);
  assertEquals(inputs.data.source, "failed");
  assertEquals(inputs.data.preview, undefined);
});
