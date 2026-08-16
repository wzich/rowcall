import { assert, assertEquals } from "@std/assert";
import { createSimpleLayout } from "./layout.ts";
import type { RuntimeGraph } from "./runtimeTypes.ts";

Deno.test("createSimpleLayout returns no positions for an empty graph", () => {
  assertEquals(createSimpleLayout({ nodes: [], edges: [] }), {});
});

Deno.test("createSimpleLayout places a chain from left to right", () => {
  const positions = createSimpleLayout(graph(
    ["source", "transform", "result"],
    [
      ["source", "transform"],
      ["transform", "result"],
    ],
  ));

  assert(positions.source.x < positions.transform.x);
  assert(positions.transform.x < positions.result.x);
  assertEquals(positions.source.y, positions.transform.y);
  assertEquals(positions.transform.y, positions.result.y);
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

  assertEquals(positions.left.x, positions.right.x);
  assert(positions.source.x < positions.left.x);
  assert(positions.left.x < positions.join.x);
  assert(positions.left.y !== positions.right.y);
  assertEquals(
    positions.source.y,
    midpoint(positions.left.y, positions.right.y),
  );
  assertEquals(positions.source.y, positions.join.y);
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

  assertEquals(positions.source_a.x, positions.source_b.x);
  assertEquals(positions.child_a.x, positions.child_b.x);
  assert(positions.source_a.x < positions.child_a.x);
  assert(positions.child_a.x < positions.join.x);
  assertEquals(
    Math.sign(positions.source_a.y - positions.source_b.y),
    Math.sign(positions.child_a.y - positions.child_b.y),
  );
});

Deno.test("createSimpleLayout uses measured node heights", () => {
  const positions = createSimpleLayout(
    graph(
      ["source", "short", "tall", "join"],
      [
        ["source", "short"],
        ["source", "tall"],
        ["short", "join"],
        ["tall", "join"],
      ],
    ),
    {
      source: { width: 360, height: 120 },
      short: { width: 360, height: 120 },
      tall: { width: 360, height: 420 },
      join: { width: 360, height: 120 },
    },
  );

  assertEquals(positions.short.x, positions.tall.x);
  const verticalGap = positions.short.y < positions.tall.y
    ? positions.tall.y - (positions.short.y + 120)
    : positions.short.y - (positions.tall.y + 420);
  assert(verticalGap >= 56);
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
    edges: edges.map(([fromNode, toNode]) => ({
      fromNode,
      fromOutput: "value",
      toNode,
      toInput: "value",
    })),
  };
}

function midpoint(first: number, second: number): number {
  return (first + second) / 2;
}
