import type { ExecutionResponse, Graph } from "../../../../types.ts";

export type RunExecutionRequest = {
  graph: Graph;
  nodeId: string;
  inputs?: Record<string, unknown>;
  trace?: boolean;
};

export class RunExecutionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunExecutionRequestError";
  }
}

async function runExecution(
  path: "/run-node" | "/run-to-node",
  { graph, nodeId, inputs = {}, trace = false }: RunExecutionRequest,
): Promise<ExecutionResponse> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      graph,
      nodeId,
      inputs,
      trace,
    }),
  });

  if (!response.ok) {
    throw new RunExecutionRequestError(
      `Execution request failed with HTTP ${response.status}`,
    );
  }

  // TODO: Move all UI/runtime contract types to a shared package or shared
  // import boundary so inspect and execution responses cannot drift.
  return await response.json() as ExecutionResponse;
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
