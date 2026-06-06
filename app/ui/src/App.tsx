import { useMutation, useQuery } from "@tanstack/react-query";
import type { SyntaxNode } from "@lezer/common";
import { parser as pythonParser } from "@lezer/python";
import { Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  inspectGraphText,
  type InspectGraphValidationIssue,
} from "./api/inspectGraph.ts";
import {
  DocumentApiRequestError,
  loadDocument,
  saveDocument,
} from "./api/documents.ts";
import { loadPythonRuntime } from "./api/runtime.ts";
import { Canvas } from "./components/Canvas.tsx";
import {
  type ExecutionDisplayState,
  type GraphInspectorModel,
  InspectorPanel,
  type NodeInspectorBadge,
  type NodeInspectorSelection,
} from "./components/InspectorPanel.tsx";
import { toReactFlowGraph } from "./graph/toReactFlow.ts";
import type { NodeCanvasPreview } from "./graph/toReactFlow.ts";
import {
  type NodebookDocumentV1,
  toRuntimeGraph,
} from "./graph/documentTypes.ts";
import { createSimpleLayout } from "./graph/layout.ts";
import {
  runGraphMutationOptions,
  runNodeMutationOptions,
  runToNodeMutationOptions,
} from "./query/executionMutations.ts";
import { useExecutionSession } from "./query/useExecutionSession.ts";
import type { RuntimeGraph, RuntimeNode } from "./graph/runtimeTypes.ts";
import type { NodeRunResult } from "../../../types.ts";

const documentSourceValue = "document:active";

export default function App() {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [traceEnabled, setTraceEnabled] = useState(false);
  const [editableDocument, setEditableDocument] = useState<
    NodebookDocumentV1 | null
  >(null);
  const [validationIssues, setValidationIssues] = useState<
    InspectGraphValidationIssue[]
  >([]);
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [documentPath, setDocumentPath] = useState("Active document");
  const documentQuery = useQuery({
    queryKey: ["nodebook-document", "active"],
    queryFn: loadDocument,
  });
  const pythonRuntimeQuery = useQuery({
    queryKey: ["runtime", "python"],
    queryFn: loadPythonRuntime,
  });
  const {
    executionStateByNodeId,
    graphExecutionState,
    nodeRunStatuses,
    applyExecutionStreamEvent,
    clearActiveRun,
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
  } = useExecutionSession(documentSourceValue);
  const isGraphRunning = graphExecutionState?.status === "running";

  useEffect(() => {
    if (!documentQuery.isSuccess) {
      return;
    }

    const graph = documentQuery.data.document;
    setDocumentPath(documentQuery.data.path);
    const flowGraph = toReactFlowGraph(graph);
    setEditableDocument({
      ...graph,
      nodes: graph.nodes.map((node) => ({
        ...node,
        position: flowGraph.nodes.find((flowNode) => flowNode.id === node.id)
          ?.position,
      })),
    });
    setValidationIssues([]);
    setSaveStatus("idle");
    setSaveError(null);
  }, [documentQuery.data, documentQuery.isSuccess]);

  const saveDocumentMutation = useMutation({
    mutationFn: saveDocument,
    onMutate: () => {
      setSaveStatus("saving");
      setSaveError(null);
    },
    onSuccess: (result) => {
      setDocumentPath(result.path);
      setEditableDocument(result.document);
      setSaveStatus("saved");
    },
    onError: (error) => {
      setSaveStatus("error");
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });

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
        response.ok
          ? variables.graph.nodes.map((node) => node.id)
          : response.executedNodeIds.filter((nodeId) =>
            response.resultsByNode[nodeId]?.ok
          ),
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
  const documentLoadIssues = documentQuery.error instanceof
      DocumentApiRequestError
    ? documentQuery.error.issues
    : [];
  const editableGraph = useMemo<RuntimeGraph | null>(
    () => editableDocument ? toRuntimeGraph(editableDocument) : null,
    [editableDocument],
  );
  const isReadOnlyDocument = editableDocument?.readOnly ?? false;
  const canEditStructure = !isReadOnlyDocument;
  const canEditOutputs = !isReadOnlyDocument;
  const nodePreviews = useMemo(
    () => getNodeCanvasPreviews(executionStateByNodeId),
    [executionStateByNodeId],
  );
  const nodeOutputOptions = useMemo(
    () => getNodeOutputOptionsById(editableGraph),
    [editableGraph],
  );
  const graphNodeDetails = useMemo(
    () => editableGraph ? getGraphNodeDetails(editableGraph) : [],
    [editableGraph],
  );
  const graphInspectorDetails = useMemo<GraphInspectorModel | null>(() => {
    if (!editableGraph) {
      return null;
    }

    const sourceNodeIds = graphNodeDetails
      .filter((detail) => detail.isSourceNode)
      .map((detail) => detail.id);
    const sinkNodeIds = graphNodeDetails
      .filter((detail) => detail.isSinkNode)
      .map((detail) => detail.id);
    const isolatedNodeIds = editableGraph.nodes.length > 1
      ? graphNodeDetails
        .filter((detail) => detail.isSourceNode && detail.isSinkNode)
        .map((detail) => detail.id)
      : [];

    return {
      nodeCount: editableGraph.nodes.length,
      edgeCount: editableGraph.edges.length,
      globalsCode: editableDocument?.globalsCode ?? "",
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
  }, [editableDocument?.globalsCode, editableGraph, graphNodeDetails]);
  const selectedNodeDetails = useMemo<NodeInspectorSelection | null>(() => {
    if (!editableGraph || selectedNodeId === null) {
      return null;
    }

    const node = editableGraph.nodes.find((item) => item.id === selectedNodeId);

    if (!node) {
      return null;
    }

    const detail = graphNodeDetails.find((item) => item.id === selectedNodeId);
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
      code: node.displayCode ?? node.code,
      editable: node.editable ?? true,
      outputs: node.outputs,
      inferredOutputs: inferAssignableOutputs(node.displayCode ?? node.code),
      inputNames: node.parameters ?? [],
      upstreamDependencies: detail?.upstreamDependencies ?? [],
      downstreamDependencies: detail?.downstreamDependencies ?? [],
      badges,
    };
  }, [editableGraph, graphNodeDetails, selectedNodeId]);

  const markDocumentEdited = useCallback(() => {
    setSaveStatus("idle");
    setSaveError(null);
  }, []);

  const handleAddNode = useCallback((position: { x: number; y: number }) => {
    setEditableDocument((current) => {
      if (!current) return current;
      const node = createNewPythonNode(current, position);

      markDocumentEdited();
      return {
        ...current,
        nodes: [...current.nodes, node],
      };
    });
  }, [markDocumentEdited]);

  const handleAddChildNode = useCallback((parentNodeId: string) => {
    setEditableDocument((current) => {
      if (!current) return current;
      const parentNode = current.nodes.find((node) => node.id === parentNodeId);
      if (!parentNode) return current;

      const position = {
        x: (parentNode.position?.x ?? 0) + 0,
        y: (parentNode.position?.y ?? 0) + 280,
      };
      const node = createNewPythonNode(current, position);

      markDocumentEdited();
      markNodesStale([node.id]);
      return {
        ...current,
        nodes: [...current.nodes, node],
        edges: [
          ...current.edges,
          { fromNode: parentNodeId, toNode: node.id },
        ],
      };
    });
  }, [markDocumentEdited, markNodesStale]);

  const handleCodeChange = useCallback((nodeId: string, code: string) => {
    setEditableDocument((current) => {
      if (!current) return current;
      const node = current.nodes.find((item) => item.id === nodeId);
      if (!node || node.code === code) return current;
      const previousInferredOutputs = new Set(
        inferAssignableOutputs(node.displayCode ?? node.code),
      );
      const newlyInferredOutputs = inferAssignableOutputs(code).filter((name) =>
        !previousInferredOutputs.has(name) && !node.outputs.includes(name)
      );
      const outputs = newlyInferredOutputs.length === 0
        ? node.outputs
        : [...node.outputs, ...newlyInferredOutputs];

      markDocumentEdited();
      markNodesStale(getNodeAndDescendants(toRuntimeGraph(current), nodeId));
      return {
        ...current,
        nodes: current.nodes.map((item) =>
          item.id === nodeId
            ? { ...item, code, outputs, runtimeCode: undefined }
            : item
        ),
      };
    });
  }, [markDocumentEdited, markNodesStale]);

  const handleOutputsChange = useCallback((
    nodeId: string,
    outputs: string[],
  ) => {
    setEditableDocument((current) => {
      if (!current) return current;
      const node = current.nodes.find((item) => item.id === nodeId);
      if (!node || areStringArraysEqual(node.outputs, outputs)) return current;

      markDocumentEdited();
      markNodesStale(getNodeAndDescendants(toRuntimeGraph(current), nodeId));
      return {
        ...current,
        nodes: current.nodes.map((item) =>
          item.id === nodeId
            ? { ...item, outputs, runtimeCode: undefined }
            : item
        ),
      };
    });
  }, [markDocumentEdited, markNodesStale]);

  const handleConnectNodes = useCallback((fromNode: string, toNode: string) => {
    setEditableDocument((current) => {
      if (!current) return current;
      if (
        current.edges.some((edge) =>
          edge.fromNode === fromNode && edge.toNode === toNode
        )
      ) {
        return current;
      }

      markDocumentEdited();
      markNodesStale(getNodeAndDescendants(toRuntimeGraph(current), toNode));
      return {
        ...current,
        edges: [...current.edges, { fromNode, toNode }],
      };
    });
  }, [markDocumentEdited, markNodesStale]);

  const handleDeleteEdges = useCallback((edgeIds: string[]) => {
    setEditableDocument((current) => {
      if (!current) return current;
      const edgeIdSet = new Set(edgeIds);
      const removedEdges = current.edges.filter((edge) =>
        edgeIdSet.has(getEdgeId(edge))
      );
      if (removedEdges.length === 0) return current;

      markDocumentEdited();
      for (const edge of removedEdges) {
        markNodesStale(
          getNodeAndDescendants(toRuntimeGraph(current), edge.toNode),
        );
      }

      return {
        ...current,
        edges: current.edges.filter((edge) => !edgeIdSet.has(getEdgeId(edge))),
      };
    });
  }, [markDocumentEdited, markNodesStale]);

  const handleDeleteNode = useCallback((nodeId: string) => {
    setEditableDocument((current) => {
      if (!current) return current;
      if (!current.nodes.some((node) => node.id === nodeId)) return current;

      const descendants = getDescendants(toRuntimeGraph(current), nodeId);
      markDocumentEdited();
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
  }, [forgetNodes, markDocumentEdited, markNodesStale, selectedNodeId]);

  const handleNodePositionChange = useCallback((
    nodeId: string,
    position: { x: number; y: number },
  ) => {
    setEditableDocument((current) => {
      if (!current) return current;
      const node = current.nodes.find((item) => item.id === nodeId);
      if (!node || arePositionsEqual(node.position, position)) return current;

      markDocumentEdited();
      return {
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId ? { ...node, position } : node
        ),
      };
    });
  }, [markDocumentEdited]);

  const handleAutoLayout = useCallback(() => {
    setEditableDocument((current) => {
      if (!current) return current;
      const positions = createSimpleLayout(toRuntimeGraph(current));
      const hasPositionChange = current.nodes.some((node) => {
        const position = positions[node.id];
        return position && !arePositionsEqual(node.position, position);
      });

      if (!hasPositionChange) return current;

      markDocumentEdited();
      return {
        ...current,
        nodes: current.nodes.map((node) => ({
          ...node,
          position: positions[node.id] ?? node.position,
        })),
      };
    });
  }, [markDocumentEdited]);

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

  function handleSaveDocument() {
    if (!editableDocument || saveDocumentMutation.isPending) {
      return;
    }

    saveDocumentMutation.mutate(editableDocument);
  }

  async function handleRunNode(nodeId: string) {
    if (!editableGraph || !(await validateGraphForExecution())) {
      return;
    }

    markNodeExecutionRunning(nodeId, "run_node");
    const abortController = startRunAbortController();
    runNodeMutation.mutate({
      graph: editableGraph,
      nodeId,
      inputs: {},
      trace: traceEnabled,
      onEvent: (event) => applyExecutionStreamEvent(event, documentSourceValue),
      signal: abortController.signal,
      abortController,
      sourceValue: documentSourceValue,
    });
  }

  async function handleRunToNode(nodeId: string) {
    if (!editableGraph || !(await validateGraphForExecution())) {
      return;
    }

    markNodeExecutionRunning(nodeId, "run_to_node");
    const abortController = startRunAbortController();
    runToNodeMutation.mutate({
      graph: editableGraph,
      nodeId,
      inputs: {},
      trace: traceEnabled,
      onEvent: (event) => applyExecutionStreamEvent(event, documentSourceValue),
      signal: abortController.signal,
      abortController,
      sourceValue: documentSourceValue,
    });
  }

  async function handleRunGraph() {
    if (!editableGraph || !(await validateGraphForExecution())) {
      return;
    }

    markGraphExecutionRunning();
    const abortController = startRunAbortController();
    runGraphMutation.mutate({
      graph: editableGraph,
      inputs: {},
      trace: traceEnabled,
      onEvent: (event) => applyExecutionStreamEvent(event, documentSourceValue),
      signal: abortController.signal,
      abortController,
      sourceValue: documentSourceValue,
    });
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-zinc-100 text-zinc-950">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 bg-white px-5 py-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            {isReadOnlyDocument ? "Read-only canvas" : "Editable canvas"}
          </p>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">Nodebook</h1>
            <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
              Alpha
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-zinc-600">{documentPath}</span>
          <PythonRuntimeBadge
            isLoading={pythonRuntimeQuery.isLoading}
            error={pythonRuntimeQuery.error}
            python={pythonRuntimeQuery.data?.python ?? null}
          />
          {saveStatus === "saved" && (
            <span className="text-xs font-medium text-emerald-700">Saved</span>
          )}
          {saveStatus === "error" && saveError && (
            <span className="max-w-72 truncate text-xs font-medium text-red-700">
              {saveError}
            </span>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm disabled:cursor-not-allowed disabled:bg-zinc-400"
            disabled={!editableDocument || saveDocumentMutation.isPending}
            onClick={handleSaveDocument}
          >
            {!isReadOnlyDocument && (
              <Save aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
            )}
            {isReadOnlyDocument
              ? "Read-only"
              : saveDocumentMutation.isPending
              ? "Saving..."
              : "Save"}
          </button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden">
        {documentQuery.isLoading && (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Loading {documentPath}...
          </div>
        )}
        {documentQuery.isError && (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-md rounded-lg border border-red-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-red-700">
                Could not load document
              </h2>
              <p className="mt-2 text-sm text-zinc-600">
                {documentPath}
              </p>
              <p className="mt-2 text-sm text-zinc-600">
                {documentQuery.error.message}
              </p>
              {documentLoadIssues.length > 0 && (
                <ul className="mt-3 space-y-2 text-sm text-zinc-700">
                  {documentLoadIssues.map((issue, index) => (
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
                {documentLoadIssues.length > 0
                  ? "These issues were returned by the document decoder."
                  : "Make sure the Deno API is running before loading the Vite UI."}
              </p>
            </div>
          </div>
        )}
        {documentQuery.isSuccess && editableGraph &&
          graphInspectorDetails && (
          <div className="flex h-full min-h-0">
            <div className="min-h-0 min-w-0 flex-1">
              <Canvas
                key={documentSourceValue}
                graph={editableGraph}
                selectedNodeId={selectedNodeId}
                nodeRunStatuses={nodeRunStatuses}
                nodePreviews={nodePreviews}
                nodeOutputOptions={nodeOutputOptions}
                onAddNode={canEditStructure ? handleAddNode : undefined}
                onAutoLayout={isReadOnlyDocument ? undefined : handleAutoLayout}
                onAddChildNode={canEditStructure
                  ? handleAddChildNode
                  : undefined}
                onCodeChange={isReadOnlyDocument ? undefined : handleCodeChange}
                onConnectNodes={undefined}
                onDeleteEdges={undefined}
                onDeleteNode={canEditStructure ? handleDeleteNode : undefined}
                onNodePositionChange={handleNodePositionChange}
                onNodeSelect={setSelectedNodeId}
                onOutputsChange={handleOutputsChange}
                onRunToNode={handleRunToNode}
                outputsReadOnly={!canEditOutputs}
                runToNodeDisabled={isGraphRunning}
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
              traceEnabled={traceEnabled}
              readOnly={!canEditOutputs}
              onNodeSelect={setSelectedNodeId}
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

function PythonRuntimeBadge({
  python,
  isLoading,
  error,
}: {
  python: Awaited<ReturnType<typeof loadPythonRuntime>>["python"] | null;
  isLoading: boolean;
  error: Error | null;
}) {
  if (isLoading) {
    return (
      <div className="hidden max-w-xs rounded border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-500 md:block">
        Python: checking...
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="hidden max-w-xs rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 md:block"
        title={error.message}
      >
        Python: unavailable
      </div>
    );
  }

  if (!python) return null;

  const label = `${python.implementation} ${python.version}`;

  return (
    <div
      className="hidden min-w-0 max-w-sm rounded border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-600 md:block"
      title={`${label}\n${python.executable}`}
    >
      <span className="font-medium text-zinc-700">Python</span>{" "}
      <span>{python.version}</span>
      <span className="ml-2 inline-block max-w-[18rem] truncate align-bottom text-zinc-400">
        {python.executable}
      </span>
    </div>
  );
}


function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function getNodeCanvasPreviews(
  executionStateByNodeId: Record<string, ExecutionDisplayState>,
): Record<string, NodeCanvasPreview> {
  return Object.fromEntries(
    Object.entries(executionStateByNodeId).flatMap(([nodeId, state]) => {
      const preview = getNodeCanvasPreview(nodeId, state);
      return preview ? [[nodeId, preview]] : [];
    }),
  );
}

function getNodeCanvasPreview(
  nodeId: string,
  state: ExecutionDisplayState,
): NodeCanvasPreview | null {
  if (state.status === "completed_node" || state.status === "failed_node") {
    return resultToCanvasPreview(state.result);
  }

  if (state.status === "completed") {
    const result = state.response.resultsByNode[nodeId];
    if (result) {
      return resultToCanvasPreview(result);
    }

    if (state.response.error?.nodeId === nodeId) {
      return {
        ok: false,
        outputs: [],
        outputEvents: [],
        stdout: "",
        stderr: "",
        error: state.response.error.message,
      };
    }
  }

  if (state.status === "request_error") {
    return {
      ok: false,
      outputs: [],
      outputEvents: [],
      stdout: "",
      stderr: "",
      error: state.message,
    };
  }

  return null;
}

function resultToCanvasPreview(result: NodeRunResult): NodeCanvasPreview | null {
  const preview: NodeCanvasPreview = {
    ok: result.ok,
    outputs: result.ok
      ? Object.entries(result.outputs).map(([name, output]) => ({
        name: output.name || name,
        type: output.type,
        table: output.table,
      }))
      : [],
    outputEvents: result.outputEvents ?? [],
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error ?? null,
  };

  if (
    preview.outputs.length === 0 &&
    preview.outputEvents.length === 0 &&
    preview.stdout.length === 0 &&
    preview.stderr.length === 0 &&
    preview.error === null
  ) {
    return null;
  }

  return preview;
}

function createNewPythonNode(
  graph: RuntimeGraph,
  position: { x: number; y: number },
): RuntimeNode {
  return {
    id: createNextNodeId(graph),
    functionName: createNextFunctionName(graph),
    parameters: [],
    code: "pass",
    outputs: [],
    customReturn: false,
    editable: true,
    position,
  };
}

function createNextNodeId(graph: RuntimeGraph): string {
  const existingIds = new Set(graph.nodes.map((node) => node.id));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = `n_${createShortId()}`;
    if (!existingIds.has(id)) {
      return id;
    }
  }

  let index = graph.nodes.length + 1;
  while (existingIds.has(`n_${index}`)) {
    index += 1;
  }

  return `n_${index}`;
}

function createShortId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 10);
}

function createNextFunctionName(graph: RuntimeGraph): string {
  const existingNames = new Set(
    graph.nodes.flatMap((node) => node.functionName ? [node.functionName] : []),
  );
  let index = graph.nodes.length + 1;

  while (existingNames.has(`new_node_${index}`)) {
    index += 1;
  }

  return `new_node_${index}`;
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

function getNodeOutputOptionsById(
  graph: RuntimeGraph | null,
): Record<
  string,
  Array<{ name: string; source: "input" | "assigned" | "manual" }>
> {
  if (!graph) return {};

  return Object.fromEntries(
    graph.nodes.map((node) => [
      node.id,
      getNodeOutputOptions(
        node.parameters ?? [],
        inferAssignableOutputs(node.displayCode ?? node.code),
        node.outputs,
      ),
    ]),
  );
}

function getNodeOutputOptions(
  inputNames: string[],
  inferredOutputs: string[],
  declaredOutputs: string[],
): Array<{ name: string; source: "input" | "assigned" | "manual" }> {
  const options: Array<
    { name: string; source: "input" | "assigned" | "manual" }
  > = [];
  const seen = new Set<string>();

  for (const name of inputNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    options.push({ name, source: "input" });
  }

  for (const name of inferredOutputs) {
    if (seen.has(name)) continue;
    seen.add(name);
    options.push({ name, source: "assigned" });
  }

  for (const name of declaredOutputs) {
    if (seen.has(name)) continue;
    seen.add(name);
    options.push({ name, source: "manual" });
  }

  return options;
}

function areStringArraysEqual(first: string[], second: string[]): boolean {
  if (first.length !== second.length) {
    return false;
  }

  return first.every((value, index) => value === second[index]);
}

function inferAssignableOutputs(code: string): string[] {
  const tree = pythonParser.parse(code);
  const outputs: string[] = [];
  const seen = new Set<string>();

  const addOutput = (name: string) => {
    if (!seen.has(name) && isValidPythonIdentifier(name)) {
      seen.add(name);
      outputs.push(name);
    }
  };

  const visit = (node: SyntaxNode) => {
    if (node.name === "AssignStatement") {
      collectAssignmentTargets(node, code, addOutput);
      return;
    }

    if (node.name === "FunctionDefinition" || node.name === "ClassDefinition") {
      return;
    }

    for (let child = node.firstChild; child; child = child.nextSibling) {
      visit(child);
    }
  };

  visit(tree.topNode);

  return outputs;
}

function collectAssignmentTargets(
  node: SyntaxNode,
  code: string,
  addOutput: (name: string) => void,
) {
  let segmentStart: SyntaxNode | null = node.firstChild;

  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== "AssignOp") continue;

    for (
      let target = segmentStart;
      target && target.from < child.from;
      target = target.nextSibling
    ) {
      collectBindingNames(target, code, addOutput);
    }

    segmentStart = child.nextSibling;
  }
}

function collectBindingNames(
  node: SyntaxNode,
  code: string,
  addOutput: (name: string) => void,
) {
  if (node.name === "VariableName") {
    addOutput(code.slice(node.from, node.to));
    return;
  }

  if (node.name === "TupleExpression" || node.name === "ArrayExpression") {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      collectBindingNames(child, code, addOutput);
    }
  }
}

function isValidPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function arePositionsEqual(
  first: { x: number; y: number } | undefined,
  second: { x: number; y: number },
): boolean {
  if (!first) {
    return false;
  }

  const epsilon = 0.01;
  return Math.abs(first.x - second.x) < epsilon &&
    Math.abs(first.y - second.y) < epsilon;
}
