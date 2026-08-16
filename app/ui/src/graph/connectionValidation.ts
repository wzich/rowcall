import type { RowcallDocumentV1 } from "./documentTypes.ts";

export type ConnectionConflict = "duplicate" | "input_bound" | null;

export function getConnectionConflict(
  document: RowcallDocumentV1,
  fromNode: string,
  fromOutput: string,
  toNode: string,
  toInput: string,
): ConnectionConflict {
  if (
    !document.nodes.some((node) => node.id === fromNode) ||
    !document.nodes.some((node) => node.id === toNode)
  ) {
    return null;
  }

  if (
    document.edges.some((edge) =>
      edge.fromNode === fromNode && edge.fromOutput === fromOutput &&
      edge.toNode === toNode && edge.toInput === toInput
    )
  ) {
    return "duplicate";
  }

  return document.edges.some((edge) =>
      edge.toNode === toNode && edge.toInput === toInput
    )
    ? "input_bound"
    : null;
}
