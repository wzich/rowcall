import { assertEquals, assertExists, assertObjectMatch } from "@std/assert";
import {
  streamRunGraph,
  streamRunSingleNode,
  streamRunToNode,
} from "./executor.ts";
import type { ExecutionStreamEvent, Graph } from "./types.ts";

async function collectEvents(
  events: AsyncIterable<ExecutionStreamEvent>,
): Promise<ExecutionStreamEvent[]> {
  const collected: ExecutionStreamEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

Deno.test("streamRunGraph emits progress events and final response", async () => {
  const graph: Graph = {
    nodes: [
      {
        id: "a",
        code: 'x = 1\nprint("a done")',
        outputs: ["x"],
      },
      {
        id: "b",
        code: 'y = x + 1\nprint("b done")',
        outputs: ["y"],
      },
    ],
    edges: [{ fromNode: "a", toNode: "b" }],
  };

  const events = await collectEvents(streamRunGraph("run-1", graph, {}, true));

  assertEquals(events.map((event) => event.type), [
    "run_started",
    "run_plan",
    "node_started",
    "node_completed",
    "node_started",
    "node_completed",
    "run_completed",
  ]);
  assertObjectMatch(events[1], {
    type: "run_plan",
    plan: {
      targetNodeIds: ["b"],
      steps: [
        { nodeId: "a", dependsOn: [] },
        { nodeId: "b", dependsOn: ["a"] },
      ],
    },
  });

  const finalEvent = events.at(-1);
  assertExists(finalEvent);
  assertObjectMatch(finalEvent, {
    type: "run_completed",
    response: {
      ok: true,
      executedNodeIds: ["a", "b"],
      finalOutputsByNode: { b: { y: 2 } },
    },
  });
});

Deno.test("streamRunToNode stops after the first failed node", async () => {
  const graph: Graph = {
    nodes: [
      {
        id: "a",
        code: "x = missing_name",
        outputs: ["x"],
      },
      {
        id: "b",
        code: "y = x + 1",
        outputs: ["y"],
      },
    ],
    edges: [{ fromNode: "a", toNode: "b" }],
  };

  const events = await collectEvents(streamRunToNode("run-2", graph, "b"));

  assertEquals(events.map((event) => event.type), [
    "run_started",
    "run_plan",
    "node_started",
    "node_failed",
    "run_failed",
  ]);

  const finalEvent = events.at(-1);
  assertExists(finalEvent);
  assertObjectMatch(finalEvent, {
    type: "run_failed",
    response: {
      ok: false,
      executedNodeIds: ["a"],
      error: {
        kind: "runtime_error",
        nodeId: "a",
      },
    },
  });
});

Deno.test("streamRunSingleNode only plans and executes the requested node", async () => {
  const events = await collectEvents(
    streamRunSingleNode("run-3", {
      id: "single",
      code: "x = input_value + 1",
      outputs: ["x"],
    }, { input_value: 41 }),
  );

  assertEquals(events.map((event) => event.type), [
    "run_started",
    "run_plan",
    "node_started",
    "node_completed",
    "run_completed",
  ]);
  const finalEvent = events.at(-1);
  assertExists(finalEvent);
  assertObjectMatch(finalEvent, {
    type: "run_completed",
    response: {
      ok: true,
      finalOutputsByNode: { single: { x: 42 } },
    },
  });
});
