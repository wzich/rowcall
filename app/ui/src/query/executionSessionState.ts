import type {
  ExecutionDisplayState,
  GraphExecutionDisplayState,
} from "../components/InspectorPanel.tsx";

export function preserveCompletedExecutionStatesForEdit(
  current: Record<string, ExecutionDisplayState>,
): Record<string, ExecutionDisplayState> {
  return Object.fromEntries(
    Object.entries(current)
      .filter(([, state]) => state.status !== "running")
      .map(([nodeId, state]) => [
        nodeId,
        state.status === "completed"
          ? { ...state, freshness: "document_changed" as const }
          : state,
      ]),
  );
}

export function preserveGraphExecutionStateForEdit(
  current: GraphExecutionDisplayState | null,
): GraphExecutionDisplayState | null {
  return current?.status === "completed"
    ? { ...current, freshness: "document_changed" }
    : null;
}
