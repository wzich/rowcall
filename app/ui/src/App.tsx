import { useMutation, useQuery } from "@tanstack/react-query";
import type { SyntaxNode } from "@lezer/common";
import { parser as pythonParser } from "@lezer/python";
import { Moon, Save, Sun } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  inspectGraph,
  type InspectGraphValidationIssue,
} from "./api/inspectGraph.ts";
import {
  applyDocumentOperations,
  DocumentApiRequestError,
  type DocumentOperation,
  loadDocument,
} from "./api/documents.ts";
import { loadPythonRuntime } from "./api/runtime.ts";
import { Canvas } from "./components/Canvas.tsx";
import {
  coalesceDocumentOperations,
  hasCustomManagedDownstream,
} from "./documentOperations.ts";
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
  functionNameFromDisplayName,
  isValidPythonIdentifier,
  prettifyFunctionName,
} from "./graph/nodeNames.ts";
import {
  runGraphMutationOptions,
  runNodeMutationOptions,
  runToNodeMutationOptions,
} from "./query/executionMutations.ts";
import { useExecutionSession } from "./query/useExecutionSession.ts";
import type { RuntimeGraph, RuntimeNode } from "./graph/runtimeTypes.ts";
import type { NodeRunResult, ValuePreview } from "../../../types.ts";

const generatedFunctionNamePattern = /^new_step_(\d+)$/u;
const documentCanvasKey = "document:active";
const themeStorageKey = "nodebook:theme";

export type ThemeMode = "light" | "dark";

type GeneratedFunctionNameSession = {
  reservedNames: Set<string>;
  nextIndex: number;
};

export type NodeNameChangeResult =
  | { ok: true; functionName: string }
  | { ok: false; message: string };

type SaveErrorMessage = {
  title: string;
  detail: string;
};

function getDocumentSourceValue(
  baseRevision: string,
  editGeneration: number,
): string {
  return `document:${baseRevision}:${editGeneration}`;
}

function getInitialThemeMode(): ThemeMode {
  if (
    typeof globalThis.localStorage === "undefined" ||
    typeof globalThis.matchMedia === "undefined"
  ) {
    return "light";
  }

  const storedTheme = globalThis.localStorage.getItem(themeStorageKey);
  if (storedTheme === "light" || storedTheme === "dark") {
    return storedTheme;
  }

  return globalThis.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialThemeMode);
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
  const [saveError, setSaveError] = useState<SaveErrorMessage | null>(null);
  const [documentPath, setDocumentPath] = useState("Active document");
  const editGenerationRef = useRef(0);
  const editableDocumentRef = useRef<NodebookDocumentV1 | null>(null);
  const baseRevisionRef = useRef("");
  const documentSourceValueRef = useRef(
    getDocumentSourceValue(baseRevisionRef.current, editGenerationRef.current),
  );
  const [documentSourceValue, setDocumentSourceValue] = useState(() =>
    documentSourceValueRef.current
  );
  const pendingOperationsRef = useRef<DocumentOperation[]>([]);
  const flushPromiseRef = useRef<Promise<boolean> | null>(null);
  const generatedFunctionNameSessionRef = useRef<GeneratedFunctionNameSession>({
    reservedNames: new Set(),
    nextIndex: 1,
  });
  const documentQuery = useQuery({
    queryKey: ["nodebook-document", "active"],
    queryFn: loadDocument,
    refetchOnWindowFocus: false,
  });
  const pythonRuntimeQuery = useQuery({
    queryKey: ["runtime", "python"],
    queryFn: loadPythonRuntime,
  });
  useEffect(() => {
    globalThis.localStorage.setItem(themeStorageKey, themeMode);
  }, [themeMode]);
  const syncDocumentSourceValue = useCallback(() => {
    const sourceValue = getDocumentSourceValue(
      baseRevisionRef.current,
      editGenerationRef.current,
    );
    documentSourceValueRef.current = sourceValue;
    setDocumentSourceValue(sourceValue);
    return sourceValue;
  }, []);
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
  } = useExecutionSession(documentSourceValue, {
    getCurrentSourceValue: () => documentSourceValueRef.current,
  });
  const isGraphRunning = graphExecutionState?.status === "running";
  const isSelectedNodeRunning = selectedNodeId
    ? executionStateByNodeId[selectedNodeId]?.status === "running"
    : false;

  useEffect(() => {
    editableDocumentRef.current = editableDocument;
  }, [editableDocument]);

  useEffect(() => {
    if (!documentQuery.isSuccess) {
      return;
    }

    const graph = documentQuery.data.document;
    generatedFunctionNameSessionRef.current =
      createGeneratedFunctionNameSession(graph);
    setDocumentPath(documentQuery.data.path);
    const flowGraph = toReactFlowGraph(graph);
    const nextDocument = {
      ...graph,
      nodes: graph.nodes.map((node) => ({
        ...node,
        position: flowGraph.nodes.find((flowNode) => flowNode.id === node.id)
          ?.position,
      })),
    };
    editableDocumentRef.current = nextDocument;
    setEditableDocument(nextDocument);
    baseRevisionRef.current = graph.revision ?? "";
    pendingOperationsRef.current = [];
    setValidationIssues([]);
    setSaveStatus("idle");
    setSaveError(null);
    editGenerationRef.current = 0;
    syncDocumentSourceValue();
  }, [documentQuery.data, documentQuery.isSuccess, syncDocumentSourceValue]);

  const queueOperation = useCallback((operation: DocumentOperation) => {
    pendingOperationsRef.current = coalesceDocumentOperations([
      ...pendingOperationsRef.current,
      operation,
    ]);
    setSaveStatus("idle");
    setSaveError(null);
  }, []);

  const flushPendingOperations = useCallback(async (): Promise<boolean> => {
    if (flushPromiseRef.current) {
      return await flushPromiseRef.current;
    }
    if (pendingOperationsRef.current.length === 0) {
      return true;
    }
    if (!editableDocumentRef.current) {
      return false;
    }

    const operations = pendingOperationsRef.current;
    const baseRevision = baseRevisionRef.current;
    const clientBatchId = crypto.randomUUID();
    const editGeneration = editGenerationRef.current;

    pendingOperationsRef.current = [];
    setSaveStatus("saving");
    setSaveError(null);

    const promise = applyDocumentOperations(
      baseRevision,
      operations,
      clientBatchId,
    )
      .then((result) => {
        setDocumentPath(result.path);
        baseRevisionRef.current = result.document.revision ?? "";
        syncDocumentSourceValue();
        if (editGeneration === editGenerationRef.current) {
          editableDocumentRef.current = result.document;
          setEditableDocument(result.document);
          setSaveStatus("saved");
        } else if (pendingOperationsRef.current.length > 0) {
          setSaveStatus("idle");
        } else {
          setSaveStatus("saved");
        }
        return pendingOperationsRef.current.length === 0;
      })
      .catch((error) => {
        pendingOperationsRef.current = coalesceDocumentOperations([
          ...operations,
          ...pendingOperationsRef.current,
        ]);
        setSaveStatus("error");
        setSaveError(formatSaveError(error));
        return false;
      })
      .finally(() => {
        flushPromiseRef.current = null;
      });

    flushPromiseRef.current = promise;
    return await promise;
  }, []);

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
  const nodeInputPreviews = useMemo(
    () =>
      editableGraph
        ? getNodeCanvasInputPreviewsById(editableGraph, executionStateByNodeId)
        : {},
    [editableGraph, executionStateByNodeId],
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
      nodeLabelsById: getNodeLabelsById(editableGraph),
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
      displayName: prettifyFunctionName(node.functionName),
      description: node.description ?? "",
      functionName: node.functionName ?? null,
      code: node.displayCode ?? node.code,
      editable: node.editable ?? true,
      outputs: node.outputs,
      inferredOutputs: inferAssignableOutputs(node.displayCode ?? node.code),
      inputNames: node.parameters ?? [],
      inputGroups: getNodeInputGroups(
        editableGraph,
        node.id,
        executionStateByNodeId,
      ),
      outputPreviews: getOutputPreviewsForNode(
        node.id,
        executionStateByNodeId,
      ),
      upstreamDependencies: detail?.upstreamDependencies ?? [],
      downstreamDependencies: detail?.downstreamDependencies ?? [],
      nodeLabelsById: getNodeLabelsById(editableGraph),
      badges,
    };
  }, [editableGraph, executionStateByNodeId, graphNodeDetails, selectedNodeId]);

  const markDocumentEdited = useCallback(() => {
    clearExecutionSession();
    editGenerationRef.current += 1;
    syncDocumentSourceValue();
    setSaveStatus("idle");
    setSaveError(null);
  }, [clearExecutionSession, syncDocumentSourceValue]);

  const commitEditableDocument = useCallback(
    (nextDocument: NodebookDocumentV1) => {
      editableDocumentRef.current = nextDocument;
      setEditableDocument(nextDocument);
    },
    [],
  );

  const handleAddNode = useCallback((position: { x: number; y: number }) => {
    const current = editableDocumentRef.current;
    if (!current) return;
    const nodeId = createNextNodeId(current);
    const functionName = reserveNextFunctionName(
      current,
      generatedFunctionNameSessionRef.current,
    );
    if (hasNodeIdOrFunctionName(current, nodeId, functionName)) {
      return;
    }
    const node = createNewPythonNode(
      nodeId,
      functionName,
      position,
    );
    const nextDocument = {
      ...current,
      nodes: [...current.nodes, node],
    };

    markDocumentEdited();
    queueOperation({ type: "add_node", node: toAddNodeOperationNode(node) });
    commitEditableDocument(nextDocument);
  }, [commitEditableDocument, markDocumentEdited, queueOperation]);

  const handleAddChildNode = useCallback((parentNodeId: string) => {
    const current = editableDocumentRef.current;
    if (!current) return;
    const parentNode = current.nodes.find((node) => node.id === parentNodeId);
    if (!parentNode) return;
    const nodeId = createNextNodeId(current);
    const functionName = reserveNextFunctionName(
      current,
      generatedFunctionNameSessionRef.current,
    );
    if (hasNodeIdOrFunctionName(current, nodeId, functionName)) {
      return;
    }

    const position = {
      ...createChildNodePosition(current, parentNode),
    };
    const node = createNewPythonNode(
      nodeId,
      functionName,
      position,
    );
    const nextDocument = {
      ...current,
      nodes: [...current.nodes, node],
      edges: [
        ...current.edges,
        { fromNode: parentNodeId, toNode: node.id },
      ],
    };

    markDocumentEdited();
    queueOperation({ type: "add_node", node: toAddNodeOperationNode(node) });
    queueOperation({
      type: "add_edge",
      fromNode: parentNodeId,
      toNode: node.id,
    });
    setSelectedNodeId(node.id);
    commitEditableDocument(nextDocument);
  }, [commitEditableDocument, markDocumentEdited, queueOperation]);

  const handleCodeChange = useCallback((nodeId: string, code: string) => {
    const current = editableDocumentRef.current;
    if (!current) return;
    const node = current.nodes.find((item) => item.id === nodeId);
    if (!node || node.code === code) return;
    const staleNodeIds = getNodeAndDescendants(toRuntimeGraph(current), nodeId);
    const nextDocument = {
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === nodeId ? { ...item, code, runtimeCode: undefined } : item
      ),
    };

    markDocumentEdited();
    queueOperation({ type: "update_node_body", nodeId, code });
    markNodesStale(staleNodeIds);
    commitEditableDocument(nextDocument);
  }, [
    commitEditableDocument,
    markDocumentEdited,
    markNodesStale,
    queueOperation,
  ]);

  const handleGlobalsCodeChange = useCallback((globalsCode: string) => {
    const current = editableDocumentRef.current;
    if (!current || (current.globalsCode ?? "") === globalsCode) {
      return;
    }
    const staleNodeIds = current.nodes.map((node) => node.id);
    const nextDocument = {
      ...current,
      globalsCode,
    };

    markDocumentEdited();
    queueOperation({ type: "update_globals", code: globalsCode });
    markNodesStale(staleNodeIds);
    commitEditableDocument(nextDocument);
  }, [
    commitEditableDocument,
    markDocumentEdited,
    markNodesStale,
    queueOperation,
  ]);

  const handleOutputsChange = useCallback((
    nodeId: string,
    outputs: string[],
  ) => {
    const current = editableDocumentRef.current;
    if (!current) return;
    const node = current.nodes.find((item) => item.id === nodeId);
    if (!node || areStringArraysEqual(node.outputs, outputs)) return;
    if (hasCustomManagedDownstream(current, nodeId)) return;
    const staleNodeIds = getNodeAndDescendants(toRuntimeGraph(current), nodeId);
    const nextDocument = {
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === nodeId ? { ...item, outputs, runtimeCode: undefined } : item
      ),
    };

    markDocumentEdited();
    queueOperation({ type: "update_node_outputs", nodeId, outputs });
    markNodesStale(staleNodeIds);
    commitEditableDocument(nextDocument);
  }, [
    commitEditableDocument,
    markDocumentEdited,
    markNodesStale,
    queueOperation,
  ]);

  const handleNodeNameChange = useCallback((
    nodeId: string,
    displayName: string,
  ): NodeNameChangeResult => {
    const current = editableDocumentRef.current;
    if (!current) {
      return { ok: false, message: "The document is not ready yet." };
    }

    const node = current.nodes.find((item) => item.id === nodeId);
    if (!node) {
      return { ok: false, message: "This step no longer exists." };
    }
    if (!node.functionName) {
      return {
        ok: false,
        message: "This step cannot be renamed because it has no Python name.",
      };
    }
    if (node.editable === false) {
      return {
        ok: false,
        message: "This step cannot be renamed because it has custom Python.",
      };
    }

    const functionName = functionNameFromDisplayName(displayName);
    if (!functionName) {
      return { ok: false, message: "Enter a step name." };
    }
    if (!isValidPythonIdentifier(functionName)) {
      return {
        ok: false,
        message: `That would create invalid Python name '${functionName}'.`,
      };
    }

    const conflictingNode = current.nodes.find((item) =>
      item.id !== nodeId && item.functionName === functionName
    );
    if (conflictingNode) {
      return {
        ok: false,
        message: `A step named '${
          prettifyFunctionName(functionName)
        }' already exists.`,
      };
    }

    if (node.functionName === functionName) {
      return { ok: true, functionName };
    }

    const staleNodeIds = getNodeAndDescendants(toRuntimeGraph(current), nodeId);
    const nextDocument = {
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === nodeId
          ? { ...item, functionName, runtimeCode: undefined }
          : item
      ),
    };

    markDocumentEdited();
    queueOperation({ type: "rename_node_function", nodeId, functionName });
    markNodesStale(staleNodeIds);
    commitEditableDocument(nextDocument);

    return { ok: true, functionName };
  }, [
    commitEditableDocument,
    markDocumentEdited,
    markNodesStale,
    queueOperation,
  ]);

  const handleNodeMetadataChange = useCallback((
    nodeId: string,
    metadata: { description?: string },
  ) => {
    const current = editableDocumentRef.current;
    if (!current) return;
    const node = current.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const nextDescription = metadata.description ?? node.description;
    if (
      (node.description ?? "") === (nextDescription ?? "")
    ) {
      return;
    }
    const nextDocument = {
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === nodeId
          ? {
            ...item,
            ...(metadata.description !== undefined
              ? { description: metadata.description }
              : {}),
          }
          : item
      ),
    };

    markDocumentEdited();
    if (metadata.description !== undefined) {
      queueOperation({
        type: "update_node_description",
        nodeId,
        description: metadata.description,
      });
    }
    commitEditableDocument(nextDocument);
  }, [commitEditableDocument, markDocumentEdited, queueOperation]);

  const handleConnectNodes = useCallback((fromNode: string, toNode: string) => {
    const current = editableDocumentRef.current;
    if (!current) return;
    if (
      current.edges.some((edge) =>
        edge.fromNode === fromNode && edge.toNode === toNode
      )
    ) {
      return;
    }
    const targetNode = current.nodes.find((node) => node.id === toNode);
    if (targetNode?.editable === false) {
      return;
    }
    const staleNodeIds = getNodeAndDescendants(toRuntimeGraph(current), toNode);
    const nextDocument = {
      ...current,
      edges: [...current.edges, { fromNode, toNode }],
    };

    markDocumentEdited();
    queueOperation({ type: "add_edge", fromNode, toNode });
    markNodesStale(staleNodeIds);
    commitEditableDocument(nextDocument);
  }, [
    commitEditableDocument,
    markDocumentEdited,
    markNodesStale,
    queueOperation,
  ]);

  const handleDeleteEdges = useCallback((edgeIds: string[]) => {
    const current = editableDocumentRef.current;
    if (!current) return [];
    const edgeIdSet = new Set(edgeIds);
    const removedEdges = current.edges.filter((edge) =>
      edgeIdSet.has(getEdgeId(edge))
    );
    if (removedEdges.length === 0) return [];
    const editableRemovedEdges = removedEdges.filter((edge) => {
      const targetNode = current.nodes.find((node) => node.id === edge.toNode);
      return targetNode?.editable !== false;
    });
    if (editableRemovedEdges.length === 0) return [];
    const acceptedEdgeIds = editableRemovedEdges.map((edge) => getEdgeId(edge));
    const runtimeGraph = toRuntimeGraph(current);
    const staleNodeIdGroups = editableRemovedEdges.map((edge) =>
      getNodeAndDescendants(runtimeGraph, edge.toNode)
    );
    const nextDocument = {
      ...current,
      edges: current.edges.filter((edge) =>
        !editableRemovedEdges.some((removedEdge) =>
          getEdgeId(removedEdge) === getEdgeId(edge)
        )
      ),
    };

    markDocumentEdited();
    for (const edge of editableRemovedEdges) {
      queueOperation({
        type: "remove_edge",
        fromNode: edge.fromNode,
        toNode: edge.toNode,
      });
    }
    for (const staleNodeIds of staleNodeIdGroups) {
      markNodesStale(staleNodeIds);
    }
    commitEditableDocument(nextDocument);
    return acceptedEdgeIds;
  }, [
    commitEditableDocument,
    markDocumentEdited,
    markNodesStale,
    queueOperation,
  ]);

  const handleDeleteNode = useCallback((nodeId: string) => {
    const current = editableDocumentRef.current;
    if (!current) return;
    if (!current.nodes.some((node) => node.id === nodeId)) return;
    if (hasCustomManagedDownstream(current, nodeId)) return;

    const descendants = getDescendants(toRuntimeGraph(current), nodeId);
    const shouldClearSelection = selectedNodeId === nodeId;
    const nextDocument = {
      ...current,
      nodes: current.nodes.filter((node) => node.id !== nodeId),
      edges: current.edges.filter((edge) =>
        edge.fromNode !== nodeId && edge.toNode !== nodeId
      ),
    };

    markDocumentEdited();
    queueOperation({ type: "delete_node", nodeId });
    markNodesStale(descendants);
    forgetNodes([nodeId]);
    if (shouldClearSelection) {
      setSelectedNodeId(null);
    }
    commitEditableDocument(nextDocument);
  }, [
    commitEditableDocument,
    forgetNodes,
    markDocumentEdited,
    markNodesStale,
    queueOperation,
    selectedNodeId,
  ]);

  const handleNodePositionChange = useCallback((
    nodeId: string,
    position: { x: number; y: number },
  ) => {
    const current = editableDocumentRef.current;
    if (!current) return;
    const node = current.nodes.find((item) => item.id === nodeId);
    if (!node || arePositionsEqual(node.position, position)) return;
    const nextDocument = {
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId ? { ...node, position } : node
      ),
    };

    markDocumentEdited();
    queueOperation({ type: "move_node", nodeId, position });
    commitEditableDocument(nextDocument);
  }, [commitEditableDocument, markDocumentEdited, queueOperation]);

  const handleAutoLayout = useCallback(() => {
    const current = editableDocumentRef.current;
    if (!current) return;
    const positions = createSimpleLayout(toRuntimeGraph(current));
    const changedPositions = current.nodes.flatMap((node) => {
      const position = positions[node.id];
      return position && !arePositionsEqual(node.position, position)
        ? [{ nodeId: node.id, position }]
        : [];
    });

    if (changedPositions.length === 0) return;

    const nextDocument = {
      ...current,
      nodes: current.nodes.map((node) => ({
        ...node,
        position: positions[node.id] ?? node.position,
      })),
    };

    markDocumentEdited();
    for (const { nodeId, position } of changedPositions) {
      queueOperation({ type: "move_node", nodeId, position });
    }
    commitEditableDocument(nextDocument);
  }, [commitEditableDocument, markDocumentEdited, queueOperation]);

  async function validateGraphForExecution(
    graph: RuntimeGraph | null = editableGraph,
  ): Promise<boolean> {
    if (!graph) {
      return false;
    }

    const result = await inspectGraph(graph);
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
    if (!editableDocument || saveStatus === "saving") {
      return;
    }

    void flushPendingOperations();
  }

  async function handleReloadDocumentFromDisk() {
    const result = await documentQuery.refetch();
    if (result.isSuccess) {
      setSaveStatus("idle");
      setSaveError(null);
      return;
    }

    setSaveStatus("error");
    setSaveError(formatSaveError(result.error));
  }

  function getCurrentPythonSourceForRun(): string | undefined {
    // TODO: When the UI owns raw Python source state, pass that string here so
    // dirty editor contents can run without first saving to disk.
    return undefined;
  }

  async function handleRunNode(nodeId: string) {
    if (!editableGraph || !(await flushPendingOperations())) {
      return;
    }
    const document = editableDocumentRef.current;
    const runSourceValue = documentSourceValueRef.current;
    const graph = document ? toRuntimeGraph(document) : null;
    if (!graph || !(await validateGraphForExecution(graph))) {
      return;
    }

    const abortController = startRunAbortController();
    markNodeExecutionRunning(nodeId, "run_node");
    runNodeMutation.mutate({
      graph,
      nodeId,
      inputs: {},
      source: getCurrentPythonSourceForRun(),
      trace: traceEnabled,
      onEvent: (event) => applyExecutionStreamEvent(event, runSourceValue),
      signal: abortController.signal,
      abortController,
      sourceValue: runSourceValue,
    });
  }

  async function handleRunToNode(nodeId: string) {
    if (!editableGraph || !(await flushPendingOperations())) {
      return;
    }
    const document = editableDocumentRef.current;
    const runSourceValue = documentSourceValueRef.current;
    const graph = document ? toRuntimeGraph(document) : null;
    if (!graph || !(await validateGraphForExecution(graph))) {
      return;
    }

    const abortController = startRunAbortController();
    markGraphExecutionRunning("run_to_node");
    runToNodeMutation.mutate({
      graph,
      nodeId,
      inputs: {},
      source: getCurrentPythonSourceForRun(),
      trace: traceEnabled,
      onEvent: (event) => applyExecutionStreamEvent(event, runSourceValue),
      signal: abortController.signal,
      abortController,
      sourceValue: runSourceValue,
    });
  }

  async function handleRunGraph() {
    if (!editableGraph || !(await flushPendingOperations())) {
      return;
    }
    const document = editableDocumentRef.current;
    const runSourceValue = documentSourceValueRef.current;
    const graph = document ? toRuntimeGraph(document) : null;
    if (!graph || !(await validateGraphForExecution(graph))) {
      return;
    }

    const abortController = startRunAbortController();
    markGraphExecutionRunning();
    runGraphMutation.mutate({
      graph,
      inputs: {},
      source: getCurrentPythonSourceForRun(),
      trace: traceEnabled,
      onEvent: (event) => applyExecutionStreamEvent(event, runSourceValue),
      signal: abortController.signal,
      abortController,
      sourceValue: runSourceValue,
    });
  }

  return (
    <div
      className={[
        themeMode === "dark" ? "dark" : "",
        "flex h-screen min-h-0 flex-col bg-zinc-100 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-100",
      ].join(" ")}
    >
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 bg-white px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">Nodebook</h1>
            <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              Alpha
            </span>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="hidden max-w-[34vw] truncate text-sm text-zinc-600 dark:text-zinc-400 md:inline"
            title={documentPath}
          >
            {compactDocumentPath(documentPath)}
          </span>
          <PythonRuntimeBadge
            isLoading={pythonRuntimeQuery.isLoading}
            error={pythonRuntimeQuery.error}
            python={pythonRuntimeQuery.data?.python ?? null}
            documentPath={documentPath}
          />
          {saveStatus === "saved" && (
            <span className="text-xs font-medium text-emerald-700">Saved</span>
          )}
          {saveStatus === "idle" && pendingOperationsRef.current.length > 0 && (
            <span className="text-xs font-medium text-amber-700">
              Unsaved changes
            </span>
          )}
          {saveStatus === "saving" && (
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
              Saving...
            </span>
          )}
          {saveStatus === "error" && saveError && (
            <span
              className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-700"
              title={saveError.detail}
            >
              {saveError.title}
            </span>
          )}
          <button
            type="button"
            aria-label={themeMode === "dark"
              ? "Switch to light mode"
              : "Switch to dark mode"}
            title={themeMode === "dark" ? "Light mode" : "Dark mode"}
            className="flex h-8 w-8 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-700 shadow-sm hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            onClick={() =>
              setThemeMode((current) => current === "dark" ? "light" : "dark")}
          >
            {themeMode === "dark"
              ? (
                <Sun
                  aria-hidden="true"
                  className="h-4 w-4"
                  strokeWidth={2.25}
                />
              )
              : (
                <Moon
                  aria-hidden="true"
                  className="h-4 w-4"
                  strokeWidth={2.25}
                />
              )}
          </button>
          <button
            type="button"
            title={isReadOnlyDocument ? "Read-only" : "Save (Ctrl+S)"}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
            disabled={!editableDocument || saveStatus === "saving"}
            onClick={handleSaveDocument}
          >
            {!isReadOnlyDocument && (
              <Save aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
            )}
            {isReadOnlyDocument
              ? "Read-only"
              : saveStatus === "saving"
              ? "Saving..."
              : "Save"}
          </button>
        </div>
      </header>
      {saveStatus === "error" && saveError && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-900">
          <p className="min-w-0 flex-1">
            <span className="font-medium">{saveError.title}</span>
            <span className="ml-2">{saveError.detail}</span>
          </p>
          <button
            type="button"
            className="shrink-0 rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={documentQuery.isFetching}
            onClick={() => void handleReloadDocumentFromDisk()}
          >
            {documentQuery.isFetching ? "Reloading..." : "Reload from disk"}
          </button>
        </div>
      )}
      {documentQuery.isSuccess && (
        <PreflightPanel
          python={pythonRuntimeQuery.data?.python ?? null}
          pythonError={pythonRuntimeQuery.error}
          isPythonLoading={pythonRuntimeQuery.isLoading}
        />
      )}
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
                key={documentCanvasKey}
                graph={editableGraph}
                selectedNodeId={selectedNodeId}
                nodeRunStatuses={nodeRunStatuses}
                nodePreviews={nodePreviews}
                nodeInputPreviews={nodeInputPreviews}
                nodeOutputOptions={nodeOutputOptions}
                onAddNode={canEditStructure ? handleAddNode : undefined}
                onAutoLayout={isReadOnlyDocument ? undefined : handleAutoLayout}
                onAddChildNode={canEditStructure
                  ? handleAddChildNode
                  : undefined}
                onCodeChange={isReadOnlyDocument ? undefined : handleCodeChange}
                onConnectNodes={canEditStructure
                  ? handleConnectNodes
                  : undefined}
                onDeleteEdges={canEditStructure ? handleDeleteEdges : undefined}
                onDeleteNode={canEditStructure ? handleDeleteNode : undefined}
                onNodePositionChange={handleNodePositionChange}
                onNodeSelect={setSelectedNodeId}
                onOutputsChange={handleOutputsChange}
                onRunToNode={handleRunToNode}
                onRunStep={handleRunNode}
                onSaveDocument={handleSaveDocument}
                outputsReadOnly={!canEditOutputs}
                runToNodeDisabled={isGraphRunning || isSelectedNodeRunning}
                onSelectionClear={() => setSelectedNodeId(null)}
                themeMode={themeMode}
              />
            </div>
            <InspectorPanel
              themeMode={themeMode}
              selectedNode={selectedNodeDetails}
              graph={graphInspectorDetails}
              selectedNodeExecutionState={selectedNodeId
                ? executionStateByNodeId[selectedNodeId] ?? null
                : null}
              selectedNodeRunStatus={selectedNodeId
                ? nodeRunStatuses[selectedNodeId] ?? "idle"
                : "idle"}
              graphExecutionState={graphExecutionState}
              traceEnabled={traceEnabled}
              readOnly={!canEditOutputs}
              onNodeSelect={setSelectedNodeId}
              onCodeChange={handleCodeChange}
              onNodeNameChange={handleNodeNameChange}
              onNodeMetadataChange={handleNodeMetadataChange}
              onGlobalsCodeChange={handleGlobalsCodeChange}
              onOutputsChange={handleOutputsChange}
              onTraceEnabledChange={setTraceEnabled}
              onDeleteNode={canEditStructure ? handleDeleteNode : undefined}
              onRunNode={handleRunNode}
              onRunToNode={handleRunToNode}
              onRunGraph={handleRunGraph}
              onSelectionClear={() => setSelectedNodeId(null)}
              validationIssues={validationIssues}
            />
            <ShortcutHintPanel />
          </div>
        )}
      </main>
    </div>
  );
}

function ShortcutHintPanel() {
  return (
    <aside className="pointer-events-none absolute bottom-3 left-3 hidden rounded border border-zinc-200 bg-white/90 px-3 py-2 text-[11px] text-zinc-500 shadow-sm backdrop-blur md:block">
      <span className="mr-2 font-medium text-zinc-700">Shortcuts</span>
      <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 font-mono text-[10px] text-zinc-700">
        Shift+Enter
      </kbd>
      <span className="mx-1">run step</span>
      <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 font-mono text-[10px] text-zinc-700">
        A
      </kbd>
      <span className="mx-1">add child</span>
      <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 font-mono text-[10px] text-zinc-700">
        Ctrl+S
      </kbd>
      <span className="ml-1">save</span>
    </aside>
  );
}

type PythonRuntime = Awaited<ReturnType<typeof loadPythonRuntime>>["python"];

function compactDocumentPath(path: string): string {
  const parts = path.split(/[\\/]+/u).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return path;
}

function runtimeSummaryLabel(python: PythonRuntime): string {
  return `${runtimeEnvironmentLabel(python)} - Python ${python.version}`;
}

function runtimeModeLabel(python: PythonRuntime): string {
  return python.runtimeMode === "managed"
    ? "Managed environment"
    : "User environment";
}

function runtimeEnvironmentLabel(python: PythonRuntime): string {
  if (python.runtimeMode === "managed") return "Managed env";
  if (python.condaPrefix) return `Conda ${environmentName(python.condaPrefix)}`;
  if (python.virtualEnv) return `Venv ${environmentName(python.virtualEnv)}`;
  return "System Python";
}

function environmentName(path: string): string {
  return path.split(/[\\/]+/u).filter(Boolean).at(-1) ?? path;
}

function PythonRuntimeBadge({
  python,
  isLoading,
  error,
  documentPath,
}: {
  python: PythonRuntime | null;
  isLoading: boolean;
  error: Error | null;
  documentPath: string;
}) {
  if (isLoading) {
    return <RuntimeChip label="Python checking..." tone="neutral" />;
  }

  if (error) {
    return (
      <RuntimeChip
        label="Python unavailable"
        tone="warning"
        title={error.message}
      />
    );
  }

  if (!python) return null;

  const runtimeLabel = runtimeSummaryLabel(python);
  const title = [
    `Runtime: ${runtimeModeLabel(python)}`,
    `Python: ${python.executable}`,
    `Document: ${documentPath}`,
  ].join("\n");

  return (
    <details className="group relative hidden md:block">
      <summary
        className="flex cursor-pointer list-none items-center gap-1.5 rounded border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 [&::-webkit-details-marker]:hidden"
        title={title}
      >
        <span>{runtimeLabel}</span>
      </summary>
      <div className="absolute right-0 z-30 mt-2 w-[min(34rem,calc(100vw-2rem))] rounded border border-zinc-200 bg-white p-3 text-xs text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
        <div className="mb-2 flex items-center justify-between gap-3 border-b border-zinc-200 pb-2 dark:border-zinc-700">
          <span className="font-semibold">Runtime Details</span>
          <span className="text-zinc-500 dark:text-zinc-400">
            {runtimeModeLabel(python)}
          </span>
        </div>
        <RuntimeDetail label="Document" value={documentPath} />
        <RuntimeDetail label="Python" value={python.executable} />
        <RuntimeDetail label="Version" value={python.version} />
        {python.condaPrefix && (
          <RuntimeDetail label="Conda" value={python.condaPrefix} />
        )}
        {python.virtualEnv && (
          <RuntimeDetail label="Venv" value={python.virtualEnv} />
        )}
        <RuntimeDetail
          label="nodebook"
          value={python.nodebookImport.ok
            ? python.nodebookImport.path ?? "importable"
            : python.nodebookImport.error ?? "not importable"}
          tone={python.nodebookImport.ok ? "default" : "warning"}
        />
      </div>
    </details>
  );
}

function PreflightPanel({
  python,
  pythonError,
  isPythonLoading,
}: {
  python: PythonRuntime | null;
  pythonError: Error | null;
  isPythonLoading: boolean;
}) {
  if (
    isPythonLoading || (!pythonError && (!python || python.nodebookImport.ok))
  ) {
    return null;
  }

  return (
    <section className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-900 dark:border-amber-900/70 dark:bg-amber-950 dark:text-amber-100">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        {pythonError
          ? <PreflightItem label="Python" value="unavailable" tone="warning" />
          : python
          ? (
            <PreflightItem
              label="nodebook"
              value={python.nodebookImport.error ?? "not importable"}
              tone="warning"
            />
          )
          : null}
      </div>
    </section>
  );
}

function RuntimeChip({
  label,
  tone,
  title,
}: {
  label: string;
  tone: "neutral" | "warning";
  title?: string;
}) {
  const className = tone === "warning"
    ? "hidden rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 md:block"
    : "hidden rounded border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-500 md:block dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  return (
    <div className={className} title={title}>
      {label}
    </div>
  );
}

function RuntimeDetail({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warning";
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 py-1">
      <span className="font-medium text-zinc-500 dark:text-zinc-400">
        {label}
      </span>
      <span
        className={[
          "min-w-0 break-all font-mono",
          tone === "warning" ? "text-amber-700 dark:text-amber-200" : "",
        ].join(" ")}
      >
        {value}
      </span>
    </div>
  );
}

function PreflightItem({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warning";
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="font-medium text-zinc-700 dark:text-zinc-200">
        {label}
      </span>
      <span
        className={[
          "min-w-0 max-w-[34rem] truncate font-mono",
          tone === "warning"
            ? "text-amber-700 dark:text-amber-300"
            : "text-zinc-500 dark:text-zinc-400",
        ].join(" ")}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function toAddNodeOperationNode(node: RuntimeNode): Extract<
  DocumentOperation,
  { type: "add_node" }
>["node"] {
  return {
    id: node.id,
    functionName: node.functionName ?? node.id,
    code: node.code,
    outputs: node.outputs,
    ...(node.position ? { position: node.position } : {}),
    ...(node.title ? { title: node.title } : {}),
    ...(node.description ? { description: node.description } : {}),
  };
}

function formatSaveError(error: unknown): SaveErrorMessage {
  if (error instanceof DocumentApiRequestError && error.issues.length > 0) {
    const issue = error.issues[0];
    const location = formatIssueLocation(issue.path);

    if (issue.kind === "invalid_python") {
      return {
        title: "Save failed: unsaved Python has a syntax error",
        detail:
          `${issue.message}${location}. The saved file was not changed. Fix the editor contents or reload from disk to discard unsaved edits.`,
      };
    }

    return {
      title: "Save failed",
      detail: `${issue.kind}: ${issue.message}${location}`,
    };
  }

  return {
    title: "Save failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

function formatIssueLocation(path: string | undefined): string {
  if (!path) {
    return "";
  }

  const [line, column] = path.split(":");
  if (line && column) {
    return ` at line ${line}, column ${column}`;
  }

  return ` at ${path}`;
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

function resultToCanvasPreview(
  result: NodeRunResult,
): NodeCanvasPreview | null {
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

function getNodeCanvasInputPreviewsById(
  graph: RuntimeGraph,
  executionStateByNodeId: Record<string, ExecutionDisplayState>,
): Record<string, Array<{ name: string; type?: string }>> {
  return Object.fromEntries(
    graph.nodes.map((node) => [
      node.id,
      getNodeInputGroups(graph, node.id, executionStateByNodeId)
        .flatMap((group) =>
          Object.entries(group.values).map(([name, preview]) => ({
            name,
            ...(preview ? { type: preview.type } : {}),
          }))
        ),
    ]),
  );
}

function getNodeInputGroups(
  graph: RuntimeGraph,
  nodeId: string,
  executionStateByNodeId: Record<string, ExecutionDisplayState>,
): Array<{
  nodeId: string;
  label: string;
  values: Record<string, ValuePreview | null>;
}> {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

  return graph.edges
    .filter((edge) => edge.toNode === nodeId)
    .flatMap((edge) => {
      const upstream = nodesById.get(edge.fromNode);
      if (!upstream) {
        return [];
      }

      const upstreamOutputs = getOutputPreviewsForNode(
        upstream.id,
        executionStateByNodeId,
      );
      const values = Object.fromEntries(
        upstream.outputs.map((name) => [
          name,
          upstreamOutputs[name] ?? null,
        ]),
      );

      return [{
        nodeId: upstream.id,
        label: getNodeDisplayTitle(upstream),
        values,
      }];
    });
}

function getOutputPreviewsForNode(
  nodeId: string,
  executionStateByNodeId: Record<string, ExecutionDisplayState>,
): Record<string, ValuePreview> {
  const state = executionStateByNodeId[nodeId];
  if (!state) {
    return {};
  }

  if (state.status === "completed_node" || state.status === "failed_node") {
    return state.result.outputs;
  }

  if (state.status === "completed") {
    return state.response.resultsByNode[nodeId]?.outputs ?? {};
  }

  return {};
}

function getNodeDisplayTitle(node: RuntimeNode): string {
  return prettifyFunctionName(node.functionName);
}

function getNodeLabelsById(graph: RuntimeGraph): Record<string, string> {
  return Object.fromEntries(
    graph.nodes.map((node) => [node.id, getNodeDisplayTitle(node)]),
  );
}

function createNewPythonNode(
  id: string,
  functionName: string,
  position: { x: number; y: number },
): RuntimeNode {
  return {
    id,
    functionName,
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

function hasNodeIdOrFunctionName(
  graph: RuntimeGraph,
  nodeId: string,
  functionName: string,
): boolean {
  return graph.nodes.some((node) =>
    node.id === nodeId || node.functionName === functionName
  );
}

function createGeneratedFunctionNameSession(
  graph: RuntimeGraph,
): GeneratedFunctionNameSession {
  let maxGeneratedIndex = 0;
  const reservedNames = new Set<string>();

  for (const node of graph.nodes) {
    if (!node.functionName) {
      continue;
    }

    const generatedIndex = getGeneratedFunctionNameIndex(node.functionName);
    if (generatedIndex === null) {
      continue;
    }

    reservedNames.add(node.functionName);
    maxGeneratedIndex = Math.max(maxGeneratedIndex, generatedIndex);
  }

  return {
    reservedNames,
    nextIndex: Math.max(maxGeneratedIndex, graph.nodes.length) + 1,
  };
}

function reserveNextFunctionName(
  graph: RuntimeGraph,
  session: GeneratedFunctionNameSession,
): string {
  const existingNames = new Set(
    graph.nodes.flatMap((node) => node.functionName ? [node.functionName] : []),
  );
  let index = Math.max(
    session.nextIndex,
    getNextGeneratedFunctionNameIndex(graph),
  );

  while (
    existingNames.has(`new_step_${index}`) ||
    session.reservedNames.has(`new_step_${index}`)
  ) {
    index += 1;
  }

  const name = `new_step_${index}`;
  session.reservedNames.add(name);
  session.nextIndex = index + 1;

  return name;
}

function getNextGeneratedFunctionNameIndex(graph: RuntimeGraph): number {
  let maxGeneratedIndex = 0;

  for (const node of graph.nodes) {
    if (!node.functionName) {
      continue;
    }

    const generatedIndex = getGeneratedFunctionNameIndex(node.functionName);
    if (generatedIndex !== null) {
      maxGeneratedIndex = Math.max(maxGeneratedIndex, generatedIndex);
    }
  }

  return Math.max(maxGeneratedIndex, graph.nodes.length) + 1;
}

function getGeneratedFunctionNameIndex(functionName: string): number | null {
  const match = generatedFunctionNamePattern.exec(functionName);
  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function createChildNodePosition(
  graph: RuntimeGraph,
  parentNode: RuntimeNode,
): { x: number; y: number } {
  const basePosition = {
    x: parentNode.position?.x ?? 0,
    y: (parentNode.position?.y ?? 0) + 280,
  };
  const childNodeIds = new Set(
    graph.edges
      .filter((edge) => edge.fromNode === parentNode.id)
      .map((edge) => edge.toNode),
  );
  const childPositions = graph.nodes
    .filter((node) => childNodeIds.has(node.id) && node.position)
    .map((node) => node.position!);
  const offsetStep = 48;

  for (
    let offsetIndex = 0;
    offsetIndex <= childPositions.length;
    offsetIndex += 1
  ) {
    const candidate = {
      x: basePosition.x + offsetIndex * offsetStep,
      y: basePosition.y + offsetIndex * offsetStep,
    };

    if (
      !childPositions.some((position) =>
        arePositionsNear(position, candidate, offsetStep / 2)
      )
    ) {
      return candidate;
    }
  }

  return {
    x: basePosition.x + (childPositions.length + 1) * offsetStep,
    y: basePosition.y + (childPositions.length + 1) * offsetStep,
  };
}

function arePositionsNear(
  first: { x: number; y: number },
  second: { x: number; y: number },
  tolerance: number,
): boolean {
  return Math.abs(first.x - second.x) <= tolerance &&
    Math.abs(first.y - second.y) <= tolerance;
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
  Array<{ name: string; source: "input" | "assigned" | "missing" }>
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
): Array<{ name: string; source: "input" | "assigned" | "missing" }> {
  const options: Array<
    { name: string; source: "input" | "assigned" | "missing" }
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
    options.push({ name, source: "missing" });
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

  if (node.name === "MemberExpression") {
    const target = node.firstChild;
    if (target?.name === "VariableName") {
      addOutput(code.slice(target.from, target.to));
    }
    return;
  }

  if (node.name === "TupleExpression" || node.name === "ArrayExpression") {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      collectBindingNames(child, code, addOutput);
    }
  }
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
