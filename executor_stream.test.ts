import {
  assertEquals,
  assertExists,
  assertObjectMatch,
  assertStringIncludes,
} from "@std/assert";
import {
  clearRuntimeSessionCache,
  getPythonEnvironmentInfo,
  resolvePythonCommand,
  shutdownRuntimeSession,
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

async function pythonCanImport(moduleName: string): Promise<boolean> {
  const command = new Deno.Command(await resolvePythonCommand(), {
    args: ["-c", `import ${moduleName}`],
    stdout: "null",
    stderr: "null",
  });
  const output = await command.output();
  return output.success;
}

function runtimeTest(
  name: string,
  fn: () => Promise<void>,
): void {
  Deno.test(name, async () => {
    await clearRuntimeSessionCache();
    try {
      await fn();
    } finally {
      await shutdownRuntimeSession();
    }
  });
}

Deno.test("getPythonEnvironmentInfo reports the resolved Python runtime", async () => {
  const command = await resolvePythonCommand();
  const python = await getPythonEnvironmentInfo();

  assertEquals(python.command, command);
  assertStringIncludes(["python3", "python"].join(","), python.command);
  assertStringIncludes(python.executable.toLowerCase(), "python");
  assertStringIncludes(python.implementation, "Python");
  assertExists(python.version.match(/^\d+\.\d+\.\d+/));
});

runtimeTest(
  "streamRunGraph emits progress events and final response",
  async () => {
    await clearRuntimeSessionCache();
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

    const events = await collectEvents(
      streamRunGraph("run-1", graph, {}, true),
    );

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
        finalOutputsByNode: {
          b: { y: { name: "y", type: "builtins.int", repr: "2" } },
        },
      },
    });
  },
);

runtimeTest(
  "streamRunGraph includes rich pandas table previews when pandas is available",
  async () => {
    if (!(await pythonCanImport("pandas"))) return;

    await clearRuntimeSessionCache();
    const graph: Graph = {
      nodes: [
        {
          id: "a",
          code:
            'import pandas as pd\ndf = pd.DataFrame({"name": ["Ada", "Grace"], "score": [10, 12]})',
          outputs: ["df"],
        },
      ],
      edges: [],
    };

    const events = await collectEvents(streamRunGraph("run-pandas-1", graph));
    const finalEvent = events.at(-1);
    assertExists(finalEvent);

    if (finalEvent.type !== "run_completed") {
      throw new Error("Expected run_completed");
    }

    const table = finalEvent.response.finalOutputsByNode.a.df.table;
    assertExists(table);
    assertEquals(table.columns.map((column) => column.name), ["name", "score"]);
    assertEquals(table.rows, [["Ada", 10], ["Grace", 12]]);
    assertEquals(table.index, [0, 1]);
    assertEquals(table.rowCount, 2);
    assertEquals(table.columnCount, 2);
    assertEquals(table.truncated, false);
  },
);

runtimeTest(
  "streamRunGraph includes rich polars table previews and display events when polars is available",
  async () => {
    if (!(await pythonCanImport("polars"))) return;

    await clearRuntimeSessionCache();
    const graph: Graph = {
      nodes: [
        {
          id: "a",
          code:
            'import polars as pl\nfrom nodebook import display\ndf = pl.DataFrame({"name": ["Ada", "Grace"], "score": [10, 12]})\ndisplay(df.head(1))',
          outputs: ["df"],
        },
      ],
      edges: [],
    };

    const events = await collectEvents(streamRunGraph("run-polars-1", graph));
    const finalEvent = events.at(-1);
    assertExists(finalEvent);

    if (finalEvent.type !== "run_completed") {
      throw new Error("Expected run_completed");
    }

    const result = finalEvent.response.resultsByNode.a;
    const outputTable = result.outputs.df.table;
    assertExists(outputTable);
    assertEquals(outputTable.columns.map((column) => column.name), [
      "name",
      "score",
    ]);
    assertEquals(outputTable.rows, [["Ada", 10], ["Grace", 12]]);
    assertEquals(outputTable.rowCount, 2);
    assertEquals(outputTable.columnCount, 2);

    assertEquals(result.displays.length, 1);
    const displayTable = result.displays[0].value.table;
    assertExists(displayTable);
    assertEquals(displayTable.rows, [["Ada", 10]]);
  },
);

runtimeTest(
  "streamRunGraph preserves inline stdout and display event order",
  async () => {
    await clearRuntimeSessionCache();
    const graph: Graph = {
      nodes: [
        {
          id: "a",
          code:
            'from nodebook import display\nprint("before")\ndisplay({"x": 1})\nprint("after")\ndisplay(2)',
          outputs: [],
        },
      ],
      edges: [],
    };

    const events = await collectEvents(
      streamRunGraph("run-inline-display-1", graph, {}, true),
    );
    const finalEvent = events.at(-1);
    assertExists(finalEvent);

    if (finalEvent.type !== "run_completed") {
      throw new Error("Expected run_completed");
    }

    const result = finalEvent.response.resultsByNode.a;
    assertEquals(result.stdout, "before\nafter\n");
    assertEquals(result.displays.length, 2);
    assertEquals(result.outputEvents.map((event) => event.kind), [
      "stdout",
      "display",
      "stdout",
      "display",
    ]);
    assertEquals(result.outputEvents[0], { kind: "stdout", text: "before\n" });
    assertEquals(result.outputEvents[2], { kind: "stdout", text: "after\n" });

    const trace = finalEvent.response.trace;
    assertExists(trace);
    assertEquals(trace[0].outputEvents.map((event) => event.kind), [
      "stdout",
      "display",
      "stdout",
      "display",
    ]);
  },
);

runtimeTest(
  "streamRunGraph includes jsonValue for small JSON-safe previews",
  async () => {
    await clearRuntimeSessionCache();
    const graph: Graph = {
      nodes: [
        {
          id: "a",
          code:
            'count = 3\nlabel = "ready"\nitems = [1, {"ok": True}, None]\nconfig = {"mode": "test", "enabled": False}',
          outputs: ["count", "label", "items", "config"],
        },
      ],
      edges: [],
    };

    const events = await collectEvents(streamRunGraph("run-json-1", graph));
    const finalEvent = events.at(-1);
    assertExists(finalEvent);

    if (finalEvent.type !== "run_completed") {
      throw new Error("Expected run_completed");
    }

    const outputs = finalEvent.response.finalOutputsByNode.a;
    assertEquals(outputs.count.jsonValue, 3);
    assertEquals(outputs.label.jsonValue, "ready");
    assertEquals(outputs.items.jsonValue, [1, { ok: true }, null]);
    assertEquals(outputs.config.jsonValue, { mode: "test", enabled: false });
  },
);

runtimeTest(
  "streamRunGraph omits jsonValue for non-JSON and oversized previews",
  async () => {
    await clearRuntimeSessionCache();
    const graph: Graph = {
      nodes: [
        {
          id: "a",
          code:
            'class Plain:\n    pass\nobj = Plain()\nlarge = "x" * 17000\nbad_keys = {1: "one"}',
          outputs: ["obj", "large", "bad_keys"],
        },
      ],
      edges: [],
    };

    const events = await collectEvents(streamRunGraph("run-json-2", graph));
    const finalEvent = events.at(-1);
    assertExists(finalEvent);

    if (finalEvent.type !== "run_completed") {
      throw new Error("Expected run_completed");
    }

    const outputs = finalEvent.response.finalOutputsByNode.a;
    assertEquals("jsonValue" in outputs.obj, false);
    assertEquals("jsonValue" in outputs.large, false);
    assertStringIncludes(outputs.large.repr, "...<truncated>");
    assertEquals("jsonValue" in outputs.bad_keys, false);
  },
);

runtimeTest(
  "streamRunGraph includes jsonValue in traced input and output previews",
  async () => {
    await clearRuntimeSessionCache();
    const graph: Graph = {
      nodes: [
        {
          id: "a",
          code: 'payload = {"count": 2}',
          outputs: ["payload"],
        },
        {
          id: "b",
          code: 'result = [payload["count"], 3]',
          outputs: ["result"],
        },
      ],
      edges: [{ fromNode: "a", toNode: "b" }],
    };

    const events = await collectEvents(
      streamRunGraph("run-json-3", graph, {}, true),
    );
    const finalEvent = events.at(-1);
    assertExists(finalEvent);

    if (finalEvent.type !== "run_completed") {
      throw new Error("Expected run_completed");
    }

    const trace = finalEvent.response.trace;
    assertExists(trace);
    assertEquals(trace[0].outputs.payload.jsonValue, { count: 2 });
    assertEquals(trace[1].inputs.payload.jsonValue, { count: 2 });
    assertEquals(trace[1].outputs.result.jsonValue, [2, 3]);
  },
);

runtimeTest("streamRunToNode stops after the first failed node", async () => {
  await clearRuntimeSessionCache();
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

runtimeTest("streamRunSingleNode requires valid upstream cache", async () => {
  await clearRuntimeSessionCache();
  const graph: Graph = {
    nodes: [
      {
        id: "a",
        code: "x = input_value + 1",
        outputs: ["x"],
      },
      {
        id: "single",
        code: "y = x + 1",
        outputs: ["y"],
      },
    ],
    edges: [{ fromNode: "a", toNode: "single" }],
  };

  const events = await collectEvents(
    streamRunSingleNode("run-3-missing", graph, "single", { input_value: 40 }),
  );

  assertEquals(events.map((event) => event.type), [
    "run_started",
    "run_plan",
    "run_failed",
  ]);
  const finalEvent = events.at(-1);
  assertExists(finalEvent);

  if (finalEvent.type !== "run_failed") {
    throw new Error("Expected run_failed");
  }

  assertObjectMatch(finalEvent.response, {
    ok: false,
    error: {
      kind: "cache_miss",
      nodeId: "single",
    },
  });
  assertStringIncludes(finalEvent.response.error?.message ?? "", "missing");
});

runtimeTest(
  "streamRunSingleNode executes only target with valid upstream cache",
  async () => {
    await clearRuntimeSessionCache();
    const graph: Graph = {
      nodes: [
        {
          id: "a",
          code: "x = input_value + 1",
          outputs: ["x"],
        },
        {
          id: "single",
          code: "y = x + 1",
          outputs: ["y"],
        },
      ],
      edges: [{ fromNode: "a", toNode: "single" }],
    };

    await collectEvents(
      streamRunToNode("run-3-seed", graph, "single", { input_value: 40 }),
    );

    const events = await collectEvents(
      streamRunSingleNode("run-3", graph, "single", { input_value: 40 }),
    );

    assertEquals(events.map((event) => event.type), [
      "run_started",
      "run_plan",
      "node_started",
      "node_completed",
      "run_completed",
    ]);
    assertObjectMatch(events[1], {
      type: "run_plan",
      plan: {
        targetNodeIds: ["single"],
        steps: [{ nodeId: "single", dependsOn: ["a"] }],
      },
    });
    const finalEvent = events.at(-1);
    assertExists(finalEvent);
    assertObjectMatch(finalEvent, {
      type: "run_completed",
      response: {
        ok: true,
        runType: "run_node",
        executedNodeIds: ["single"],
        finalOutputsByNode: {
          single: { y: { name: "y", type: "builtins.int", repr: "42" } },
        },
      },
    });
  },
);

runtimeTest(
  "streamRunSingleNode rejects transitively stale upstream cache",
  async () => {
    await clearRuntimeSessionCache();
    const originalGraph: Graph = {
      nodes: [
        { id: "a", code: "x = 1", outputs: ["x"] },
        { id: "b", code: "y = x + 1", outputs: ["y"] },
        { id: "c", code: "z = y + 1", outputs: ["z"] },
      ],
      edges: [
        { fromNode: "a", toNode: "b" },
        { fromNode: "b", toNode: "c" },
      ],
    };

    await collectEvents(streamRunToNode("run-stale-seed", originalGraph, "c"));

    const editedGraph: Graph = {
      ...originalGraph,
      nodes: [
        { id: "a", code: "x = 10", outputs: ["x"] },
        { id: "b", code: "y = x + 1", outputs: ["y"] },
        { id: "c", code: "z = y + 1", outputs: ["z"] },
      ],
    };

    const events = await collectEvents(
      streamRunSingleNode("run-stale", editedGraph, "c"),
    );
    const finalEvent = events.at(-1);
    assertExists(finalEvent);

    if (finalEvent.type !== "run_failed") {
      throw new Error("Expected run_failed");
    }

    assertObjectMatch(finalEvent.response, {
      ok: false,
      error: {
        kind: "cache_miss",
        nodeId: "c",
      },
    });
    assertStringIncludes(finalEvent.response.error?.message ?? "", "stale");
    assertStringIncludes(finalEvent.response.error?.message ?? "", "node a");
  },
);

runtimeTest(
  "streamRunSingleNode refreshes target cache for downstream iteration",
  async () => {
    await clearRuntimeSessionCache();
    const initialGraph: Graph = {
      nodes: [
        { id: "a", code: "x = 1", outputs: ["x"] },
        { id: "b", code: "y = x + 1", outputs: ["y"] },
        { id: "c", code: "z = y + 1", outputs: ["z"] },
      ],
      edges: [
        { fromNode: "a", toNode: "b" },
        { fromNode: "b", toNode: "c" },
      ],
    };

    await collectEvents(streamRunToNode("run-refresh-seed", initialGraph, "b"));

    const editedGraph: Graph = {
      ...initialGraph,
      nodes: [
        { id: "a", code: "x = 1", outputs: ["x"] },
        { id: "b", code: "y = x + 10", outputs: ["y"] },
        { id: "c", code: "z = y + 1", outputs: ["z"] },
      ],
    };

    await collectEvents(streamRunSingleNode("run-refresh-b", editedGraph, "b"));
    const events = await collectEvents(
      streamRunSingleNode("run-refresh-c", editedGraph, "c"),
    );
    const finalEvent = events.at(-1);
    assertExists(finalEvent);

    assertObjectMatch(finalEvent, {
      type: "run_completed",
      response: {
        ok: true,
        executedNodeIds: ["c"],
        finalOutputsByNode: {
          c: { z: { name: "z", type: "builtins.int", repr: "12" } },
        },
      },
    });
  },
);

runtimeTest(
  "streamRunGraph copies upstream outputs for sibling nodes",
  async () => {
    await clearRuntimeSessionCache();
    const graph: Graph = {
      nodes: [
        {
          id: "a",
          code: "items = [1]",
          outputs: ["items"],
        },
        {
          id: "b",
          code: "items.append(2)\nb_len = len(items)",
          outputs: ["b_len"],
        },
        {
          id: "c",
          code: "c_len = len(items)",
          outputs: ["c_len"],
        },
      ],
      edges: [
        { fromNode: "a", toNode: "b" },
        { fromNode: "a", toNode: "c" },
      ],
    };

    const events = await collectEvents(streamRunGraph("run-4", graph));
    const finalEvent = events.at(-1);
    assertExists(finalEvent);
    assertObjectMatch(finalEvent, {
      type: "run_completed",
      response: {
        ok: true,
        finalOutputsByNode: {
          b: { b_len: { name: "b_len", type: "builtins.int", repr: "2" } },
          c: { c_len: { name: "c_len", type: "builtins.int", repr: "1" } },
        },
      },
    });
  },
);

runtimeTest(
  "streamRunGraph captures repr output without corrupting events",
  async () => {
    await clearRuntimeSessionCache();
    const graph: Graph = {
      nodes: [
        {
          id: "a",
          code:
            'import sys\nclass Loud:\n    def __repr__(self):\n        print("NOISE")\n        print("ERRNOISE", file=sys.stderr)\n        return "Loud()"\nx = Loud()',
          outputs: ["x"],
        },
      ],
      edges: [],
    };

    const events = await collectEvents(streamRunGraph("run-5", graph));
    const finalEvent = events.at(-1);
    assertExists(finalEvent);
    assertObjectMatch(finalEvent, {
      type: "run_completed",
      response: {
        ok: true,
        finalOutputsByNode: {
          a: {
            x: { name: "x", type: "builtins.Loud", repr: "Loud()" },
          },
        },
      },
    });

    if (finalEvent.type !== "run_completed") {
      throw new Error("Expected run_completed");
    }

    const warning = finalEvent.response.finalOutputsByNode.a.x.warning;
    assertExists(warning);
    assertStringIncludes(warning, "NOISE");
    assertStringIncludes(warning, "ERRNOISE");
  },
);
