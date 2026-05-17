import type { RuntimeGraph } from "../graph/runtimeTypes.ts";
import type { GraphSource } from "./graphSources.ts";
import { toInspectRequest } from "./graphSources.ts";

export type InspectGraphSummary = {
  nodeCount: number;
  edgeCount: number;
  sourceNodeIds: string[];
  sinkNodeIds: string[];
};

export type InspectGraphNodeDetail = {
  id: string;
  outputs: string[];
  upstreamDependencies: string[];
  downstreamDependencies: string[];
  isSourceNode: boolean;
  isSinkNode: boolean;
};

export type InspectGraphValidationIssue = {
  kind: string;
  message: string;
  path?: string;
  nodeId?: string;
  edgeIndex?: number;
  field?: string;
};

export type InspectGraphSuccess = {
  ok: true;
  graph: RuntimeGraph;
  summary: InspectGraphSummary;
  nodeDetails: InspectGraphNodeDetail[];
};

export type InspectGraphError = {
  ok: false;
  error: {
    kind: string;
    message: string;
    issues?: InspectGraphValidationIssue[];
  };
};

export type InspectGraphResult = InspectGraphSuccess | InspectGraphError;

export async function inspectGraph(
  source: GraphSource,
): Promise<InspectGraphResult> {
  return await inspectGraphRequest(toInspectRequest(source));
}

export async function inspectGraphText(
  text: string,
): Promise<InspectGraphResult> {
  return await inspectGraphRequest({
    source: {
      type: "text",
      text,
    },
  });
}

async function inspectGraphRequest(
  request: unknown,
): Promise<InspectGraphResult> {
  const response = await fetch("/inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  // TODO: Validate this response with shared schemas once the UI and runtime
  // share a real contract package instead of duplicated TypeScript types.
  return await response.json() as InspectGraphResult;
}
