export type CanvasDeletionIntent =
  | { type: "edges"; edgeIds: string[] }
  | { type: "node"; nodeId: string };

export function getCanvasDeletionIntent({
  key,
  repeat,
  selectedNodeId,
  selectedEdgeIds,
}: {
  key: string;
  repeat: boolean;
  selectedNodeId: string | null;
  selectedEdgeIds: string[];
}): CanvasDeletionIntent | null {
  if (repeat || (key !== "Delete" && key !== "Backspace")) {
    return null;
  }

  if (selectedEdgeIds.length > 0) {
    return { type: "edges", edgeIds: selectedEdgeIds };
  }

  return selectedNodeId ? { type: "node", nodeId: selectedNodeId } : null;
}
