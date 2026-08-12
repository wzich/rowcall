import type {
  ExecutionResponse,
  ExecutionRunType,
  ExecutionStreamEvent,
  NodeRunResult,
  RunPlan,
  TableQueryRequest,
  TableQueryResponse,
} from "./types.ts";
import {
  getPythonEnvironmentInfo,
  type PythonEnvironmentInfo,
  resolvePythonCommand,
} from "./runtime_config.ts";

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

export async function* streamSourceRunToNode(
  runId: string,
  source: string,
  documentPath: string,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  trace: boolean = false,
  signal?: AbortSignal,
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
    signal,
  );
}

export async function* streamSourceRunSingleNode(
  runId: string,
  source: string,
  documentPath: string,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  trace: boolean = false,
  signal?: AbortSignal,
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
    signal,
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

export async function* streamSourceRunGraph(
  runId: string,
  source: string,
  documentPath: string,
  userInputs: Record<string, unknown> = {},
  trace: boolean = false,
  signal?: AbortSignal,
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
    signal,
  );
}

export type RuntimeCacheCompatibilityStatus = {
  ok: true;
  clearedEntries: 0;
  cachingDisabled: true;
};

export async function clearSourceRuntimeSessionCache(): Promise<
  RuntimeCacheCompatibilityStatus
> {
  const event = await sourceRuntimeWorker.requestFinalEvent(
    "clear_session_cache",
  );
  if (
    event.type !== "session_cache_cleared" || event.ok !== true ||
    event.clearedEntries !== 0 || event.cachingDisabled !== true
  ) {
    throw new Error(
      workerErrorMessage(
        event,
        "Python worker returned an invalid cache-disabled compatibility status",
      ),
    );
  }
  return { ok: true, clearedEntries: 0, cachingDisabled: true };
}

export async function querySourceRuntimeTable(
  request: TableQueryRequest,
): Promise<TableQueryResponse> {
  const event = await sourceRuntimeWorker.requestFinalEvent(
    "query_table",
    request,
  );
  if (event.type !== "table_query_completed") {
    throw new Error(
      workerErrorMessage(event, "Python worker table query failed"),
    );
  }
  return event as TableQueryResponse & PythonWorkerEvent;
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
  if (Object.keys(result.views).length > 0) {
    console.log("views:");
    console.log(
      Object.fromEntries(
        Object.entries(result.views).map(([name, preview]) => {
          if (!preview.image) return [name, preview];
          return [name, {
            ...preview,
            image: {
              mimeType: preview.image.mimeType,
              width: preview.image.width,
              height: preview.image.height,
              sizeBytes: preview.image.sizeBytes,
              dataOmitted: true,
            },
          }];
        }),
      ),
    );
  }

  if (!result.ok && result.error) {
    console.log(`error: ${result.error}`);
  }
}

async function executeWorkerRun(
  runId: string,
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
      runId,
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

async function executeSourceRun(
  source: string,
  documentPath: string,
  runType: ExecutionRunType,
  targetNodeId: string | undefined,
  traceEnabled: boolean,
): Promise<ExecutionResponse> {
  return await executeWorkerRun(
    crypto.randomUUID(),
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
  signal?: AbortSignal,
): AsyncGenerator<ExecutionStreamEvent> {
  yield* streamWorkerRun(
    runId,
    source,
    documentPath,
    runType,
    targetNodeId,
    traceEnabled,
    undefined,
    signal,
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
  signal?: AbortSignal,
): AsyncGenerator<ExecutionStreamEvent> {
  for await (
    const event of streamWorkerRunEvents(
      runId,
      source,
      documentPath,
      runType,
      targetNodeId,
      traceEnabled,
      inputs,
      signal,
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
  runId: string,
  source: string,
  documentPath: string,
  runType: ExecutionRunType,
  targetNodeId: string | undefined,
  traceEnabled: boolean,
  inputs: Record<string, unknown> = {},
  signal?: AbortSignal,
): AsyncGenerator<PythonWorkerEvent> {
  const payload: Record<string, unknown> = {
    runId,
    source,
    documentPath,
    trace: traceEnabled,
    inputs,
  };
  if (targetNodeId) {
    payload.target = targetNodeId;
  }

  yield* sourceRuntimeWorker.request(runType, payload, { signal });
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
