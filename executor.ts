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
} from "./graph.ts";
import {
  PythonWorkerClient,
  type PythonWorkerEvent,
} from "./python_worker_client.ts";
import { hasExplicitRunInputs } from "./run_inputs.ts";

type WorkerNodeEvent = {
  type: "node_started" | "node_completed" | "node_failed";
  index: number;
  nodeId: string;
  dependsOn: string[];
  result?: NodeRunResult;
};

type WorkerFinalEvent = {
  type: "run_completed" | "run_failed";
  response: ExecutionResponse;
};

type WorkerRunEvent = WorkerNodeEvent | WorkerFinalEvent;

export { getPythonEnvironmentInfo, resolvePythonCommand };
export type { PythonEnvironmentInfo };

const sourceRuntimeWorker = new PythonWorkerClient();

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
  const response = await executeGraphRun(graph, "run_node", node.id, inputs);

  return response.resultsByNode[node.id];
}

export async function runToNode(
  graph: Graph,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  trace: boolean = false,
): Promise<ExecutionResponse> {
  return await executeGraphRun(graph, "run_to_node", nodeId, inputs, trace);
}

export async function runSourceToNode(
  source: string,
  documentPath: string,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  trace: boolean = false,
): Promise<ExecutionResponse> {
  if (hasExplicitRunInputs(inputs)) {
    return sourceBackedInputsNotSupportedResponse("run_to_node", nodeId, trace);
  }
  return await executeSourceRun(
    source,
    documentPath,
    "run_to_node",
    nodeId,
    trace,
  );
}

export async function runSourceSingleNode(
  source: string,
  documentPath: string,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  trace: boolean = false,
): Promise<ExecutionResponse> {
  if (hasExplicitRunInputs(inputs)) {
    return sourceBackedInputsNotSupportedResponse("run_node", nodeId, trace);
  }
  return await executeSourceRun(
    source,
    documentPath,
    "run_node",
    nodeId,
    trace,
  );
}

export async function* streamRunToNode(
  runId: string,
  graph: Graph,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  trace: boolean = false,
): AsyncGenerator<ExecutionStreamEvent> {
  yield* streamGraphRun(
    runId,
    graph,
    "run_to_node",
    nodeId,
    inputs,
    trace,
  );
}

export async function* streamSourceRunToNode(
  runId: string,
  source: string,
  documentPath: string,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  trace: boolean = false,
): AsyncGenerator<ExecutionStreamEvent> {
  if (hasExplicitRunInputs(inputs)) {
    yield* streamSourceBackedInputsNotSupported(
      runId,
      "run_to_node",
      nodeId,
      trace,
    );
    return;
  }
  yield* streamSourceRun(
    runId,
    source,
    documentPath,
    "run_to_node",
    nodeId,
    trace,
  );
}

export async function* streamSourceRunSingleNode(
  runId: string,
  source: string,
  documentPath: string,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  trace: boolean = false,
): AsyncGenerator<ExecutionStreamEvent> {
  if (hasExplicitRunInputs(inputs)) {
    yield* streamSourceBackedInputsNotSupported(
      runId,
      "run_node",
      nodeId,
      trace,
    );
    return;
  }
  yield* streamSourceRun(
    runId,
    source,
    documentPath,
    "run_node",
    nodeId,
    trace,
  );
}

export async function runGraph(
  graph: Graph,
  userInputs: Record<string, unknown> = {},
  trace: boolean = false,
): Promise<ExecutionResponse> {
  return await executeGraphRun(
    graph,
    "run_graph",
    undefined,
    userInputs,
    trace,
  );
}

export async function runSourceGraph(
  source: string,
  documentPath: string,
  userInputs: Record<string, unknown> = {},
  trace: boolean = false,
): Promise<ExecutionResponse> {
  if (hasExplicitRunInputs(userInputs)) {
    return sourceBackedInputsNotSupportedResponse(
      "run_graph",
      undefined,
      trace,
    );
  }
  return await executeSourceRun(
    source,
    documentPath,
    "run_graph",
    undefined,
    trace,
  );
}

export async function* streamRunGraph(
  runId: string,
  graph: Graph,
  userInputs: Record<string, unknown> = {},
  trace: boolean = false,
): AsyncGenerator<ExecutionStreamEvent> {
  yield* streamGraphRun(
    runId,
    graph,
    "run_graph",
    undefined,
    userInputs,
    trace,
  );
}

export async function* streamSourceRunGraph(
  runId: string,
  source: string,
  documentPath: string,
  userInputs: Record<string, unknown> = {},
  trace: boolean = false,
): AsyncGenerator<ExecutionStreamEvent> {
  if (hasExplicitRunInputs(userInputs)) {
    yield* streamSourceBackedInputsNotSupported(
      runId,
      "run_graph",
      undefined,
      trace,
    );
    return;
  }
  yield* streamSourceRun(
    runId,
    source,
    documentPath,
    "run_graph",
    undefined,
    trace,
  );
}

export async function runSingleNode(
  graph: Graph,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  traceEnabled = false,
): Promise<ExecutionResponse> {
  return await executeGraphRun(
    graph,
    "run_node",
    nodeId,
    inputs,
    traceEnabled,
  );
}

export async function* streamRunSingleNode(
  runId: string,
  graph: Graph,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  traceEnabled = false,
): AsyncGenerator<ExecutionStreamEvent> {
  yield* streamGraphRun(
    runId,
    graph,
    "run_node",
    nodeId,
    inputs,
    traceEnabled,
  );
}

export async function clearRuntimeSessionCache(): Promise<void> {
  await clearSourceRuntimeSessionCache();
}

export async function clearSourceRuntimeSessionCache(): Promise<void> {
  const event = await sourceRuntimeWorker.requestFinalEvent(
    "clear_session_cache",
  );
  if (event.type !== "session_cache_cleared" || event.ok === false) {
    throw new Error(
      workerErrorMessage(event, "Failed to clear Python worker cache"),
    );
  }
}

export async function shutdownRuntimeSession(): Promise<void> {
  await shutdownSourceRuntimeSession();
}

export async function shutdownSourceRuntimeSession(): Promise<void> {
  await sourceRuntimeWorker.shutdown();
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

async function executeGraphRun(
  graph: Graph,
  runType: ExecutionRunType,
  targetNodeId: string | undefined = undefined,
  userInputs: Record<string, unknown> = {},
  traceEnabled: boolean = false,
): Promise<ExecutionResponse> {
  const source = renderGraphAsPythonSource(graph, userInputs);
  return await executeWorkerRun(
    source,
    graphDocumentPath(),
    runType,
    targetNodeId,
    traceEnabled,
    userInputs,
  );
}

async function executeWorkerRun(
  source: string,
  documentPath: string,
  runType: ExecutionRunType,
  targetNodeId: string | undefined,
  traceEnabled: boolean,
  inputs: Record<string, unknown> = {},
): Promise<ExecutionResponse> {
  let finalResponse: ExecutionResponse | null = null;

  for await (
    const event of streamWorkerRunEvents(
      source,
      documentPath,
      runType,
      targetNodeId,
      traceEnabled,
      inputs,
    )
  ) {
    if (event.type === "run_completed" || event.type === "run_failed") {
      finalResponse = readWorkerExecutionResponse(event);
    }
  }

  if (!finalResponse) {
    throw new Error("Python worker ended before sending a final run event");
  }

  return finalResponse;
}

async function* streamGraphRun(
  runId: string,
  graph: Graph,
  runType: ExecutionRunType,
  targetNodeId: string | undefined = undefined,
  userInputs: Record<string, unknown> = {},
  traceEnabled: boolean = false,
): AsyncGenerator<ExecutionStreamEvent> {
  yield* streamWorkerRun(
    runId,
    renderGraphAsPythonSource(graph, userInputs),
    graphDocumentPath(),
    runType,
    targetNodeId,
    traceEnabled,
    userInputs,
  );
}

async function executeSourceRun(
  source: string,
  documentPath: string,
  runType: ExecutionRunType,
  targetNodeId: string | undefined,
  traceEnabled: boolean,
): Promise<ExecutionResponse> {
  return await executeWorkerRun(
    source,
    documentPath,
    runType,
    targetNodeId,
    traceEnabled,
  );
}

function sourceBackedInputsNotSupportedResponse(
  runType: ExecutionRunType,
  targetNodeId: string | undefined,
  traceEnabled: boolean,
): ExecutionResponse {
  return {
    ok: false,
    runType,
    ...(targetNodeId ? { targetNodeId } : {}),
    finalNodeIds: [],
    executedNodeIds: [],
    resultsByNode: {},
    finalOutputsByNode: {},
    trace: traceEnabled ? [] : null,
    error: {
      kind: "invalid_request",
      message:
        "Source-backed runs do not accept explicit inputs. Put root data in the Python document.",
    },
  };
}

async function* streamSourceBackedInputsNotSupported(
  runId: string,
  runType: ExecutionRunType,
  targetNodeId: string | undefined,
  traceEnabled: boolean,
): AsyncGenerator<ExecutionStreamEvent> {
  yield {
    type: "run_started",
    runId,
    runType,
    ...(targetNodeId ? { targetNodeId } : {}),
  };
  yield {
    type: "run_failed",
    runId,
    runType,
    ...(targetNodeId ? { targetNodeId } : {}),
    response: sourceBackedInputsNotSupportedResponse(
      runType,
      targetNodeId,
      traceEnabled,
    ),
  };
}

async function* streamSourceRun(
  runId: string,
  source: string,
  documentPath: string,
  runType: ExecutionRunType,
  targetNodeId: string | undefined,
  traceEnabled: boolean,
): AsyncGenerator<ExecutionStreamEvent> {
  yield* streamWorkerRun(
    runId,
    source,
    documentPath,
    runType,
    targetNodeId,
    traceEnabled,
  );
}

async function* streamWorkerRun(
  runId: string,
  source: string,
  documentPath: string,
  runType: ExecutionRunType,
  targetNodeId: string | undefined,
  traceEnabled: boolean,
  inputs: Record<string, unknown> = {},
): AsyncGenerator<ExecutionStreamEvent> {
  for await (
    const event of streamWorkerRunEvents(
      source,
      documentPath,
      runType,
      targetNodeId,
      traceEnabled,
      inputs,
    )
  ) {
    if (event.type === "run_started") {
      yield {
        type: "run_started",
        runId,
        runType,
        targetNodeId,
      };
      continue;
    }

    if (event.type === "run_plan") {
      yield {
        type: "run_plan",
        runId,
        runType,
        targetNodeId,
        plan: readWorkerRunPlan(event),
      };
      continue;
    }

    if (event.type === "node_started") {
      yield {
        type: "node_started",
        runId,
        runType,
        targetNodeId,
        index: readWorkerEventNumber(event, "index"),
        nodeId: readWorkerEventString(event, "nodeId"),
        dependsOn: readWorkerStringArray(event, "dependsOn"),
      };
      continue;
    }

    if (event.type === "node_completed" || event.type === "node_failed") {
      yield {
        type: event.type,
        runId,
        runType,
        targetNodeId,
        index: readWorkerEventNumber(event, "index"),
        nodeId: readWorkerEventString(event, "nodeId"),
        dependsOn: readWorkerStringArray(event, "dependsOn"),
        result: readWorkerNodeResult(event),
      };
      continue;
    }

    if (event.type === "run_completed" || event.type === "run_failed") {
      yield {
        type: event.type,
        runId,
        runType,
        targetNodeId,
        response: readWorkerExecutionResponse(event),
      };
      continue;
    }

    if (event.type === "error") {
      yield {
        type: "run_failed",
        runId,
        runType,
        targetNodeId,
        response: workerEventToExecutionFailure(event, runType, targetNodeId),
      };
      continue;
    }
  }
}

async function* streamWorkerRunEvents(
  source: string,
  documentPath: string,
  runType: ExecutionRunType,
  targetNodeId: string | undefined,
  traceEnabled: boolean,
  inputs: Record<string, unknown> = {},
): AsyncGenerator<PythonWorkerEvent> {
  const payload: Record<string, unknown> = {
    source,
    documentPath,
    trace: traceEnabled,
    inputs,
  };
  if (targetNodeId) {
    payload.target = targetNodeId;
  }

  yield* sourceRuntimeWorker.request(runType, payload);
}

function readWorkerRunPlan(event: PythonWorkerEvent): RunPlan {
  const plan = event["plan"];
  if (
    isRecord(plan) && Array.isArray(plan["targetNodeIds"]) &&
    Array.isArray(plan["steps"])
  ) {
    return plan as RunPlan;
  }
  return { targetNodeIds: [], steps: [] };
}

function readWorkerExecutionResponse(
  event: PythonWorkerEvent,
): ExecutionResponse {
  const response = event["response"];
  if (!isRecord(response)) {
    throw new Error(
      workerErrorMessage(
        event,
        "Python worker did not return an execution response",
      ),
    );
  }
  return response as ExecutionResponse;
}

function readWorkerNodeResult(event: PythonWorkerEvent): NodeRunResult {
  const result = event["result"];
  if (!isRecord(result)) {
    throw new Error("Python worker node event did not include a node result");
  }
  return result as NodeRunResult;
}

function readWorkerEventNumber(
  event: PythonWorkerEvent,
  field: string,
): number {
  const value = event[field];
  return typeof value === "number" ? value : 0;
}

function readWorkerEventString(
  event: PythonWorkerEvent,
  field: string,
): string {
  const value = event[field];
  return typeof value === "string" ? value : "";
}

function readWorkerStringArray(
  event: PythonWorkerEvent,
  field: string,
): string[] {
  const value = event[field];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function workerEventToExecutionFailure(
  event: PythonWorkerEvent,
  runType: ExecutionRunType,
  targetNodeId: string | undefined,
): ExecutionResponse {
  return {
    ok: false,
    runType,
    targetNodeId,
    finalNodeIds: [],
    executedNodeIds: [],
    resultsByNode: {},
    finalOutputsByNode: {},
    trace: null,
    error: {
      kind: "internal_error",
      message: workerErrorMessage(event, "Python worker execution failed"),
    },
  };
}

function workerErrorMessage(
  event: PythonWorkerEvent,
  fallback: string,
): string {
  return event.error?.message ?? fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderGraphAsPythonSource(
  graph: Graph,
  rootInputs: Record<string, unknown> = {},
): string {
  const functionNames = uniqueFunctionNames(graph.nodes);
  const functionParameters = functionParametersByNode(graph);
  const rootInputsByNode = buildRootInputsByNode(graph, rootInputs);
  const blocks = [
    "from nodebook import node",
    "",
    ...graph.nodes.flatMap((node) =>
      renderGraphNodeAsPythonBlock(
        node,
        functionNames.get(node.id) ?? safePythonIdentifier(node.id),
        functionParameters.get(node.id) ?? [],
        rootInputsByNode.get(node.id) ?? [],
      )
    ),
  ];
  const edgeLines = graph.edges.flatMap((edge) => {
    const upstream = functionNames.get(edge.fromNode);
    const downstream = functionNames.get(edge.toNode);
    return upstream && downstream
      ? [`${downstream}.depends_on(${upstream})`]
      : [];
  });
  if (edgeLines.length > 0) {
    blocks.push("# NodeBook graph", ...edgeLines, "");
  }
  return blocks.join("\n");
}

function renderGraphNodeAsPythonBlock(
  node: Node,
  functionName: string,
  parameters: string[],
  rootInputs: string[],
): string[] {
  const renderedParameters = node.codeKind === "runtime" ? [] : parameters;
  const rootInputAssignments = node.codeKind === "runtime"
    ? []
    : renderRootInputAssignments(rootInputs);
  const returnLine = node.codeKind === "runtime"
    ? renderGlobalsReturnLine(node.outputs)
    : renderReturnLine(node.outputs);

  return [
    `@node(id=${JSON.stringify(node.id)}, outputs=${
      renderStringList(node.outputs)
    })`,
    `def ${functionName}(${renderParameterList(renderedParameters)}):`,
    ...rootInputAssignments,
    ...indentPythonBody(node.code),
    returnLine,
    "",
  ];
}

function functionParametersByNode(graph: Graph): Map<string, string[]> {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const parametersByNode = new Map(
    graph.nodes.map((node) => [node.id, [] as string[]]),
  );

  for (const edge of graph.edges) {
    const upstream = nodesById.get(edge.fromNode);
    if (!upstream || !nodesById.has(edge.toNode)) continue;
    parametersByNode.get(edge.toNode)?.push(...upstream.outputs);
  }

  for (const node of graph.nodes) {
    parametersByNode.set(
      node.id,
      uniqueValidPythonParameterNames(parametersByNode.get(node.id) ?? []),
    );
  }

  return parametersByNode;
}

function buildRootInputsByNode(
  graph: Graph,
  rootInputs: Record<string, unknown> = {},
): Map<string, string[]> {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const hasUpstreamByNode = new Map(
    graph.nodes.map((node) => [node.id, false]),
  );

  for (const edge of graph.edges) {
    if (!nodesById.has(edge.fromNode) || !nodesById.has(edge.toNode)) continue;
    hasUpstreamByNode.set(edge.toNode, true);
  }

  const rootInputNames = uniqueValidPythonParameterNames(
    Object.keys(rootInputs),
  );
  return new Map(
    graph.nodes.map((node) => [
      node.id,
      hasUpstreamByNode.get(node.id) ? [] : rootInputNames,
    ]),
  );
}

function uniqueFunctionNames(nodes: Node[]): Map<string, string> {
  const counts = new Map<string, number>();
  const result = new Map<string, string>();
  for (const node of nodes) {
    const baseName = safePythonIdentifier(node.id);
    const count = counts.get(baseName) ?? 0;
    counts.set(baseName, count + 1);
    result.set(node.id, count === 0 ? baseName : `${baseName}_${count + 1}`);
  }
  return result;
}

function uniqueValidPythonParameterNames(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!isValidPythonIdentifier(value) || PYTHON_KEYWORDS.has(value)) {
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function safePythonIdentifier(value: string): string {
  const normalized = value.replaceAll(/[^A-Za-z0-9_]/g, "_");
  const prefixed = /^[A-Za-z_]/.test(normalized)
    ? normalized
    : `node_${normalized}`;
  return PYTHON_KEYWORDS.has(prefixed) ? `node_${prefixed}` : prefixed;
}

function isValidPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function indentPythonBody(code: string): string[] {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  const body = lines.length === 1 && lines[0].trim().length === 0
    ? ["pass"]
    : lines;
  return body.map((line) => line.length === 0 ? "" : `    ${line}`);
}

function renderReturnLine(outputs: string[]): string {
  if (outputs.length === 0) {
    return "    return {}";
  }
  const entries = outputs.map((output) =>
    `${JSON.stringify(output)}: ${output}`
  );
  return `    return {${entries.join(", ")}}`;
}

function renderRootInputAssignments(inputs: string[]): string[] {
  return inputs.map((input) =>
    `    ${input} = globals()[${JSON.stringify(input)}]`
  );
}

function renderGlobalsReturnLine(outputs: string[]): string {
  if (outputs.length === 0) {
    return "    return {}";
  }
  const entries = outputs.map((output) =>
    `${JSON.stringify(output)}: globals()[${JSON.stringify(output)}]`
  );
  return `    return {${entries.join(", ")}}`;
}

function renderParameterList(values: string[]): string {
  return values.join(", ");
}

function renderStringList(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function graphDocumentPath(): string {
  return `${Deno.cwd()}/.nodebook_runtime_graph.py`;
}

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);
