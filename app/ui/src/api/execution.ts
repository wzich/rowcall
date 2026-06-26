import type { NodebookDocumentV1 } from "../../../../document.ts";
import type {
  ExecutionResponse,
  ExecutionStreamEvent,
  Graph,
} from "../../../../types.ts";

export type RunExecutionRequest = {
  graph: Graph;
  nodeId: string;
  document?: NodebookDocumentV1;
  inputs?: Record<string, unknown>;
  source?: string;
  trace?: boolean;
  onEvent?: (event: ExecutionStreamEvent) => void;
  signal?: AbortSignal;
};

export type RunGraphRequest = {
  graph: Graph;
  document?: NodebookDocumentV1;
  inputs?: Record<string, unknown>;
  source?: string;
  trace?: boolean;
  onEvent?: (event: ExecutionStreamEvent) => void;
  signal?: AbortSignal;
};

export class RunExecutionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunExecutionRequestError";
  }
}

async function runExecution(
  path: "/run-node" | "/run-to-node",
  {
    graph,
    nodeId,
    document,
    inputs = {},
    source,
    trace = false,
    onEvent,
    signal,
  }: RunExecutionRequest,
): Promise<ExecutionResponse> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(onEvent ? { Accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify({
      graph,
      nodeId,
      ...(path === "/run-to-node" && document !== undefined
        ? { document }
        : {}),
      inputs,
      ...(path === "/run-to-node" && source !== undefined ? { source } : {}),
      trace,
    }),
    signal,
  });

  if (!response.ok) {
    throw new RunExecutionRequestError(
      `Execution request failed with HTTP ${response.status}`,
    );
  }

  if (onEvent) {
    return await readExecutionEventStream(response, onEvent);
  }

  // TODO: Move all UI/runtime contract types to a shared package or shared
  // import boundary so inspect and execution responses cannot drift.
  return await response.json() as ExecutionResponse;
}

async function runGraphExecution(
  { graph, document, inputs = {}, source, trace = false, onEvent, signal }:
    RunGraphRequest,
): Promise<ExecutionResponse> {
  const response = await fetch("/run-graph", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(onEvent ? { Accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify({
      graph,
      ...(document !== undefined ? { document } : {}),
      inputs,
      ...(source !== undefined ? { source } : {}),
      trace,
    }),
    signal,
  });

  if (!response.ok) {
    throw new RunExecutionRequestError(
      `Execution request failed with HTTP ${response.status}`,
    );
  }

  if (onEvent) {
    return await readExecutionEventStream(response, onEvent);
  }

  // TODO: Move all UI/runtime contract types to a shared package or shared
  // import boundary so inspect and execution responses cannot drift.
  return await response.json() as ExecutionResponse;
}

async function readExecutionEventStream(
  response: Response,
  onEvent: (event: ExecutionStreamEvent) => void,
): Promise<ExecutionResponse> {
  if (!response.body) {
    throw new RunExecutionRequestError("Execution stream had no response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse: ExecutionResponse | null = null;

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const event = parseExecutionEventFrame(frame);
      if (!event) continue;

      onEvent(event);

      if (event.type === "run_completed" || event.type === "run_failed") {
        finalResponse = event.response;
      }
    }

    if (done) break;
  }

  if (finalResponse) {
    return finalResponse;
  }

  throw new RunExecutionRequestError(
    "Execution stream ended before a final run event was received",
  );
}

function parseExecutionEventFrame(frame: string): ExecutionStreamEvent | null {
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());

  if (dataLines.length === 0) {
    return null;
  }

  return JSON.parse(dataLines.join("\n")) as ExecutionStreamEvent;
}

export function runNode(
  request: RunExecutionRequest,
): Promise<ExecutionResponse> {
  return runExecution("/run-node", request);
}

export function runToNode(
  request: RunExecutionRequest,
): Promise<ExecutionResponse> {
  return runExecution("/run-to-node", request);
}

export function runGraph(
  request: RunGraphRequest,
): Promise<ExecutionResponse> {
  return runGraphExecution(request);
}
