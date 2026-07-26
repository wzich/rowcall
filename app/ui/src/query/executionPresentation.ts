import type { ExecutionResponse } from "../../../../types.ts";
import type { NodeRunVisualStatus } from "../graph/toReactFlow.ts";

export type RunNotificationDestination =
  | { kind: "document_globals" }
  | { kind: "node"; nodeId: string }
  | { kind: "graph" };

export type RunNotification = {
  id: number;
  tone: "success" | "danger";
  title: string;
  summary: string;
  destination: RunNotificationDestination;
};

export function createRunNotification(
  response: ExecutionResponse,
  id: number,
): RunNotification {
  if (response.ok) {
    return {
      id,
      tone: "success",
      title: "Run succeeded",
      summary: response.runType === "run_graph"
        ? "Graph completed"
        : "Run through completed",
      destination: response.runType === "run_to_node" && response.targetNodeId
        ? { kind: "node", nodeId: response.targetNodeId }
        : { kind: "graph" },
    };
  }

  const error = response.error;
  if (error?.phase === "document_globals") {
    return {
      id,
      tone: "danger",
      title: "Run couldn't start",
      summary: error.missingModule
        ? `Missing ${error.missingModule} in Document Globals`
        : "Document Globals failed",
      destination: { kind: "document_globals" },
    };
  }

  if (error?.nodeId) {
    return {
      id,
      tone: "danger",
      title: "Run failed",
      summary: "A step failed",
      destination: { kind: "node", nodeId: error.nodeId },
    };
  }

  return {
    id,
    tone: "danger",
    title: "Run failed",
    summary: "View run details",
    destination: { kind: "graph" },
  };
}

export function getNodeRunVisualStatusFromResponse(
  response: ExecutionResponse,
  nodeId: string,
): NodeRunVisualStatus {
  const result = response.resultsByNode[nodeId];
  if (result) {
    return result.ok ? "completed" : "failed";
  }

  if (response.ok) {
    return "completed";
  }

  return response.error?.phase === "document_globals"
    ? "blocked_globals"
    : "blocked";
}
