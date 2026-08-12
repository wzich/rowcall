import type {
  ExecutionResponse,
  ExecutionStreamEvent,
  TableQueryRequest,
  TableQueryResponse,
} from "../../../../types.ts";
import { nodebookFetch } from "./auth.ts";

export type RunExecutionRequest = {
  nodeId: string;
  source?: string;
  expectedRevision?: string;
  trace?: boolean;
  onEvent?: (event: ExecutionStreamEvent) => void;
  signal?: AbortSignal;
};

export type RunGraphRequest = {
  source?: string;
  expectedRevision?: string;
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

export class TableQueryRequestError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "TableQueryRequestError";
    this.kind = kind;
  }
}

export async function queryResultTable(
  request: TableQueryRequest,
  signal?: AbortSignal,
): Promise<TableQueryResponse & { ok: true }> {
  const response = await nodebookFetch("/results/table", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  let payload: TableQueryResponse;
  try {
    payload = JSON.parse(await response.text()) as TableQueryResponse;
  } catch {
    throw new TableQueryRequestError(
      "invalid_response",
      `The interactive table endpoint returned an invalid response (HTTP ${response.status}).`,
    );
  }
  if (!response.ok || !payload.ok) {
    const error = payload.ok
      ? { kind: "table_query_failed", message: "The table query failed." }
      : payload.error;
    throw new TableQueryRequestError(error.kind, error.message);
  }
  return payload;
}

async function runExecution(
  path: "/run-to-node",
  {
    nodeId,
    source,
    expectedRevision,
    trace = false,
    onEvent,
    signal,
  }: RunExecutionRequest,
): Promise<ExecutionResponse> {
  const response = await nodebookFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(onEvent ? { Accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify({
      nodeId,
      ...(source !== undefined ? { source } : {}),
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
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
  // import boundary so execution responses cannot drift.
  return await response.json() as ExecutionResponse;
}

async function runGraphExecution(
  { source, expectedRevision, trace = false, onEvent, signal }: RunGraphRequest,
): Promise<ExecutionResponse> {
  const response = await nodebookFetch("/run-graph", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(onEvent ? { Accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify({
      ...(source !== undefined ? { source } : {}),
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
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
  // import boundary so execution responses cannot drift.
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
