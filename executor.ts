import type {
  ExecutionResponse,
  ExecutionRunType,
  ExecutionStreamEvent,
  Graph,
  Node,
  NodeRunResult,
  RunPlan,
  RunPlanStep,
} from "./types.ts";
import {
  getPythonEnvironmentInfo,
  type PythonEnvironmentInfo,
  resolvePythonCommand,
} from "./runtime_config.ts";

import {
  buildDownstreamAdjacency,
  buildUpstreamAdjacency,
  collectRequiredNodeIds,
  getNodeById,
  getSinkNodes,
} from "./graph.ts";

type RunnerNodeEvent = {
  type: "node_started" | "node_completed" | "node_failed";
  index: number;
  nodeId: string;
  dependsOn: string[];
  result?: NodeRunResult;
};

type RunnerFinalEvent = {
  type: "run_completed" | "run_failed";
  response: ExecutionResponse;
};

type RunnerCacheClearedEvent = {
  type: "session_cache_cleared";
  ok: boolean;
};

type RunnerEvent = RunnerNodeEvent | RunnerFinalEvent;
type SessionEvent = RunnerEvent | RunnerCacheClearedEvent;

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiting:
    | {
      resolve: (value: IteratorResult<T>) => void;
      reject: (error: unknown) => void;
    }
    | null = null;
  private closed = false;
  private error: unknown = null;

  push(value: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    this.error = error;
    this.closed = true;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift()!, done: false });
        }
        if (this.error) {
          return Promise.reject(this.error);
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
    };
  }
}

class PythonRuntimeSession {
  private child: Deno.ChildProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private activeQueue: AsyncEventQueue<SessionEvent> | null = null;
  private stdoutDone: Promise<void> | null = null;
  private stderrDone: Promise<void> | null = null;
  private stderrText = "";
  private operationChain: Promise<void> = Promise.resolve();
  private readonly encoder = new TextEncoder();

  async *run(payload: Record<string, unknown>): AsyncGenerator<RunnerEvent> {
    const release = await this.acquire();

    try {
      const queue = await this.startOperation(payload);
      for await (const event of queue) {
        if (event.type === "session_cache_cleared") {
          continue;
        }
        yield event;
      }
    } finally {
      release();
    }
  }

  async clearCache(): Promise<void> {
    const release = await this.acquire();

    try {
      const queue = await this.startOperation({ command: "clear_cache" });
      for await (const event of queue) {
        if (event.type === "session_cache_cleared") return;
      }
      throw new Error("runner.py session ended before clearing cache");
    } finally {
      release();
    }
  }

  async shutdown(): Promise<void> {
    const release = await this.acquire();
    try {
      if (this.activeQueue) {
        this.activeQueue.fail(new Error("runner.py session was shut down"));
        this.activeQueue = null;
      }

      const child = this.child;
      const writer = this.writer;
      this.child = null;
      this.writer = null;

      if (writer) {
        await writer.close().catch(() => {});
      }
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Process may already have exited after stdin closed.
        }
        await child.status.catch(() => {});
      }

      await Promise.allSettled([
        this.stdoutDone ?? Promise.resolve(),
        this.stderrDone ?? Promise.resolve(),
      ]);
      this.stdoutDone = null;
      this.stderrDone = null;
      this.stderrText = "";
    } finally {
      release();
    }
  }

  private async acquire(): Promise<() => void> {
    const previous = this.operationChain;
    let release!: () => void;
    this.operationChain = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await previous;
    return release;
  }

  private async startOperation(
    payload: Record<string, unknown>,
  ): Promise<AsyncEventQueue<SessionEvent>> {
    await this.ensureStarted();
    if (!this.writer) {
      throw new Error("runner.py session stdin is unavailable");
    }
    if (this.activeQueue) {
      throw new Error("runner.py session already has an active operation");
    }

    const queue = new AsyncEventQueue<SessionEvent>();
    this.activeQueue = queue;
    await this.writer.write(
      this.encoder.encode(`${JSON.stringify(payload)}\n`),
    );
    return queue;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.writer) return;

    const command = new Deno.Command(await resolvePythonCommand(), {
      args: ["runner.py", "--session"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });

    this.child = command.spawn();
    this.writer = this.child.stdin.getWriter();
    this.stderrText = "";
    this.stdoutDone = this.readStdout(this.child.stdout);
    this.stderrDone = this.readStderr(this.child.stderr);
  }

  private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          this.handleLine(line);
        }

        if (done) break;
      }

      if (buffer.trim().length > 0) {
        this.handleLine(buffer);
      }

      this.failActiveOperation(
        new Error(
          `runner.py session ended unexpectedly. stderr: ${this.stderrText}`,
        ),
      );
      this.child = null;
      this.writer = null;
    } catch (error) {
      this.failActiveOperation(error);
      this.child = null;
      this.writer = null;
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      this.stderrText += decoder.decode(value, { stream: !done });
      if (this.stderrText.length > 8_000) {
        this.stderrText = this.stderrText.slice(-8_000);
      }
      if (done) break;
    }
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    if (!this.activeQueue) {
      throw new Error(`runner.py emitted an event without an active operation`);
    }

    const event = JSON.parse(line) as SessionEvent;
    this.activeQueue.push(event);

    if (
      event.type === "run_completed" || event.type === "run_failed" ||
      event.type === "session_cache_cleared"
    ) {
      this.activeQueue.close();
      this.activeQueue = null;
    }
  }

  private failActiveOperation(error: unknown): void {
    if (!this.activeQueue) return;
    this.activeQueue.fail(error);
    this.activeQueue = null;
  }
}

export { getPythonEnvironmentInfo, resolvePythonCommand };
export type { PythonEnvironmentInfo };

const runtimeSession = new PythonRuntimeSession();

export function buildRunPlan(graph: Graph, targetNodeId: string): RunPlan {
  return buildRunPlanForTargets(graph, [targetNodeId]);
}

export function buildRunPlanForTargets(
  graph: Graph,
  targetNodeIds: string[],
): RunPlan {
  const required = new Set<string>();

  for (const nodeId of targetNodeIds) {
    const nodeRequirements = collectRequiredNodeIds(graph, nodeId);
    for (const requiredNodeId of nodeRequirements) {
      required.add(requiredNodeId);
    }
  }

  const upstream = buildUpstreamAdjacency(graph);
  const downstream = buildDownstreamAdjacency(graph);

  const dependsOn = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of required) {
    const parents = (upstream.get(node) ?? []).filter((parent) =>
      required.has(parent)
    );
    dependsOn.set(node, parents);
    inDegree.set(node, parents.length);
  }

  const queue: string[] = [];

  for (const node of required) {
    if (inDegree.get(node) === 0) {
      queue.push(node);
    }
  }

  const steps: RunPlanStep[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;

    steps.push({
      nodeId,
      dependsOn: dependsOn.get(nodeId) ?? [],
    });

    for (const childId of downstream.get(nodeId) ?? []) {
      if (!required.has(childId)) continue;

      const nextInDegree = inDegree.get(childId)! - 1;
      inDegree.set(childId, nextInDegree);

      if (nextInDegree === 0) {
        queue.push(childId);
      }
    }
  }

  if (steps.length !== required.size) {
    throw new Error("Could not build run plan");
  }

  return { targetNodeIds, steps };
}

export async function runPythonNode(
  node: Node,
  inputs: Record<string, unknown>,
): Promise<NodeRunResult> {
  const graph: Graph = { nodes: [node], edges: [] };
  const response = await executeRunPlan(
    graph,
    { targetNodeIds: [node.id], steps: [{ nodeId: node.id, dependsOn: [] }] },
    inputs,
    false,
    "run_node",
    node.id,
    "refresh",
  );

  return response.resultsByNode[node.id];
}

export async function runToNode(
  graph: Graph,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  trace: boolean = false,
): Promise<ExecutionResponse> {
  const runPlan = buildRunPlan(graph, nodeId);
  return await executeRunPlan(
    graph,
    runPlan,
    inputs,
    trace,
    "run_to_node",
    nodeId,
    "refresh",
  );
}

export async function* streamRunToNode(
  runId: string,
  graph: Graph,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  trace: boolean = false,
): AsyncGenerator<ExecutionStreamEvent> {
  const runPlan = buildRunPlan(graph, nodeId);
  yield* streamRunPlanExecution(
    runId,
    graph,
    runPlan,
    inputs,
    trace,
    "run_to_node",
    nodeId,
    "refresh",
  );
}

export async function runGraph(
  graph: Graph,
  userInputs: Record<string, unknown> = {},
  trace: boolean = false,
): Promise<ExecutionResponse> {
  const sinks = getSinkNodes(graph);
  const runPlan = buildRunPlanForTargets(graph, [...sinks]);

  return await executeRunPlan(
    graph,
    runPlan,
    userInputs,
    trace,
    "run_graph",
    undefined,
    "refresh",
  );
}

export async function* streamRunGraph(
  runId: string,
  graph: Graph,
  userInputs: Record<string, unknown> = {},
  trace: boolean = false,
): AsyncGenerator<ExecutionStreamEvent> {
  const sinks = getSinkNodes(graph);
  const runPlan = buildRunPlanForTargets(graph, [...sinks]);

  yield* streamRunPlanExecution(
    runId,
    graph,
    runPlan,
    userInputs,
    trace,
    "run_graph",
    undefined,
    "refresh",
  );
}

export async function runSingleNode(
  graph: Graph,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  traceEnabled = false,
): Promise<ExecutionResponse> {
  const runPlan = buildRunPlan(graph, nodeId);

  return await executeRunPlan(
    graph,
    runPlan,
    inputs,
    traceEnabled,
    "run_node",
    nodeId,
    "single_node",
  );
}

export async function* streamRunSingleNode(
  runId: string,
  graph: Graph,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  traceEnabled = false,
): AsyncGenerator<ExecutionStreamEvent> {
  const runPlan = buildRunPlan(graph, nodeId);

  yield* streamRunPlanExecution(
    runId,
    graph,
    runPlan,
    inputs,
    traceEnabled,
    "run_node",
    nodeId,
    "single_node",
  );
}

export async function clearRuntimeSessionCache(): Promise<void> {
  await runtimeSession.clearCache();
}

export async function shutdownRuntimeSession(): Promise<void> {
  await runtimeSession.shutdown();
}

export function printNodeRunResult(result: NodeRunResult): void {
  console.log(result.ok ? "OK" : "FAILED");
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.log(result.stderr);
  if (result.warnings.length > 0) {
    console.log("warnings:");
    console.log(result.warnings);
  }
  console.log("outputs:");
  console.log(result.outputs);
  if (result.displays.length > 0) {
    console.log("displays:");
    console.log(result.displays);
  }

  if (!result.ok && result.error) {
    console.log(`error: ${result.error}`);
  }
}

async function executeRunPlan(
  graph: Graph,
  runPlan: RunPlan,
  userInputs: Record<string, unknown> = {},
  traceEnabled: boolean = false,
  runType: ExecutionRunType,
  targetNodeId: string | undefined = undefined,
  cacheMode: "refresh" | "single_node" = "refresh",
): Promise<ExecutionResponse> {
  let finalResponse: ExecutionResponse | null = null;

  for await (
    const event of streamPythonRunPlan(
      graph,
      runPlan,
      userInputs,
      traceEnabled,
      runType,
      targetNodeId,
      cacheMode,
    )
  ) {
    if (event.type === "run_completed" || event.type === "run_failed") {
      finalResponse = event.response;
    }
  }

  if (!finalResponse) {
    throw new Error("runner.py ended before sending a final run event");
  }

  return finalResponse;
}

async function* streamRunPlanExecution(
  runId: string,
  graph: Graph,
  runPlan: RunPlan,
  userInputs: Record<string, unknown>,
  traceEnabled: boolean,
  runType: ExecutionRunType,
  targetNodeId: string | undefined = undefined,
  cacheMode: "refresh" | "single_node" = "refresh",
): AsyncGenerator<ExecutionStreamEvent> {
  yield {
    type: "run_started",
    runId,
    runType,
    targetNodeId,
  };
  yield {
    type: "run_plan",
    runId,
    runType,
    targetNodeId,
    plan: cacheMode === "single_node" && targetNodeId
      ? displayRunSingleNodePlan(runPlan, targetNodeId)
      : runPlan,
  };

  for await (
    const event of streamPythonRunPlan(
      graph,
      runPlan,
      userInputs,
      traceEnabled,
      runType,
      targetNodeId,
      cacheMode,
    )
  ) {
    if (event.type === "node_started") {
      yield {
        type: "node_started",
        runId,
        runType,
        targetNodeId,
        index: event.index,
        nodeId: event.nodeId,
        dependsOn: event.dependsOn,
      };
      continue;
    }

    if (event.type === "node_completed" || event.type === "node_failed") {
      yield {
        type: event.type,
        runId,
        runType,
        targetNodeId,
        index: event.index,
        nodeId: event.nodeId,
        dependsOn: event.dependsOn,
        result: event.result!,
      };
      continue;
    }

    const finalEvent = event as RunnerFinalEvent;
    yield {
      type: finalEvent.type,
      runId,
      runType,
      targetNodeId,
      response: finalEvent.response,
    };
  }
}

function displayRunSingleNodePlan(
  runPlan: RunPlan,
  targetNodeId: string,
): RunPlan {
  const targetStep = runPlan.steps.find((step) => step.nodeId === targetNodeId);
  return {
    targetNodeIds: [targetNodeId],
    steps: targetStep ? [targetStep] : [],
  };
}

async function* streamPythonRunPlan(
  graph: Graph,
  runPlan: RunPlan,
  userInputs: Record<string, unknown>,
  traceEnabled: boolean,
  runType: ExecutionRunType,
  targetNodeId: string | undefined,
  cacheMode: "refresh" | "single_node",
): AsyncGenerator<RunnerEvent> {
  yield* runtimeSession.run({
    command: "run",
    nodes: graph.nodes,
    plan: runPlan,
    inputs: userInputs,
    trace: traceEnabled,
    runType,
    targetNodeId,
    cacheMode,
  });
}

async function* streamOneShotPythonRunPlan(
  graph: Graph,
  runPlan: RunPlan,
  userInputs: Record<string, unknown>,
  traceEnabled: boolean,
  runType: ExecutionRunType,
  targetNodeId: string | undefined,
  cacheMode: "refresh" | "single_node",
): AsyncGenerator<RunnerEvent> {
  const command = new Deno.Command(await resolvePythonCommand(), {
    args: ["runner.py"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });

  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({
        nodes: graph.nodes,
        plan: runPlan,
        inputs: userInputs,
        trace: traceEnabled,
        runType,
        targetNodeId,
        cacheMode,
      }),
    ),
  );
  await writer.close();

  const stderrPromise = collectText(child.stderr);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawFinalEvent = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim().length === 0) continue;

        const event = JSON.parse(line) as RunnerEvent;
        if (event.type === "run_completed" || event.type === "run_failed") {
          sawFinalEvent = true;
        }
        yield event;
      }

      if (done) break;
    }

    if (buffer.trim().length > 0) {
      const event = JSON.parse(buffer) as RunnerEvent;
      if (event.type === "run_completed" || event.type === "run_failed") {
        sawFinalEvent = true;
      }
      yield event;
    }
  } catch (error) {
    const stderrText = await stderrPromise;
    throw new Error(
      `runner.py produced invalid event output. stderr: ${stderrText}. error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const status = await child.status;
  const stderrText = await stderrPromise;
  if (!sawFinalEvent) {
    throw new Error(
      `runner.py ended before a final run event (exit code ${status.code}). stderr: ${stderrText}`,
    );
  }
}

async function collectText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const response = new Response(stream);
  return await response.text();
}
