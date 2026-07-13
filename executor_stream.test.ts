import {
  assertEquals,
  assertExists,
  assertObjectMatch,
  assertStringIncludes,
} from "@std/assert";
import {
  clearSourceRuntimeSessionCache,
  getPythonEnvironmentInfo,
  resolvePythonCommand,
  runSourceGraph,
  runSourceToNode,
  shutdownSourceRuntimeSession,
  streamSourceRunGraph,
  streamSourceRunSingleNode,
  streamSourceRunToNode,
} from "./executor.ts";
import type { ExecutionStreamEvent } from "./types.ts";

async function collectEvents(
  events: AsyncIterable<ExecutionStreamEvent>,
): Promise<ExecutionStreamEvent[]> {
  const collected: ExecutionStreamEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function sourceRuntimeTest(
  name: string,
  fn: () => Promise<void>,
): void {
  Deno.test(name, async () => {
    await clearSourceRuntimeSessionCache();
    try {
      await fn();
    } finally {
      await shutdownSourceRuntimeSession();
    }
  });
}

function helloSource(): string {
  return [
    "from nodebook import node",
    "",
    '@node(id="a", outputs=["x"])',
    "def a():",
    "    x = 1",
    '    return {"x": x}',
    "",
    '@node(id="b", outputs=["y"])',
    "def b(x):",
    "    y = x + 1",
    '    return {"y": y}',
    "",
    "b.depends_on(a)",
    "",
  ].join("\n");
}

function targetSource(value: number): string {
  return [
    "from nodebook import node",
    "",
    '@node(id="root", outputs=["input_value"])',
    "def root():",
    `    return {"input_value": ${value}}`,
    "",
    '@node(id="single", outputs=["result"])',
    "def single(input_value):",
    '    return {"result": input_value + 2}',
    "",
    "single.depends_on(root)",
    "",
  ].join("\n");
}

Deno.test("getPythonEnvironmentInfo reports the resolved Python runtime", async () => {
  const command = await resolvePythonCommand();
  const python = await getPythonEnvironmentInfo();

  assertEquals(python.command, command);
  assertStringIncludes(python.command.toLowerCase(), "python");
  assertStringIncludes(python.executable.toLowerCase(), "python");
  assertStringIncludes(python.implementation, "Python");
  assertExists(python.version.match(/^\d+\.\d+\.\d+/));
});

sourceRuntimeTest(
  "runSourceGraph executes source through the Python worker",
  async () => {
    const documentPath = `${await Deno.makeTempDir()}/worker_source.py`;
    const source = helloSource();
    await Deno.writeTextFile(documentPath, source);

    const response = await runSourceGraph(source, documentPath, {}, true);

    assertEquals(response.ok, true);
    assertEquals(response.executedNodeIds, ["a", "b"]);
    assertEquals(response.finalOutputsByNode.b.y.jsonValue, 2);
    assertExists(response.trace);
    assertEquals(response.trace.map((step) => step.nodeId), ["a", "b"]);
  },
);

sourceRuntimeTest(
  "source-backed runs reject explicit inputs",
  async () => {
    const graphResponse = await runSourceGraph(
      "from nodebook import node\n",
      "/tmp/source_inputs.py",
      { value: 1 },
      true,
    );
    const nodeResponse = await runSourceToNode(
      "from nodebook import node\n",
      "/tmp/source_inputs.py",
      "target",
      { value: 1 },
    );

    assertEquals(graphResponse.ok, false);
    assertEquals(graphResponse.runType, "run_graph");
    assertEquals(graphResponse.trace, []);
    assertExists(graphResponse.error);
    assertObjectMatch(graphResponse.error, {
      kind: "invalid_request",
      message:
        "Source-backed runs do not accept explicit inputs. Put root data in the Python document.",
    });
    assertEquals(nodeResponse.ok, false);
    assertEquals(nodeResponse.runType, "run_to_node");
    assertEquals(nodeResponse.targetNodeId, "target");
    assertExists(nodeResponse.error);
    assertObjectMatch(nodeResponse.error, { kind: "invalid_request" });
  },
);

sourceRuntimeTest(
  "streamSourceRunGraph emits progress events and final response",
  async () => {
    const documentPath = `${await Deno.makeTempDir()}/stream_source.py`;
    const events = await collectEvents(
      streamSourceRunGraph(
        "source-run-1",
        helloSource(),
        documentPath,
        {},
        true,
      ),
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
    const finalEvent = events.at(-1);
    assertExists(finalEvent);
    assertEquals(finalEvent.type, "run_completed");
    if (finalEvent.type === "run_completed") {
      assertEquals(finalEvent.response.ok, true);
      assertEquals(finalEvent.response.finalOutputsByNode.b.y.jsonValue, 2);
    }
  },
);

sourceRuntimeTest(
  "streamSourceRunGraph uses provided source instead of reading disk",
  async () => {
    const directory = await Deno.makeTempDir();
    const documentPath = `${directory}/dirty_source.py`;
    await Deno.writeTextFile(
      documentPath,
      [
        "from nodebook import node",
        "",
        '@node(id="only", outputs=["value"])',
        "def only():",
        '    return {"value": "disk"}',
        "",
      ].join("\n"),
    );
    const dirtySource = [
      "from nodebook import node",
      "",
      '@node(id="only", outputs=["value"])',
      "def only():",
      '    return {"value": "dirty"}',
      "",
    ].join("\n");

    const events = await collectEvents(
      streamSourceRunGraph("source-run-dirty", dirtySource, documentPath),
    );

    const finalEvent = events.at(-1);
    assertExists(finalEvent);
    assertEquals(finalEvent.type, "run_completed");
    if (finalEvent.type === "run_completed") {
      assertEquals(
        finalEvent.response.finalOutputsByNode.only.value.jsonValue,
        "dirty",
      );
    }
  },
);

sourceRuntimeTest(
  "streamSourceRunToNode stops after the first failed node",
  async () => {
    const source = [
      "from nodebook import node",
      "",
      '@node(id="a", outputs=["x"])',
      "def a():",
      "    raise ValueError('boom')",
      "",
      '@node(id="b", outputs=["y"])',
      "def b(x):",
      '    return {"y": x + 1}',
      "",
      "b.depends_on(a)",
      "",
    ].join("\n");

    const events = await collectEvents(
      streamSourceRunToNode(
        "source-run-failure",
        source,
        "/tmp/failure.py",
        "b",
      ),
    );

    assertEquals(events.map((event) => event.type), [
      "run_started",
      "run_plan",
      "node_started",
      "node_failed",
      "run_failed",
    ]);
    const finalEvent = events.at(-1);
    assertExists(finalEvent);
    assertEquals(finalEvent.type, "run_failed");
    if (finalEvent.type === "run_failed") {
      assertEquals(finalEvent.response.ok, false);
      assertExists(finalEvent.response.error);
      assertObjectMatch(finalEvent.response.error, { nodeId: "a" });
    }
  },
);

sourceRuntimeTest(
  "runSourceSingleNode executes fresh through upstream dependencies",
  async () => {
    const documentPath = `${await Deno.makeTempDir()}/target_source.py`;
    const source = targetSource(40);

    const events = await collectEvents(
      streamSourceRunSingleNode(
        "source-run-fresh-target",
        source,
        documentPath,
        "single",
      ),
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
    const finalEvent = events.at(-1);
    assertExists(finalEvent);
    assertEquals(finalEvent.type, "run_completed");
    if (finalEvent.type === "run_completed") {
      assertEquals(finalEvent.response.executedNodeIds, ["root", "single"]);
      assertEquals(
        finalEvent.response.finalOutputsByNode.single.result.jsonValue,
        42,
      );
    }
  },
);
