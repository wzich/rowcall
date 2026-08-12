import { useCallback, useRef, useState } from "react";
import type {
  ExecutionResponse,
  ExecutionStreamEvent,
  ResultStoreIdentity,
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
  preserveGraphExecutionStateForEdit,
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
  const [activeRunType, setActiveRunType] = useState<
    ExecutionResponse["runType"] | null
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
  const executionStateByNodeIdRef = useRef(executionStateByNodeId);
  executionStateByNodeIdRef.current = executionStateByNodeId;
  const graphExecutionStateRef = useRef(graphExecutionState);
  graphExecutionStateRef.current = graphExecutionState;
  const preRunExecutionStateRef = useRef<
    Record<string, ExecutionDisplayState>
  >({});
  const preRunGraphExecutionStateRef = useRef<
    GraphExecutionDisplayState | null
  >(null);
  const latestResultStoreRef = useRef<ResultStoreIdentity | null>(null);

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
    setActiveRunType(runType);
    if (runType === "run_graph") {
      setGraphExecutionState({ status: "running" });
    }
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
    setActiveRunType(runType);
    if (runType === "run_graph") {
      setGraphExecutionState({ status: "running" });
    }
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
      setActiveRunType(event.runType);
      if (event.runType === "run_graph") {
        setGraphExecutionState({ status: "running" });
      }
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
      if (event.response.runType === "run_graph") {
        storeGraphExecutionResponse(event.response);
      } else {
        storeRunNotification(event.response);
      }
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

    if (!response.ok) {
      storeFailedExecutionResponse(response, completedNodeIds);
      return;
    }

    const publishedResultStore = response.resultStore;
    if (publishedResultStore) {
      latestResultStoreRef.current = publishedResultStore;
      setGraphExecutionState((current) =>
        current?.status === "completed" && current.response.resultStore &&
          !sameResultStore(current.response.resultStore, publishedResultStore)
          ? { ...current, freshness: "replaced" }
          : current
      );
    }

    setExecutionStateByNodeId((current) => {
      const next = Object.fromEntries(
        Object.entries(current).map(([nodeId, state]) => [
          nodeId,
          state.status === "completed" && state.response.resultStore &&
            publishedResultStore &&
            !sameResultStore(state.response.resultStore, publishedResultStore)
            ? { ...state, freshness: "replaced" as const }
            : state,
        ]),
      );

      for (const nodeId of completedNodeIds) {
        next[nodeId] = {
          status: "completed",
          response,
          freshness: "fresh",
        };
      }

      return next;
    });
    setNodeRunStatuses((current) => {
      const next = { ...current };

      for (const nodeId of Object.keys(executionStateByNodeIdRef.current)) {
        if (!completedNodeIds.has(nodeId)) {
          next[nodeId] = "stale";
        }
      }

      for (const nodeId of completedNodeIds) {
        next[nodeId] = getNodeRunVisualStatusFromResponse(response, nodeId);
      }

      if (response.error?.nodeId) {
        next[response.error.nodeId] = "failed";
      }

      return next;
    });
  }

  function storeFailedExecutionResponse(
    response: ExecutionResponse,
    completedNodeIds: Set<string>,
  ) {
    const latestResultStore = latestResultStoreRef.current;
    const canRestoreLatest = latestResultStore !== null &&
      response.documentRevision === latestResultStore.documentRevision;
    const prior = preRunExecutionStateRef.current;
    const restoredEntries = canRestoreLatest
      ? Object.entries(prior).filter(([, state]) =>
        state.status === "completed" && state.response.resultStore &&
        sameResultStore(state.response.resultStore, latestResultStore)
      )
      : [];
    const restoredNodeIds = new Set(restoredEntries.map(([nodeId]) => nodeId));

    if (canRestoreLatest) {
      setGraphExecutionState((current) =>
        current?.status === "completed" && current.response.resultStore &&
          sameResultStore(current.response.resultStore, latestResultStore)
          ? { ...current, freshness: "failed_run", latestFailure: response }
          : current
      );
    }

    setExecutionStateByNodeId((current) => {
      const next = { ...current };

      for (const [nodeId, state] of restoredEntries) {
        if (state.status === "completed") {
          next[nodeId] = {
            ...state,
            freshness: "failed_run",
            latestFailure: response,
          };
        }
      }

      for (const nodeId of completedNodeIds) {
        if (restoredNodeIds.has(nodeId)) continue;
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
            freshness: "fresh",
          };
      }

      return next;
    });
    setNodeRunStatuses((current) => {
      const next = { ...current };

      for (const nodeId of restoredNodeIds) {
        next[nodeId] = response.error?.nodeId === nodeId ? "failed" : "stale";
      }
      for (const nodeId of completedNodeIds) {
        if (!restoredNodeIds.has(nodeId)) {
          next[nodeId] = getNodeRunVisualStatusFromResponse(response, nodeId);
        }
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
    const message = error instanceof Error
      ? error.message
      : "The request failed before Python execution completed.";
    setExecutionStateByNodeId((current) => ({
      ...current,
      [targetNodeId]: {
        status: "request_error",
        message,
      },
    }));
    notificationIdRef.current += 1;
    setRunNotification({
      id: notificationIdRef.current,
      tone: "danger",
      title: "Run couldn't start",
      summary: "Execution request failed",
      destination: { kind: "node", nodeId: targetNodeId },
    });
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
    preRunExecutionStateRef.current = executionStateByNodeIdRef.current;
    preRunGraphExecutionStateRef.current = graphExecutionStateRef.current;

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
      setActiveRunType(null);
      return true;
    }
    return false;
  }

  function abortActiveRun() {
    activeRunAbortControllerRef.current?.abort();
    activeRunAbortControllerRef.current = null;
    activeRunIdRef.current = null;
    activePlanNodeIdsRef.current = [];
    setActiveRunType(null);
  }

  function storeRunNotification(response: ExecutionResponse) {
    if (notifiedResponseRef.current === response) {
      return;
    }
    notifiedResponseRef.current = response;
    notificationIdRef.current += 1;
    setRunNotification(
      createRunNotification(response, notificationIdRef.current),
    );
  }

  function storeGraphExecutionResponse(response: ExecutionResponse) {
    if (response.runType !== "run_graph") {
      storeRunNotification(response);
      return;
    }
    const latestResultStore = latestResultStoreRef.current;
    const prior = preRunGraphExecutionStateRef.current;
    setGraphExecutionState(
      !response.ok && latestResultStore &&
        response.documentRevision === latestResultStore.documentRevision &&
        prior?.status === "completed" && prior.response.resultStore &&
        sameResultStore(prior.response.resultStore, latestResultStore)
        ? { ...prior, freshness: "failed_run", latestFailure: response }
        : {
          status: "completed",
          response,
          freshness: "fresh",
        },
    );
    storeRunNotification(response);
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
    latestResultStoreRef.current = null;
  }

  function prepareForDocumentEdit() {
    abortActiveRun();
    setExecutionStateByNodeId((current) =>
      preserveCompletedExecutionStatesForEdit(current)
    );
    setGraphExecutionState(preserveGraphExecutionStateForEdit);
    resetUnfinishedRunStatuses();
    setRunNotification(null);
    notifiedResponseRef.current = null;
    latestResultStoreRef.current = null;
  }

  function markNodesStale(nodeIds: Iterable<string>) {
    const staleNodeIds = new Set(nodeIds);
    if (staleNodeIds.size === 0) {
      return;
    }

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
    activeRunType,
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
    storeRunNotification,
    storeExecutionResponseForNodeIds,
    storeGraphExecutionRequestError,
    storeGraphExecutionResponse,
  };
}

function sameResultStore(
  left: ResultStoreIdentity,
  right: ResultStoreIdentity,
): boolean {
  return left.runId === right.runId &&
    left.documentRevision === right.documentRevision;
}
