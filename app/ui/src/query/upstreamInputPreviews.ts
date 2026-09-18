import type { Edge, NodeRunResult, ValuePreview } from "../../../../types.ts";
import type { NodeRunVisualStatus } from "../graph/toReactFlow.ts";

export type UpstreamInputPreview = {
  preview?: ValuePreview;
  source: string;
  status: NodeRunVisualStatus;
};

/** Inspection context only: these values are never used for execution. */
export function getUpstreamInputPreviews(
  nodeId: string,
  edges: Edge[],
  results: Record<string, NodeRunResult>,
  labels: Record<string, string>,
  statuses: Record<string, NodeRunVisualStatus>,
): Record<string, UpstreamInputPreview> {
  return Object.fromEntries(
    edges.filter((edge) => edge.toNode === nodeId).map(
      (edge) => {
        const result = results[edge.fromNode];
        const preview = result?.ok
          ? result.outputs[edge.fromOutput]
          : undefined;
        return [edge.toInput, {
          preview: preview ? { ...preview, name: edge.toInput } : undefined,
          source: labels[edge.fromNode] ?? edge.fromNode,
          status: statuses[edge.fromNode] ?? "idle",
        }];
      },
    ),
  );
}
