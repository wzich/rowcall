import type { ExecutionDisplayState } from "../components/InspectorPanel.tsx";

export function preserveCompletedExecutionStatesForEdit(
  current: Record<string, ExecutionDisplayState>,
): Record<string, ExecutionDisplayState> {
  return Object.fromEntries(
    Object.entries(current).filter(([, state]) => state.status !== "running"),
  );
}

export function preserveUnaffectedExecutionStates(
  current: Record<string, ExecutionDisplayState>,
  invalidatedNodeIds: ReadonlySet<string>,
): Record<string, ExecutionDisplayState> {
  return Object.fromEntries(
    Object.entries(current).filter(([nodeId]) =>
      !invalidatedNodeIds.has(nodeId)
    ),
  );
}
