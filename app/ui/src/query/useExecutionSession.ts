import { useCallback, useRef, useState } from "react";
import type {
  ExecutionResponse,
  ExecutionStreamEvent,
} from "../../../../types.ts";
import type {
  ExecutionDisplayState,
  GraphExecutionDisplayState,
} from "../components/InspectorPanel.tsx";
import type { NodeRunVisualStatus } from "../graph/toReactFlow.ts";
import {
  createRunNotification,
  getNodeRunVisualStatusFromResponse,
  type RunNotification,
} from "./executionPresentation.ts";
import {
  preserveCompletedExecutionStatesForEdit,
  preserveUnaffectedExecutionStates,
} from "./executionSessionState.ts";

export function useExecutionSession(
  selectedSourceValue: string,
  options: { getCurrentSourceValue?: () => string } = {},
) {
  const [executionStateByNodeId, setExecutionStateByNodeId] = useState<
    Record<string, ExecutionDisplayState>
  >({});
  const [graphExecutionState, setGraphExecutionState] = useState<
    GraphExecutionDisplayState | null
  >(null);
  const [nodeRunStatuses, setNodeRunStatuses] = useState<
    Record<string, NodeRunVisualStatus>
  >({});
  const [runNotification, setRunNotification] = useState<
    RunNotification | null
  >(null);
  const selectedSourceValueRef = useRef(selectedSourceValue);
  selectedSourceValueRef.current = selectedSourceValue;
  const activeRunIdRef = useRef<string | null>(null);
  const activeRunAbortControllerRef = useRef<AbortController | null>(null);
  const activePlanNodeIdsRef = useRef<string[]>([]);
  const notificationIdRef = useRef(0);
  const notifiedResponseRef = useRef<ExecutionResponse | null>(null);

  function getCurrentSourceValue(): string {
    return options.getCurrentSourceValue?.() ?? selectedSourceValueRef.current;
  }

  function isCurrentSource(sourceValue: string): boolean {
    return sourceValue === getCurrentSourceValue();
  }

  function markNodeExecutionRunning(
    nodeId: string,
    runType: ExecutionResponse["runType"],
  ) {
    setExecutionStateByNodeId((current) => ({
      ...current,
      [nodeId]: { status: "running", runType },
    }));
    setGraphExecutionState({ status: "running", runType });
  }

  function markGraphExecutionRunning(
    runType: ExecutionResponse["runType"] = "run_graph",
    options: { clearNodeExecutionState?: boolean } = {},
  ) {
    const clearNodeExecutionState = options.clearNodeExecutionState ??
      runType === "run_graph";

    if (clearNodeExecutionState) {
      setExecutionStateByNodeId({});
    }
    setGraphExecutionState({ status: "running", runType });
  }

  function applyExecutionStreamEvent(
    event: ExecutionStreamEvent,
    sourceValue: string,
  ) {
    if (!isCurrentSource(sourceValue)) {
      return;
    }

    if (event.type === "run_started") {
      activeRunIdRef.current = event.runId;
      setGraphExecutionState({ status: "running", runType: event.runType });
      return;
    }

    if (activeRunIdRef.current !== event.runId) {
      return;
    }

    if (event.type === "run_plan") {
      activePlanNodeIdsRef.current = event.plan.steps.map((step) =>
        step.nodeId
      );
      setNodeRunStatuses(
        Object.fromEntries(
          event.plan.steps.map((step) => [step.nodeId, "queued" as const]),
        ),
      );
      return;
    }

    if (event.type === "node_started") {
      setExecutionStateByNodeId((current) => ({
        ...current,
        [event.nodeId]: {
          status: "running",
          runType: event.runType,
        },
      }));
      setNodeRunStatuses((current) => ({
        ...current,
        [event.nodeId]: "running",
      }));
      return;
    }

    if (event.type === "node_completed" || event.type === "node_failed") {
      setExecutionStateByNodeId((current) => ({
        ...current,
        [event.nodeId]: {
          status: event.type === "node_completed"
            ? "completed_node"
            : "failed_node",
          runType: event.runType,
          result: event.result,
        },
      }));
      setNodeRunStatuses((current) => ({
        ...current,
        [event.nodeId]: event.type === "node_completed"
          ? "completed"
          : "failed",
      }));
      return;
    }

    if (event.type === "run_completed" || event.type === "run_failed") {
      storeGraphExecutionResponse(event.response);
      storeExecutionResponseForNodeIds(
        event.response,
        activePlanNodeIdsRef.current.length > 0
          ? activePlanNodeIdsRef.current
          : [
            ...event.response.executedNodeIds,
            event.response.targetNodeId,
          ].filter((nodeId): nodeId is string => Boolean(nodeId)),
      );
    }
  }

  function storeExecutionResponseForNodeIds(
    response: ExecutionResponse,
    nodeIds: Iterable<string>,
  ) {
    const completedNodeIds = new Set(nodeIds);

    setExecutionStateByNodeId((current) => {
      const next = { ...current };

      for (const nodeId of completedNodeIds) {
        const result = response.resultsByNode[nodeId];
        next[nodeId] = result && !result.ok
          ? {
            status: "failed_node",
            runType: response.runType,
            result,
          }
          : {
            status: "completed",
            response,
          };
      }

      return next;
    });
    setNodeRunStatuses((current) => {
      const next = { ...current };

      for (const nodeId of completedNodeIds) {
        next[nodeId] = getNodeRunVisualStatusFromResponse(response, nodeId);
      }

      if (response.error?.nodeId) {
        next[response.error.nodeId] = "failed";
      }

      return next;
    });
  }

  function storeExecutionRequestErrorForNode(
    error: unknown,
    targetNodeId: string,
  ) {
    setExecutionStateByNodeId((current) => ({
      ...current,
      [targetNodeId]: {
        status: "request_error",
        message: error instanceof Error
          ? error.message
          : "The request failed before Python execution completed.",
      },
    }));
  }

  function resetUnfinishedRunStatuses() {
    setNodeRunStatuses((current) =>
      Object.fromEntries(
        Object.entries(current).map(([nodeId, status]) => [
          nodeId,
          status === "queued" || status === "running" ? "idle" : status,
        ]),
      )
    );
  }

  function startRunAbortController(): AbortController {
    activeRunAbortControllerRef.current?.abort();
    resetUnfinishedRunStatuses();
    setExecutionStateByNodeId((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([, state]) =>
          state.status !== "running"
        ),
      )
    );

    const controller = new AbortController();
    activeRunAbortControllerRef.current = controller;
    activeRunIdRef.current = null;
    activePlanNodeIdsRef.current = [];
    notifiedResponseRef.current = null;
    setRunNotification(null);
    return controller;
  }

  function clearActiveRun(controller: AbortController): boolean {
    if (activeRunAbortControllerRef.current === controller) {
      activeRunAbortControllerRef.current = null;
      activeRunIdRef.current = null;
      activePlanNodeIdsRef.current = [];
      return true;
    }
    return false;
  }

  function abortActiveRun() {
    activeRunAbortControllerRef.current?.abort();
    activeRunAbortControllerRef.current = null;
    activeRunIdRef.current = null;
    activePlanNodeIdsRef.current = [];
  }

  function storeGraphExecutionResponse(response: ExecutionResponse) {
    setGraphExecutionState({
      status: "completed",
      response,
    });
    if (notifiedResponseRef.current !== response) {
      notifiedResponseRef.current = response;
      notificationIdRef.current += 1;
      setRunNotification(
        createRunNotification(response, notificationIdRef.current),
      );
    }
  }

  function storeGraphExecutionRequestError(error: unknown) {
    setGraphExecutionState({
      status: "request_error",
      message: error instanceof Error
        ? error.message
        : "The request failed before Python execution completed.",
    });
    resetUnfinishedRunStatuses();
    notificationIdRef.current += 1;
    setRunNotification({
      id: notificationIdRef.current,
      tone: "danger",
      title: "Run couldn't start",
      summary: "Execution request failed",
      destination: { kind: "graph" },
    });
  }

  const dismissRunNotification = useCallback((notificationId?: number) => {
    setRunNotification((current) =>
      notificationId === undefined || current?.id === notificationId
        ? null
        : current
    );
  }, []);

  function clearExecutionSession() {
    abortActiveRun();
    setExecutionStateByNodeId({});
    setGraphExecutionState(null);
    setNodeRunStatuses({});
    setRunNotification(null);
    notifiedResponseRef.current = null;
  }

  function prepareForDocumentEdit() {
    abortActiveRun();
    setExecutionStateByNodeId((current) =>
      preserveCompletedExecutionStatesForEdit(current)
    );
    setGraphExecutionState(null);
    resetUnfinishedRunStatuses();
    setRunNotification(null);
    notifiedResponseRef.current = null;
  }

  function markNodesStale(nodeIds: Iterable<string>) {
    const staleNodeIds = new Set(nodeIds);
    if (staleNodeIds.size === 0) {
      return;
    }

    setExecutionStateByNodeId((current) =>
      preserveUnaffectedExecutionStates(current, staleNodeIds)
    );

    setNodeRunStatuses((current) => {
      const next = { ...current };

      for (const nodeId of staleNodeIds) {
        next[nodeId] = "stale";
      }

      return next;
    });
  }

  function forgetNodes(nodeIds: Iterable<string>) {
    const removedNodeIds = new Set(nodeIds);

    setExecutionStateByNodeId((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([nodeId]) =>
          !removedNodeIds.has(nodeId)
        ),
      )
    );
    setNodeRunStatuses((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([nodeId]) =>
          !removedNodeIds.has(nodeId)
        ),
      )
    );
  }

  return {
    executionStateByNodeId,
    graphExecutionState,
    nodeRunStatuses,
    runNotification,
    applyExecutionStreamEvent,
    clearActiveRun,
    clearExecutionSession,
    dismissRunNotification,
    isCurrentSource,
    forgetNodes,
    markGraphExecutionRunning,
    markNodesStale,
    markNodeExecutionRunning,
    prepareForDocumentEdit,
    resetUnfinishedRunStatuses,
    startRunAbortController,
    storeExecutionRequestErrorForNode,
    storeExecutionResponseForNodeIds,
    storeGraphExecutionRequestError,
    storeGraphExecutionResponse,
  };
}
