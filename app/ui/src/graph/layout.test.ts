import { assert, assertEquals } from "@std/assert";
import { createSimpleLayout } from "./layout.ts";
import type { RuntimeGraph } from "./runtimeTypes.ts";

Deno.test("createSimpleLayout returns no positions for an empty graph", () => {
  assertEquals(createSimpleLayout({ nodes: [], edges: [] }), {});
});

Deno.test("createSimpleLayout places a chain from top to bottom", () => {
  const positions = createSimpleLayout(graph(
    ["source", "transform", "result"],
    [
      ["source", "transform"],
      ["transform", "result"],
    ],
  ));

  assert(positions.source.y < positions.transform.y);
  assert(positions.transform.y < positions.result.y);
  assertEquals(positions.source.x, positions.transform.x);
  assertEquals(positions.transform.x, positions.result.x);
});

Deno.test("createSimpleLayout centers a fork and join around their siblings", () => {
  const positions = createSimpleLayout(graph(
    ["source", "left", "right", "join"],
    [
      ["source", "left"],
      ["source", "right"],
      ["left", "join"],
      ["right", "join"],
    ],
  ));

  assertEquals(positions.left.y, positions.right.y);
  assert(positions.source.y < positions.left.y);
  assert(positions.left.y < positions.join.y);
  assert(positions.left.x !== positions.right.x);
  assertEquals(
    centerX(positions.source.x),
    midpoint(centerX(positions.left.x), centerX(positions.right.x)),
  );
  assertEquals(positions.source.x, positions.join.x);
});

Deno.test("createSimpleLayout keeps parallel pipelines in stable lanes", () => {
  const positions = createSimpleLayout(graph(
    ["source_a", "source_b", "child_a", "child_b", "join"],
    [
      ["source_a", "child_a"],
      ["source_b", "child_b"],
      ["child_a", "join"],
      ["child_b", "join"],
    ],
  ));

  assertEquals(positions.source_a.y, positions.source_b.y);
  assertEquals(positions.child_a.y, positions.child_b.y);
  assert(positions.source_a.y < positions.child_a.y);
  assert(positions.child_a.y < positions.join.y);
  assertEquals(
    Math.sign(positions.source_a.x - positions.source_b.x),
    Math.sign(positions.child_a.x - positions.child_b.x),
  );
});

Deno.test("createSimpleLayout is deterministic", () => {
  const runtimeGraph = graph(
    ["a", "b", "c", "d", "e"],
    [
      ["a", "c"],
      ["b", "c"],
      ["b", "d"],
      ["c", "e"],
      ["d", "e"],
    ],
  );

  assertEquals(
    createSimpleLayout(runtimeGraph),
    createSimpleLayout(runtimeGraph),
  );
});

function graph(
  nodeIds: string[],
  edges: Array<[fromNode: string, toNode: string]>,
): RuntimeGraph {
  return {
    nodes: nodeIds.map((id) => ({
      id,
      code: "",
      outputs: [],
    })),
    edges: edges.map(([fromNode, toNode]) => ({ fromNode, toNode })),
  };
}

function centerX(left: number): number {
  return left + 180;
}

function midpoint(first: number, second: number): number {
  return (first + second) / 2;
}
