import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  availableGraphSources,
  defaultGraphSource,
  describeGraphSource,
  encodeGraphSource,
  getGraphSourceByValue,
} from "./api/graphSources.ts";
import { Canvas } from "./components/Canvas.tsx";
import {
  type GraphInspectorModel,
  InspectorPanel,
  type NodeInspectorBadge,
  type NodeInspectorSelection,
} from "./components/InspectorPanel.tsx";
import {
  runGraphMutationOptions,
  runNodeMutationOptions,
  runToNodeMutationOptions,
} from "./query/executionMutations.ts";
import {
  inspectedGraphQueryOptions,
  InspectGraphQueryError,
} from "./query/graphQueries.ts";
import { useExecutionSession } from "./query/useExecutionSession.ts";

export default function App() {
  const [selectedSource, setSelectedSource] = useState(defaultGraphSource);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [inputsText, setInputsText] = useState("{}");
  const [inputsError, setInputsError] = useState<string | null>(null);
  const [traceEnabled, setTraceEnabled] = useState(false);
  const selectedSourceValue = encodeGraphSource(selectedSource);
  const sourceLabel = describeGraphSource(selectedSource);
  const inspectedGraphQuery = useQuery(
    inspectedGraphQueryOptions(selectedSource),
  );
  const {
    executionStateByNodeId,
    graphExecutionState,
    nodeRunStatuses,
    applyExecutionStreamEvent,
    clearActiveRun,
    clearExecutionSession,
    isCurrentSource,
    markGraphExecutionRunning,
    markNodeExecutionRunning,
    resetUnfinishedRunStatuses,
    startRunAbortController,
    storeExecutionRequestErrorForNode,
    storeExecutionResponseForNodeIds,
    storeGraphExecutionRequestError,
    storeGraphExecutionResponse,
  } = useExecutionSession(selectedSourceValue);

  const runNodeMutation = useMutation({
    ...runNodeMutationOptions(),
    onSuccess: (response, variables) => {
      if (!isCurrentSource(variables.sourceValue)) {
        return;
      }

      storeExecutionResponseForNodeIds(response, [
        ...response.executedNodeIds,
        variables.nodeId,
      ]);
      storeGraphExecutionResponse(response);
      clearActiveRun(variables.abortController);
    },
    onError: (error, variables) => {
      if (!isCurrentSource(variables.sourceValue)) {
        return;
      }
      if (isAbortError(error)) {
        if (clearActiveRun(variables.abortController)) {
          resetUnfinishedRunStatuses();
        }
        return;
      }

      storeExecutionRequestErrorForNode(error, variables.nodeId);
      storeGraphExecutionRequestError(error);
      clearActiveRun(variables.abortController);
    },
  });
  const runToNodeMutation = useMutation({
    ...runToNodeMutationOptions(),
    onSuccess: (response, variables) => {
      if (!isCurrentSource(variables.sourceValue)) {
        return;
      }

      storeExecutionResponseForNodeIds(response, [
        ...response.executedNodeIds,
        variables.nodeId,
      ]);
      storeGraphExecutionResponse(response);
      clearActiveRun(variables.abortController);
    },
    onError: (error, variables) => {
      if (!isCurrentSource(variables.sourceValue)) {
        return;
      }
      if (isAbortError(error)) {
        if (clearActiveRun(variables.abortController)) {
          resetUnfinishedRunStatuses();
        }
        return;
      }

      storeExecutionRequestErrorForNode(error, variables.nodeId);
      storeGraphExecutionRequestError(error);
      clearActiveRun(variables.abortController);
    },
  });
  const runGraphMutation = useMutation({
    ...runGraphMutationOptions(),
    onSuccess: (response, variables) => {
      if (!isCurrentSource(variables.sourceValue)) {
        return;
      }

      storeGraphExecutionResponse(response);
      // TODO: Fold graph and node execution state into a single execution
      // session model once streaming or run history makes this duplication hurt.
      storeExecutionResponseForNodeIds(
        response,
        variables.graph.nodes.map((node) => node.id),
      );
      clearActiveRun(variables.abortController);
    },
    onError: (error, variables) => {
      if (!isCurrentSource(variables.sourceValue)) {
        return;
      }
      if (isAbortError(error)) {
        if (clearActiveRun(variables.abortController)) {
          resetUnfinishedRunStatuses();
        }
        return;
      }

      storeGraphExecutionRequestError(error);
      clearActiveRun(variables.abortController);
    },
  });
  const inspectionIssues = inspectedGraphQuery.error instanceof
      InspectGraphQueryError
    ? inspectedGraphQuery.error.issues
    : [];
  const graphInspectorDetails = useMemo<GraphInspectorModel | null>(() => {
    if (!inspectedGraphQuery.isSuccess) {
      return null;
    }

    const inspectedGraph = inspectedGraphQuery.data;
    const isolatedNodeIds = inspectedGraph.summary.nodeCount > 1
      ? inspectedGraph.nodeDetails
        .filter((detail) => detail.isSourceNode && detail.isSinkNode)
        .map((detail) => detail.id)
      : [];

    return {
      nodeCount: inspectedGraph.summary.nodeCount,
      edgeCount: inspectedGraph.summary.edgeCount,
      sourceNodeIds: inspectedGraph.summary.sourceNodeIds,
      sinkNodeIds: inspectedGraph.summary.sinkNodeIds,
      isolatedNodeIds,
      sinkOutputs: inspectedGraph.summary.sinkNodeIds.map((nodeId) => {
        const node = inspectedGraph.graph.nodes.find((item) =>
          item.id === nodeId
        );

        return {
          nodeId,
          outputs: node?.outputs ?? [],
        };
      }),
    };
  }, [inspectedGraphQuery]);
  const selectedNodeDetails = useMemo<NodeInspectorSelection | null>(() => {
    if (!inspectedGraphQuery.isSuccess || selectedNodeId === null) {
      return null;
    }

    const inspectedGraph = inspectedGraphQuery.data;
    const node = inspectedGraph.graph.nodes.find((item) =>
      item.id === selectedNodeId
    );

    if (!node) {
      return null;
    }

    const detail = inspectedGraph.nodeDetails.find((item) =>
      item.id === selectedNodeId
    );
    const badges: NodeInspectorBadge[] = [];
    const canShowGraphPositionBadge = inspectedGraph.summary.nodeCount > 1;

    if (
      canShowGraphPositionBadge && detail?.isSourceNode &&
      detail?.isSinkNode
    ) {
      badges.push("Isolated");
    } else if (canShowGraphPositionBadge) {
      if (detail?.isSourceNode) badges.push("Source");
      if (detail?.isSinkNode) badges.push("Sink");
    }

    return {
      id: node.id,
      code: node.code,
      outputs: node.outputs,
      upstreamDependencies: detail?.upstreamDependencies ?? [],
      downstreamDependencies: detail?.downstreamDependencies ?? [],
      badges,
    };
  }, [inspectedGraphQuery, selectedNodeId]);

  function handleSourceChange(value: string) {
    clearExecutionSession();
    setSelectedNodeId(null);
    setInputsText("{}");
    setInputsError(null);
    setTraceEnabled(false);
    setSelectedSource(getGraphSourceByValue(value));
  }

  function parseRunInputs(): Record<string, unknown> | null {
    const trimmedInputs = inputsText.trim();

    if (trimmedInputs.length === 0) {
      setInputsError(null);
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedInputs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setInputsError(`Inputs must be valid JSON: ${message}`);
      return null;
    }

    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      setInputsError("Inputs must be a JSON object.");
      return null;
    }

    setInputsError(null);
    return parsed as Record<string, unknown>;
  }

  function handleInputsChange(value: string) {
    setInputsText(value);
    setInputsError(getInputsValidationError(value));
  }

  function isInputsTextValid(): boolean {
    return getInputsValidationError(inputsText) === null;
  }

  function handleRunNode(nodeId: string) {
    if (!inspectedGraphQuery.isSuccess) {
      return;
    }

    const inputs = parseRunInputs();
    if (inputs === null) {
      return;
    }

    markNodeExecutionRunning(nodeId, "run_node");
    const abortController = startRunAbortController();
    runNodeMutation.mutate({
      graph: inspectedGraphQuery.data.graph,
      nodeId,
      inputs,
      trace: traceEnabled,
      onEvent: (event) => applyExecutionStreamEvent(event, selectedSourceValue),
      signal: abortController.signal,
      abortController,
      sourceValue: selectedSourceValue,
    });
  }

  function handleRunToNode(nodeId: string) {
    if (!inspectedGraphQuery.isSuccess) {
      return;
    }

    const inputs = parseRunInputs();
    if (inputs === null) {
      return;
    }

    markNodeExecutionRunning(nodeId, "run_to_node");
    const abortController = startRunAbortController();
    runToNodeMutation.mutate({
      graph: inspectedGraphQuery.data.graph,
      nodeId,
      inputs,
      trace: traceEnabled,
      onEvent: (event) => applyExecutionStreamEvent(event, selectedSourceValue),
      signal: abortController.signal,
      abortController,
      sourceValue: selectedSourceValue,
    });
  }

  function handleRunGraph() {
    if (!inspectedGraphQuery.isSuccess) {
      return;
    }

    const inputs = parseRunInputs();
    if (inputs === null) {
      return;
    }

    markGraphExecutionRunning();
    const abortController = startRunAbortController();
    runGraphMutation.mutate({
      graph: inspectedGraphQuery.data.graph,
      inputs,
      trace: traceEnabled,
      onEvent: (event) => applyExecutionStreamEvent(event, selectedSourceValue),
      signal: abortController.signal,
      abortController,
      sourceValue: selectedSourceValue,
    });
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-zinc-100 text-zinc-950">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 bg-white px-5 py-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Read-only canvas
          </p>
          <h1 className="text-lg font-semibold">Nodebook</h1>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-600">
          Example
          <select
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 shadow-sm"
            value={selectedSourceValue}
            onChange={(event) => handleSourceChange(event.currentTarget.value)}
          >
            {availableGraphSources.map((item) => (
              <option
                key={encodeGraphSource(item.source)}
                value={encodeGraphSource(item.source)}
              >
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden">
        {inspectedGraphQuery.isLoading && (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Loading {sourceLabel}...
          </div>
        )}
        {inspectedGraphQuery.isError && (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-md rounded-lg border border-red-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-red-700">
                Could not load graph
              </h2>
              <p className="mt-2 text-sm text-zinc-600">
                {sourceLabel}
              </p>
              <p className="mt-2 text-sm text-zinc-600">
                {inspectedGraphQuery.error.message}
              </p>
              {inspectionIssues.length > 0 && (
                <ul className="mt-3 space-y-2 text-sm text-zinc-700">
                  {inspectionIssues.map((issue, index) => (
                    <li
                      key={`${issue.kind}-${issue.path ?? "graph"}-${index}`}
                      className="rounded-md bg-red-50 px-3 py-2"
                    >
                      <span className="font-medium text-red-800">
                        {issue.kind}
                      </span>
                      <span className="block text-zinc-700">
                        {issue.message}
                      </span>
                      {issue.path && (
                        <span className="mt-1 block text-xs text-zinc-500">
                          Path: {issue.path}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-zinc-500">
                {inspectionIssues.length > 0
                  ? "These issues were returned by the /inspect validation step."
                  : "Make sure the Deno API is running before loading the Vite UI."}
              </p>
            </div>
          </div>
        )}
        {inspectedGraphQuery.isSuccess && graphInspectorDetails && (
          <div className="flex h-full min-h-0">
            <div className="min-h-0 min-w-0 flex-1">
              <Canvas
                key={selectedSourceValue}
                graph={inspectedGraphQuery.data.graph}
                selectedNodeId={selectedNodeId}
                nodeRunStatuses={nodeRunStatuses}
                onNodeSelect={setSelectedNodeId}
                onSelectionClear={() => setSelectedNodeId(null)}
              />
            </div>
            <InspectorPanel
              selectedNode={selectedNodeDetails}
              graph={graphInspectorDetails}
              selectedNodeExecutionState={selectedNodeId
                ? executionStateByNodeId[selectedNodeId] ?? null
                : null}
              graphExecutionState={graphExecutionState}
              inputsText={inputsText}
              inputsError={inputsError}
              areInputsValid={isInputsTextValid()}
              traceEnabled={traceEnabled}
              onNodeSelect={setSelectedNodeId}
              onInputsChange={handleInputsChange}
              onTraceEnabledChange={setTraceEnabled}
              onRunNode={handleRunNode}
              onRunToNode={handleRunToNode}
              onRunGraph={handleRunGraph}
              onSelectionClear={() => setSelectedNodeId(null)}
            />
          </div>
        )}
      </main>
    </div>
  );
}

function getInputsValidationError(inputsText: string): string | null {
  const trimmedInputs = inputsText.trim();
  if (trimmedInputs.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedInputs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Inputs must be valid JSON: ${message}`;
  }

  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
  ) {
    return "Inputs must be a JSON object.";
  }

  return null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
