import type { ExecutionDisplayState } from "../components/InspectorPanel.tsx";

export function preserveCompletedExecutionStatesForEdit(
  current: Record<string, ExecutionDisplayState>,
): Record<string, ExecutionDisplayState> {
  return Object.fromEntries(
    Object.entries(current).filter(([, state]) => state.status !== "running"),
  );
}
