import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  inspectGraphText,
  type InspectGraphValidationIssue,
} from "./api/inspectGraph.ts";
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
import { toReactFlowGraph } from "./graph/toReactFlow.ts";
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
import type { RuntimeGraph } from "./graph/runtimeTypes.ts";

export default function App() {
  const [selectedSource, setSelectedSource] = useState(defaultGraphSource);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [inputsText, setInputsText] = useState("{}");
  const [inputsError, setInputsError] = useState<string | null>(null);
  const [traceEnabled, setTraceEnabled] = useState(false);
  const [editableGraph, setEditableGraph] = useState<RuntimeGraph | null>(null);
  const [validationIssues, setValidationIssues] = useState<
    InspectGraphValidationIssue[]
  >([]);
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
    forgetNodes,
    isCurrentSource,
    markGraphExecutionRunning,
    markNodesStale,
    markNodeExecutionRunning,
    resetUnfinishedRunStatuses,
    startRunAbortController,
    storeExecutionRequestErrorForNode,
    storeExecutionResponseForNodeIds,
    storeGraphExecutionRequestError,
    storeGraphExecutionResponse,
  } = useExecutionSession(selectedSourceValue);

  useEffect(() => {
    if (!inspectedGraphQuery.isSuccess) {
      return;
    }

    const flowGraph = toReactFlowGraph(inspectedGraphQuery.data.graph);
    setEditableGraph({
      ...inspectedGraphQuery.data.graph,
      nodes: inspectedGraphQuery.data.graph.nodes.map((node) => ({
        ...node,
        position: flowGraph.nodes.find((flowNode) => flowNode.id === node.id)
          ?.position,
      })),
    });
    setValidationIssues([]);
  }, [inspectedGraphQuery.data, inspectedGraphQuery.isSuccess]);

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
    if (!editableGraph) {
      return null;
    }

    const details = getGraphNodeDetails(editableGraph);
    const sourceNodeIds = details
      .filter((detail) => detail.isSourceNode)
      .map((detail) => detail.id);
    const sinkNodeIds = details
      .filter((detail) => detail.isSinkNode)
      .map((detail) => detail.id);
    const isolatedNodeIds = editableGraph.nodes.length > 1
      ? details
        .filter((detail) => detail.isSourceNode && detail.isSinkNode)
        .map((detail) => detail.id)
      : [];

    return {
      nodeCount: editableGraph.nodes.length,
      edgeCount: editableGraph.edges.length,
      sourceNodeIds,
      sinkNodeIds,
      isolatedNodeIds,
      sinkOutputs: sinkNodeIds.map((nodeId) => {
        const node = editableGraph.nodes.find((item) => item.id === nodeId);

        return {
          nodeId,
          outputs: node?.outputs ?? [],
        };
      }),
    };
  }, [editableGraph]);
  const selectedNodeDetails = useMemo<NodeInspectorSelection | null>(() => {
    if (!editableGraph || selectedNodeId === null) {
      return null;
    }

    const node = editableGraph.nodes.find((item) => item.id === selectedNodeId);

    if (!node) {
      return null;
    }

    const detail = getGraphNodeDetails(editableGraph).find((item) =>
      item.id === selectedNodeId
    );
    const badges: NodeInspectorBadge[] = [];
    const canShowGraphPositionBadge = editableGraph.nodes.length > 1;

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
  }, [editableGraph, selectedNodeId]);

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

  const handleAddNode = useCallback((position: { x: number; y: number }) => {
    setEditableGraph((current) => {
      if (!current) return current;
      const nodeId = createNextNodeId(current);

      return {
        ...current,
        nodes: [
          ...current.nodes,
          {
            id: nodeId,
            code: "# New Python Node",
            outputs: [],
            position,
          },
        ],
      };
    });
  }, []);

  const handleAddChildNode = useCallback((parentNodeId: string) => {
    setEditableGraph((current) => {
      if (!current) return current;
      const parentNode = current.nodes.find((node) => node.id === parentNodeId);
      if (!parentNode) return current;

      const nodeId = createNextNodeId(current);
      const position = {
        x: (parentNode.position?.x ?? 0) + 0,
        y: (parentNode.position?.y ?? 0) + 280,
      };

      markNodesStale([nodeId]);
      return {
        ...current,
        nodes: [
          ...current.nodes,
          {
            id: nodeId,
            code: "# New Python Node",
            outputs: [],
            position,
          },
        ],
        edges: [
          ...current.edges,
          { fromNode: parentNodeId, toNode: nodeId },
        ],
      };
    });
  }, [markNodesStale]);

  const handleCodeChange = useCallback((nodeId: string, code: string) => {
    setEditableGraph((current) => {
      if (!current) return current;
      const node = current.nodes.find((item) => item.id === nodeId);
      if (!node || node.code === code) return current;

      markNodesStale(getNodeAndDescendants(current, nodeId));
      return {
        ...current,
        nodes: current.nodes.map((item) =>
          item.id === nodeId ? { ...item, code } : item
        ),
      };
    });
  }, [markNodesStale]);

  const handleOutputsChange = useCallback((
    nodeId: string,
    outputsText: string,
  ) => {
    const outputs = outputsText
      .split(/\r?\n/)
      .map((output) => output.trim())
      .filter((output) => output.length > 0);

    setEditableGraph((current) => {
      if (!current) return current;
      const node = current.nodes.find((item) => item.id === nodeId);
      if (!node || areStringArraysEqual(node.outputs, outputs)) return current;

      markNodesStale(getNodeAndDescendants(current, nodeId));
      return {
        ...current,
        nodes: current.nodes.map((item) =>
          item.id === nodeId ? { ...item, outputs } : item
        ),
      };
    });
  }, [markNodesStale]);

  const handleConnectNodes = useCallback((fromNode: string, toNode: string) => {
    setEditableGraph((current) => {
      if (!current) return current;
      if (
        current.edges.some((edge) =>
          edge.fromNode === fromNode && edge.toNode === toNode
        )
      ) {
        return current;
      }

      markNodesStale(getNodeAndDescendants(current, toNode));
      return {
        ...current,
        edges: [...current.edges, { fromNode, toNode }],
      };
    });
  }, [markNodesStale]);

  const handleDeleteEdges = useCallback((edgeIds: string[]) => {
    setEditableGraph((current) => {
      if (!current) return current;
      const edgeIdSet = new Set(edgeIds);
      const removedEdges = current.edges.filter((edge) =>
        edgeIdSet.has(getEdgeId(edge))
      );
      if (removedEdges.length === 0) return current;

      for (const edge of removedEdges) {
        markNodesStale(getNodeAndDescendants(current, edge.toNode));
      }

      return {
        ...current,
        edges: current.edges.filter((edge) => !edgeIdSet.has(getEdgeId(edge))),
      };
    });
  }, [markNodesStale]);

  const handleDeleteNode = useCallback((nodeId: string) => {
    setEditableGraph((current) => {
      if (!current) return current;
      if (!current.nodes.some((node) => node.id === nodeId)) return current;

      const descendants = getDescendants(current, nodeId);
      markNodesStale(descendants);
      forgetNodes([nodeId]);
      if (selectedNodeId === nodeId) {
        setSelectedNodeId(null);
      }

      return {
        ...current,
        nodes: current.nodes.filter((node) => node.id !== nodeId),
        edges: current.edges.filter((edge) =>
          edge.fromNode !== nodeId && edge.toNode !== nodeId
        ),
      };
    });
  }, [forgetNodes, markNodesStale, selectedNodeId]);

  const handleNodePositionChange = useCallback((
    nodeId: string,
    position: { x: number; y: number },
  ) => {
    setEditableGraph((current) => {
      if (!current) return current;

      return {
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId ? { ...node, position } : node
        ),
      };
    });
  }, []);

  async function validateGraphForExecution(): Promise<boolean> {
    if (!editableGraph) {
      return false;
    }

    const result = await inspectGraphText(JSON.stringify(editableGraph));
    if (!result.ok) {
      setValidationIssues(
        result.error.issues ?? [{
          kind: result.error.kind,
          message: result.error.message,
        }],
      );
      return false;
    }

    setValidationIssues([]);
    return true;
  }

  async function handleRunNode(nodeId: string) {
    if (!editableGraph || !(await validateGraphForExecution())) {
      return;
    }

    const inputs = parseRunInputs();
    if (inputs === null) {
      return;
    }

    markNodeExecutionRunning(nodeId, "run_node");
    const abortController = startRunAbortController();
    runNodeMutation.mutate({
      graph: editableGraph,
      nodeId,
      inputs,
      trace: traceEnabled,
      onEvent: (event) => applyExecutionStreamEvent(event, selectedSourceValue),
      signal: abortController.signal,
      abortController,
      sourceValue: selectedSourceValue,
    });
  }

  async function handleRunToNode(nodeId: string) {
    if (!editableGraph || !(await validateGraphForExecution())) {
      return;
    }

    const inputs = parseRunInputs();
    if (inputs === null) {
      return;
    }

    markNodeExecutionRunning(nodeId, "run_to_node");
    const abortController = startRunAbortController();
    runToNodeMutation.mutate({
      graph: editableGraph,
      nodeId,
      inputs,
      trace: traceEnabled,
      onEvent: (event) => applyExecutionStreamEvent(event, selectedSourceValue),
      signal: abortController.signal,
      abortController,
      sourceValue: selectedSourceValue,
    });
  }

  async function handleRunGraph() {
    if (!editableGraph || !(await validateGraphForExecution())) {
      return;
    }

    const inputs = parseRunInputs();
    if (inputs === null) {
      return;
    }

    markGraphExecutionRunning();
    const abortController = startRunAbortController();
    runGraphMutation.mutate({
      graph: editableGraph,
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
            Editable canvas
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
        {inspectedGraphQuery.isSuccess && editableGraph &&
          graphInspectorDetails && (
          <div className="flex h-full min-h-0">
            <div className="min-h-0 min-w-0 flex-1">
              <Canvas
                key={selectedSourceValue}
                graph={editableGraph}
                selectedNodeId={selectedNodeId}
                nodeRunStatuses={nodeRunStatuses}
                onAddNode={handleAddNode}
                onAddChildNode={handleAddChildNode}
                onCodeChange={handleCodeChange}
                onConnectNodes={handleConnectNodes}
                onDeleteEdges={handleDeleteEdges}
                onDeleteNode={handleDeleteNode}
                onNodePositionChange={handleNodePositionChange}
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
              onOutputsChange={handleOutputsChange}
              onTraceEnabledChange={setTraceEnabled}
              onRunNode={handleRunNode}
              onRunToNode={handleRunToNode}
              onRunGraph={handleRunGraph}
              onSelectionClear={() => setSelectedNodeId(null)}
              validationIssues={validationIssues}
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

function createNextNodeId(graph: RuntimeGraph): string {
  const existingIds = new Set(graph.nodes.map((node) => node.id));
  let index = graph.nodes.length + 1;

  while (existingIds.has(`node_${index}`)) {
    index += 1;
  }

  return `node_${index}`;
}

function getEdgeId(edge: { fromNode: string; toNode: string }): string {
  return `${edge.fromNode}->${edge.toNode}`;
}

function getNodeAndDescendants(graph: RuntimeGraph, nodeId: string): string[] {
  return [nodeId, ...getDescendants(graph, nodeId)];
}

function getDescendants(graph: RuntimeGraph, nodeId: string): string[] {
  const downstreamByNode = new Map<string, string[]>();

  for (const edge of graph.edges) {
    const downstream = downstreamByNode.get(edge.fromNode) ?? [];
    downstream.push(edge.toNode);
    downstreamByNode.set(edge.fromNode, downstream);
  }

  const descendants: string[] = [];
  const visited = new Set<string>([nodeId]);
  const queue = [...(downstreamByNode.get(nodeId) ?? [])];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }

    visited.add(current);
    descendants.push(current);
    queue.push(...(downstreamByNode.get(current) ?? []));
  }

  return descendants;
}

function getGraphNodeDetails(graph: RuntimeGraph) {
  const upstreamByNode = new Map<string, string[]>(
    graph.nodes.map((node) => [node.id, []]),
  );
  const downstreamByNode = new Map<string, string[]>(
    graph.nodes.map((node) => [node.id, []]),
  );

  for (const edge of graph.edges) {
    upstreamByNode.get(edge.toNode)?.push(edge.fromNode);
    downstreamByNode.get(edge.fromNode)?.push(edge.toNode);
  }

  return graph.nodes.map((node) => {
    const upstreamDependencies = upstreamByNode.get(node.id) ?? [];
    const downstreamDependencies = downstreamByNode.get(node.id) ?? [];

    return {
      id: node.id,
      outputs: node.outputs,
      upstreamDependencies,
      downstreamDependencies,
      isSourceNode: upstreamDependencies.length === 0,
      isSinkNode: downstreamDependencies.length === 0,
    };
  });
}

function areStringArraysEqual(first: string[], second: string[]): boolean {
  if (first.length !== second.length) {
    return false;
  }

  return first.every((value, index) => value === second[index]);
}
