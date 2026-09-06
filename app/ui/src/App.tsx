import { DismissibleDetails } from "./components/DismissibleDetails.tsx";
import { ActionMenu, RunMenu } from "./components/RunMenu.tsx";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SyntaxNode } from "@lezer/common";
import { parser as pythonParser } from "@lezer/python";
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Play,
  Save,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DocumentApiRequestError,
  type DocumentOperation,
  importDocumentFile,
  maxImportedFileBytes,
} from "./api/documents.ts";
import {
  loadProjectEnvironment,
  loadPythonRuntime,
  type ProjectEnvironmentInfo,
  restartPythonRuntime,
  syncProjectEnvironment,
} from "./api/runtime.ts";
import { WorkspaceSplit } from "./components/WorkspaceSplit.tsx";
import { Canvas } from "./components/Canvas.tsx";
import {
  deriveRoutedOutputs,
  getChangedOutputNodeIds,
  hasCustomManagedDownstream,
  removeNodeAndIncidentEdges,
} from "./documentOperations.ts";
import {
  type ExecutionDisplayState,
  type GraphInspectorModel,
  type InspectorNavigationRequest,
  InspectorPanel,
  type NodeInspectorBadge,
  type NodeInspectorSelection,
} from "./components/InspectorPanel.tsx";
import { getEdgeId } from "./graph/toReactFlow.ts";
import type {
  NodeCanvasPreview,
  NodeRunVisualStatus,
} from "./graph/toReactFlow.ts";
import {
  type RowcallDocumentV1,
  toRuntimeGraph,
} from "./graph/documentTypes.ts";
import { getConnectionConflict } from "./graph/connectionValidation.ts";
import { createSimpleLayout, type NodeDimensionsById } from "./graph/layout.ts";
import { detectPureOutputRename } from "./graph/outputRename.ts";
import {
  functionNameFromDisplayName,
  isValidPythonIdentifier,
  prettifyFunctionName,
} from "./graph/nodeNames.ts";
import {
  runGraphMutationOptions,
  runToNodeMutationOptions,
} from "./query/executionMutations.ts";
import { useExecutionSession } from "./query/useExecutionSession.ts";
import {
  getRunNotificationSummary,
  type RunNotification,
} from "./query/executionPresentation.ts";
import { canEditDocument } from "./documentReload.ts";
import { useDocumentSession } from "./useDocumentSession.ts";
import type { PythonEditorErrorTarget } from "./documentSaveError.ts";
import {
  createImportedFileNode,
  ensurePolarsGlobalsImport,
  importAutoPreviewSkipReason,
} from "./importedFile.ts";
import type { RuntimeGraph, RuntimeNode } from "./graph/runtimeTypes.ts";
import type { NodeRunResult, ValuePreview } from "../../../types.ts";

const generatedFunctionNamePattern = /^new_step_(\d+)$/u;
const documentCanvasKey = "document:active";
const themeStorageKey = "rowcall:theme";
const environmentStatusPollIntervalMs = 4_000;
const successfulRunNoticeMs = 3_000;
const importNoticeMs = 7_000;

export type ThemeMode = "light" | "dark";

type GeneratedFunctionNameSession = {
  reservedNames: Set<string>;
  nextIndex: number;
};

export type NodeNameChangeResult =
  | { ok: true; functionName: string }
  | { ok: false; message: string };

type ConnectionWarning = {
  title: string;
  detail: string;
};

type ImportNotification = {
  id: number;
  tone: "info" | "warning" | "danger";
  title: string;
  detail: string;
};

function getExecutionSourceValue(executionGeneration: number): string {
  return `execution-source:${executionGeneration}`;
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
  const [inspectorFocused, setInspectorFocused] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialThemeMode);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [pendingNodeDeletion, setPendingNodeDeletion] = useState<
    {
      nodeId: string;
      label: string;
      incidentEdgeCount: number;
    } | null
  >(null);
  const [inspectorNavigationRequest, setInspectorNavigationRequest] = useState<
    InspectorNavigationRequest | null
  >(null);
  const [canvasFocusRequest, setCanvasFocusRequest] = useState<
    { nodeId: string; requestId: number } | null
  >(null);
  const [connectionWarning, setConnectionWarning] = useState<
    ConnectionWarning | null
  >(null);
  const [importNotification, setImportNotification] = useState<
    ImportNotification | null
  >(null);
  const [importingFileName, setImportingFileName] = useState<string | null>(
    null,
  );
  const executionGenerationRef = useRef(0);
  const executionSourceValueRef = useRef(
    getExecutionSourceValue(executionGenerationRef.current),
  );
  const [executionSourceValue, setExecutionSourceValue] = useState(() =>
    executionSourceValueRef.current
  );
  const importNotificationIdRef = useRef(0);
  const importInFlightRef = useRef(false);
  const generatedFunctionNameSessionRef = useRef<GeneratedFunctionNameSession>({
    reservedNames: new Set(),
    nextIndex: 1,
  });
  const pythonRuntimeQuery = useQuery({
    queryKey: ["runtime", "python"],
    queryFn: loadPythonRuntime,
  });
  useEffect(() => {
    globalThis.localStorage.setItem(themeStorageKey, themeMode);
  }, [themeMode]);
  const advanceExecutionSourceValue = useCallback(() => {
    executionGenerationRef.current += 1;
    const sourceValue = getExecutionSourceValue(
      executionGenerationRef.current,
    );
    executionSourceValueRef.current = sourceValue;
    setExecutionSourceValue(sourceValue);
    return sourceValue;
  }, []);
  const {
    successfulResultsByNodeId,
    executionStateByNodeId,
    graphExecutionState,
    activeRunType,
    nodeRunStatuses,
    runNotification,
    applyExecutionStreamEvent,
    clearActiveRun,
    clearExecutionSession,
    dismissRunNotification,
    forgetNodes,
    isCurrentSource,
    markGraphExecutionRunning,
    markNodeExecutionRunning,
    markNodesStale,
    prepareForDocumentEdit,
    resetUnfinishedRunStatuses,
    startRunAbortController,
    storeExecutionRequestErrorForNode,
    storeRunNotification,
    storeExecutionResponseForNodeIds,
    storeGraphExecutionRequestError,
    storeGraphExecutionResponse,
  } = useExecutionSession(executionSourceValue, {
    getCurrentSourceValue: () => executionSourceValueRef.current,
  });
  const {
    documentQuery,
    editableDocument,
    documentPath,
    saveStatus,
    saveError,
    pendingOperationCount,
    firstUnsavedEditAt,
    isExternalReloading,
    externalDocumentNotice,
    editDocument,
    getSnapshot: getDocumentSnapshot,
    waitForActiveSave,
    prepareForWrite,
    saveDocument,
    reloadDocument: handleReloadDocumentFromDisk,
  } = useDocumentSession({
    onLoaded: (document, preserveExecutionSession) => {
      generatedFunctionNameSessionRef.current =
        createGeneratedFunctionNameSession(document);
      setPendingNodeDeletion(null);
      if (!preserveExecutionSession) {
        clearExecutionSession();
        advanceExecutionSourceValue();
      }
    },
    onExecutionEdit: () => {
      prepareForDocumentEdit();
      advanceExecutionSourceValue();
    },
    onPythonError: navigateToPythonError,
  });
  const projectEnvironmentQuery = useQuery({
    queryKey: ["runtime", "environment"],
    queryFn: loadProjectEnvironment,
    enabled: documentQuery.isSuccess,
    refetchInterval: environmentStatusPollIntervalMs,
    refetchOnWindowFocus: true,
  });
  const isRunActive = activeRunType !== null;
  const isSelectedNodeRunning = selectedNodeId
    ? executionStateByNodeId[selectedNodeId]?.status === "running"
    : false;
  const syncEnvironmentMutation = useMutation({
    mutationFn: syncProjectEnvironment,
    onMutate: () => {
      clearExecutionSession();
    },
    onSuccess: async () => {
      await projectEnvironmentQuery.refetch();
    },
  });
  const restartRuntimeMutation = useMutation({
    mutationFn: restartPythonRuntime,
    onMutate: () => {
      clearExecutionSession();
    },
    onSuccess: async () => {
      await Promise.all([
        pythonRuntimeQuery.refetch(),
        projectEnvironmentQuery.refetch(),
      ]);
    },
  });
  const isRuntimeMaintenanceActive = syncEnvironmentMutation.isPending ||
    restartRuntimeMutation.isPending;
  const activeRunTypeRef = useRef(activeRunType);
  const runtimeMaintenanceActiveRef = useRef(isRuntimeMaintenanceActive);
  const runtimeReadyRef = useRef(
    pythonRuntimeQuery.isSuccess &&
      pythonRuntimeQuery.data.python.rowcallImport.ok,
  );

  useEffect(() => {
    activeRunTypeRef.current = activeRunType;
    runtimeMaintenanceActiveRef.current = isRuntimeMaintenanceActive;
    runtimeReadyRef.current = pythonRuntimeQuery.isSuccess &&
      pythonRuntimeQuery.data.python.rowcallImport.ok;
  }, [
    activeRunType,
    isRuntimeMaintenanceActive,
    pythonRuntimeQuery.data,
    pythonRuntimeQuery.isSuccess,
  ]);

  useEffect(() => {
    if (runNotification?.tone !== "success") {
      return;
    }

    const timeoutId = setTimeout(
      () => dismissRunNotification(runNotification.id),
      successfulRunNoticeMs,
    );
    return () => clearTimeout(timeoutId);
  }, [dismissRunNotification, runNotification]);

  useEffect(() => {
    if (!importNotification || importNotification.tone === "danger") {
      return;
    }

    const timeoutId = setTimeout(() => {
      setImportNotification((current) =>
        current?.id === importNotification.id ? null : current
      );
    }, importNoticeMs);
    return () => clearTimeout(timeoutId);
  }, [importNotification]);

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
      storeRunNotification(response);
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
        response.executedNodeIds.filter((nodeId) =>
          response.ok || response.resultsByNode[nodeId]?.ok
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
  const editingBlocked = saveStatus === "outcome_unknown";
  const canEditStructure = canEditDocument({
    readOnly: isReadOnlyDocument,
    saveOutcomeUnknown: editingBlocked,
  });
  const canEditOutputs = canEditStructure;
  const nodePreviews = useMemo(
    () => getNodeCanvasPreviews(executionStateByNodeId),
    [executionStateByNodeId],
  );
  const nodeInputPreviews = useMemo(
    () =>
      editableGraph
        ? getNodeCanvasInputPreviewsById(
          editableGraph,
          executionStateByNodeId,
          nodeRunStatuses,
        )
        : {},
    [editableGraph, executionStateByNodeId, nodeRunStatuses],
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
      routedOutputs: node.outputs,
      variables: getNodeOutputOptions(
        node.parameters ?? [],
        inferAssignableOutputs(node.displayCode ?? node.code),
        node.outputs,
      ),
      variablePreviews: getVariablePreviewsForNode(
        node.id,
        executionStateByNodeId,
      ),
      lastSuccessfulResult: successfulResultsByNodeId[node.id],
      inputSources: Object.fromEntries(
        editableGraph.edges.filter((edge) => edge.toNode === node.id).map((
          edge,
        ) => [
          edge.toInput,
          getNodeLabelsById(editableGraph)[edge.fromNode] ?? edge.fromNode,
        ]),
      ),
      upstreamDependencies: detail?.upstreamDependencies ?? [],
      downstreamDependencies: detail?.downstreamDependencies ?? [],
      nodeLabelsById: getNodeLabelsById(editableGraph),
      badges,
    };
  }, [
    editableGraph,
    executionStateByNodeId,
    graphNodeDetails,
    successfulResultsByNodeId,
    selectedNodeId,
  ]);

  const handleAddNode = useCallback((position: { x: number; y: number }) => {
    const current = getDocumentSnapshot().document;
    if (!current || getDocumentSnapshot().editingBlocked) return;
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

    editDocument(nextDocument, [{
      type: "add_node",
      node: toAddNodeOperationNode(node),
    }]);
  }, [editDocument, getDocumentSnapshot]);

  async function handleImportFiles(
    files: File[],
    position: { x: number; y: number },
  ) {
    if (files.length !== 1) {
      showImportNotification({
        tone: "warning",
        title: "Drop one file at a time",
        detail: "No files were imported.",
      });
      return;
    }
    if (importInFlightRef.current) {
      showImportNotification({
        tone: "warning",
        title: "An import is already in progress",
        detail: "Wait for it to finish before dropping another file.",
      });
      return;
    }

    const file = files[0];
    const current = getDocumentSnapshot().document;
    if (!current || current.readOnly) {
      showImportNotification({
        tone: "warning",
        title: "This document is read-only",
        detail: `${file.name} was not copied into the project.`,
      });
      return;
    }
    if (getDocumentSnapshot().editingBlocked) {
      showImportNotification({
        tone: "danger",
        title: "Import unavailable",
        detail:
          "Reload from disk to resolve the unknown save outcome before importing a file.",
      });
      return;
    }
    if (activeRunTypeRef.current !== null) {
      showImportNotification({
        tone: "warning",
        title: "A run is in progress",
        detail:
          `Wait for it to finish before importing ${file.name}. The file was not copied.`,
      });
      return;
    }
    if (file.size > maxImportedFileBytes) {
      showImportNotification({
        tone: "danger",
        title: "File is too large",
        detail: `${file.name} exceeds the 100 MiB import limit.`,
      });
      return;
    }

    const hadUnsavedWork = getDocumentSnapshot().hasUnsavedWork;
    const startingEditGeneration = getDocumentSnapshot().editGeneration;
    const hadRuntimeMaintenance = runtimeMaintenanceActiveRef.current;
    const runtimeWasReady = runtimeReadyRef.current;

    importInFlightRef.current = true;
    setImportingFileName(file.name);
    try {
      if (!(await waitForActiveSave())) {
        showImportNotification({
          tone: "danger",
          title: "Import paused",
          detail:
            "The active save did not finish successfully, so no file was copied.",
        });
        return;
      }
      if (!(await prepareForWrite())) {
        return;
      }

      const imported = await importDocumentFile(file);
      const latest = getDocumentSnapshot().document;
      if (!latest || latest.readOnly || getDocumentSnapshot().editingBlocked) {
        showImportNotification({
          tone: "danger",
          title: `Copied ${imported.storedName}, but could not add its node`,
          detail:
            "The file remains in the project’s data folder. Resolve the document state, then add its reader node manually.",
        });
        return;
      }

      const nodeId = createNextNodeId(latest);
      const importedNode = createImportedFileNode({
        id: nodeId,
        storedName: imported.storedName,
        relativePath: imported.relativePath,
        position,
        existingFunctionNames: latest.nodes.flatMap((node) =>
          node.functionName ? [node.functionName] : []
        ),
      });
      const currentGlobalsCode = latest.globalsCode ?? "";
      const nextGlobalsCode = importedNode.kind === "unsupported"
        ? currentGlobalsCode
        : ensurePolarsGlobalsImport(currentGlobalsCode);
      const globalsChanged = nextGlobalsCode !== currentGlobalsCode;
      const nextDocument = {
        ...latest,
        ...(globalsChanged ? { globalsCode: nextGlobalsCode } : {}),
        nodes: [...latest.nodes, importedNode.node],
      };
      const documentChangedDuringImport =
        getDocumentSnapshot().editGeneration !== startingEditGeneration;

      if (activeRunTypeRef.current !== null) {
        showImportNotification({
          tone: "warning",
          title: `Copied ${imported.storedName}, but did not add its node`,
          detail:
            "A run started while the import was in progress. The file remains in the project’s data folder.",
        });
        return;
      }

      const operations: DocumentOperation[] = [];
      if (globalsChanged) {
        operations.push({ type: "update_globals", code: nextGlobalsCode });
      }
      operations.push({
        type: "add_node",
        node: toAddNodeOperationNode(importedNode.node),
      });
      editDocument(nextDocument, operations);
      setSelectedNodeId(nodeId);

      const renamed = imported.storedName !== file.name;
      if (importedNode.kind === "unsupported") {
        showImportNotification({
          tone: "warning",
          title: `Copied ${imported.storedName}`,
          detail:
            "Rowcall does not know this format. Choose a reader in the generated file node.",
        });
        return;
      }

      const autoPreviewSkipReason = importAutoPreviewSkipReason({
        hadUnsavedWork: hadUnsavedWork || documentChangedDuringImport,
        hadRuntimeMaintenance,
        runtimeMaintenanceNow: runtimeMaintenanceActiveRef.current,
        runtimeWasReady,
        runtimeIsReady: runtimeReadyRef.current,
      });
      if (autoPreviewSkipReason === "unsaved_work") {
        showImportNotification({
          tone: "warning",
          title: `Imported ${imported.storedName}`,
          detail:
            "Auto-preview was skipped to avoid saving your other edits. Run the node when you’re ready.",
        });
        return;
      }
      if (autoPreviewSkipReason === "runtime_unavailable") {
        showImportNotification({
          tone: "warning",
          title: `Imported ${imported.storedName}`,
          detail:
            "Auto-preview was skipped because the Python runtime is not ready. Run the node when it becomes available.",
        });
        return;
      }

      if (renamed) {
        showImportNotification({
          tone: "info",
          title: `Imported as ${imported.storedName}`,
          detail:
            `${file.name} already existed or required a safe project filename.`,
        });
      }
      await handleRunToNode(nodeId, { allowDuringImport: true });
    } catch (error) {
      showImportNotification({
        tone: "danger",
        title: `Couldn’t import ${file.name}`,
        detail: error instanceof Error
          ? error.message
          : "The file could not be copied into the project.",
      });
    } finally {
      importInFlightRef.current = false;
      setImportingFileName(null);
    }
  }

  function handleImportDirectoryRejected() {
    showImportNotification({
      tone: "warning",
      title: "Folders aren’t supported",
      detail: "Drop one file at a time instead.",
    });
  }

  const handleAddChildNode = useCallback((parentNodeId: string) => {
    const current = getDocumentSnapshot().document;
    if (!current || getDocumentSnapshot().editingBlocked) return;
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
    };

    editDocument(nextDocument, [{
      type: "add_node",
      node: toAddNodeOperationNode(node),
    }]);
    setSelectedNodeId(node.id);
  }, [editDocument, getDocumentSnapshot]);

  const handleCodeChange = useCallback((nodeId: string, code: string) => {
    const current = getDocumentSnapshot().document;
    if (!current || getDocumentSnapshot().editingBlocked) return;
    const node = current.nodes.find((item) => item.id === nodeId);
    if (!node || node.code === code) return;
    const staleNodeIds = getNodeAndDescendants(toRuntimeGraph(current), nodeId);
    const renamedOutput = detectPureOutputRename(
      node.code,
      code,
      node.outputs,
      inferAssignableOutputs(node.code),
      inferAssignableOutputs(code),
    );
    const renamedEdges = renamedOutput
      ? current.edges.filter((edge) =>
        edge.fromNode === nodeId &&
        edge.fromOutput === renamedOutput.fromOutput
      )
      : [];
    const nextOutputs = renamedOutput
      ? node.outputs.map((output) =>
        output === renamedOutput.fromOutput ? renamedOutput.toOutput : output
      )
      : node.outputs;
    const nextDocument = {
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === nodeId
          ? { ...item, code, outputs: nextOutputs, runtimeCode: undefined }
          : item
      ),
      edges: current.edges.map((edge) =>
        renamedEdges.includes(edge)
          ? { ...edge, fromOutput: renamedOutput!.toOutput }
          : edge
      ),
    };

    const operations: DocumentOperation[] = [
      { type: "update_node_body", nodeId, code },
    ];
    if (renamedOutput) {
      for (const edge of renamedEdges) {
        operations.push({ type: "remove_edge", ...edge });
      }
      for (const edge of renamedEdges) {
        operations.push({
          type: "add_edge",
          ...edge,
          fromOutput: renamedOutput.toOutput,
        });
      }
    }
    editDocument(nextDocument, operations);
    markNodesStale(staleNodeIds);
  }, [
    editDocument,
    getDocumentSnapshot,
    markNodesStale,
  ]);

  const handleGlobalsCodeChange = useCallback((globalsCode: string) => {
    const current = getDocumentSnapshot().document;
    if (
      !current || getDocumentSnapshot().editingBlocked ||
      (current.globalsCode ?? "") === globalsCode
    ) {
      return;
    }
    const staleNodeIds = current.nodes.map((node) => node.id);
    const nextDocument = {
      ...current,
      globalsCode,
    };

    editDocument(nextDocument, [{ type: "update_globals", code: globalsCode }]);
    markNodesStale(staleNodeIds);
  }, [
    editDocument,
    getDocumentSnapshot,
    markNodesStale,
  ]);

  const handleOutputsChange = useCallback((
    nodeId: string,
    outputs: string[],
  ) => {
    const current = getDocumentSnapshot().document;
    if (!current || getDocumentSnapshot().editingBlocked) return;
    const node = current.nodes.find((item) => item.id === nodeId);
    if (!node || areStringArraysEqual(node.outputs, outputs)) return;
    if (hasCustomManagedDownstream(current, nodeId)) return;
    const staleNodeIds = getNodeAndDescendants(toRuntimeGraph(current), nodeId);
    const removed = node.outputs.filter((output) => !outputs.includes(output));
    const added = outputs.filter((output) => !node.outputs.includes(output));
    const renamedEdges = removed.length === 1 && added.length === 1
      ? current.edges.filter((edge) =>
        edge.fromNode === nodeId && edge.fromOutput === removed[0]
      )
      : [];
    const removedEdges = renamedEdges.length > 0
      ? renamedEdges
      : current.edges.filter((edge) =>
        edge.fromNode === nodeId && removed.includes(edge.fromOutput)
      );
    const nextEdges = current.edges
      .filter((edge) => !removedEdges.includes(edge))
      .concat(renamedEdges.map((edge) => ({
        ...edge,
        fromOutput: added[0],
      })));
    const nextDocument = {
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === nodeId ? { ...item, outputs, runtimeCode: undefined } : item
      ),
      edges: nextEdges,
    };

    const operations: DocumentOperation[] = [];
    for (const edge of removedEdges) {
      operations.push({ type: "remove_edge", ...edge });
    }
    if (removedEdges.length === 0) {
      // Legacy documents may contain an unconnected declared output. Routes
      // normally derive this return plumbing, but keep the inline cleanup
      // action capable of removing that old declaration.
      operations.push({ type: "update_node_outputs", nodeId, outputs });
    }
    for (const edge of renamedEdges) {
      operations.push({
        type: "add_edge",
        ...edge,
        fromOutput: added[0],
      });
    }
    editDocument(nextDocument, operations);
    markNodesStale(staleNodeIds);
  }, [
    editDocument,
    getDocumentSnapshot,
    markNodesStale,
  ]);

  const handleNodeNameChange = useCallback((
    nodeId: string,
    displayName: string,
  ): NodeNameChangeResult => {
    const current = getDocumentSnapshot().document;
    if (getDocumentSnapshot().editingBlocked) {
      return {
        ok: false,
        message: "Reload from disk before making more changes.",
      };
    }
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

    editDocument(nextDocument, [{
      type: "rename_node_function",
      nodeId,
      functionName,
    }]);
    markNodesStale(staleNodeIds);

    return { ok: true, functionName };
  }, [
    editDocument,
    getDocumentSnapshot,
    markNodesStale,
  ]);

  const handleNodeMetadataChange = useCallback((
    nodeId: string,
    metadata: { description?: string },
  ) => {
    const current = getDocumentSnapshot().document;
    if (!current || getDocumentSnapshot().editingBlocked) return;
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

    const operations: DocumentOperation[] = [];
    if (metadata.description !== undefined) {
      operations.push({
        type: "update_node_description",
        nodeId,
        description: metadata.description,
      });
    }
    editDocument(nextDocument, operations, "metadata");
  }, [editDocument, getDocumentSnapshot]);

  const handleConnectNodes = useCallback((
    fromNode: string,
    fromOutput: string,
    toNode: string,
  ) => {
    const current = getDocumentSnapshot().document;
    if (!current || getDocumentSnapshot().editingBlocked) return;
    const toInput = fromOutput;
    const sourceNode = current.nodes.find((node) => node.id === fromNode);
    const targetNode = current.nodes.find((node) => node.id === toNode);
    const sourceOption = sourceNode && getNodeOutputOptions(
      sourceNode.parameters ?? [],
      inferAssignableOutputs(sourceNode.code),
      sourceNode.outputs,
    ).find((option) => option.name === fromOutput);
    if (
      !sourceNode || !sourceOption || sourceOption.source === "missing" ||
      targetNode?.editable === false || fromNode === toNode
    ) {
      return;
    }
    const conflict = getConnectionConflict(
      current,
      fromNode,
      fromOutput,
      toNode,
      toInput,
    );
    if (conflict === "duplicate") return;
    if (conflict === "input_bound") {
      setConnectionWarning(
        createConnectionWarning(current, fromNode, fromOutput, toNode),
      );
      return;
    }
    const promotesOutput = !sourceNode.outputs.includes(fromOutput);
    const staleNodeIds = Array.from(
      new Set([
        ...getNodeAndDescendants(toRuntimeGraph(current), fromNode),
        ...getNodeAndDescendants(toRuntimeGraph(current), toNode),
      ]),
    );
    const nextDocument = {
      ...current,
      nodes: promotesOutput
        ? current.nodes.map((node) =>
          node.id === fromNode
            ? { ...node, outputs: [...node.outputs, fromOutput] }
            : node
        )
        : current.nodes,
      edges: [
        ...current.edges,
        { fromNode, fromOutput, toNode, toInput },
      ],
    };

    setConnectionWarning(null);
    editDocument(nextDocument, [{
      type: "add_edge",
      fromNode,
      fromOutput,
      toNode,
      toInput,
    }]);
    markNodesStale(staleNodeIds);
  }, [
    editDocument,
    getDocumentSnapshot,
    markNodesStale,
  ]);

  const handleDeleteEdges = useCallback((edgeIds: string[]) => {
    const current = getDocumentSnapshot().document;
    if (!current || getDocumentSnapshot().editingBlocked) return [];
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
    const staleNodeIds = Array.from(
      new Set(editableRemovedEdges.flatMap((edge) => [
        ...getNodeAndDescendants(runtimeGraph, edge.fromNode),
        ...getNodeAndDescendants(runtimeGraph, edge.toNode),
      ])),
    );
    const nextEdges = current.edges.filter((edge) =>
      !editableRemovedEdges.some((removedEdge) =>
        getEdgeId(removedEdge) === getEdgeId(edge)
      )
    );
    const affectedSourceNodeIds = new Set(
      editableRemovedEdges.map((edge) => edge.fromNode),
    );
    const documentWithNextEdges = { ...current, edges: nextEdges };
    const nextDocument = {
      ...current,
      nodes: current.nodes.map((node) =>
        affectedSourceNodeIds.has(node.id)
          ? {
            ...node,
            outputs: deriveRoutedOutputs(documentWithNextEdges, node.id),
            runtimeCode: undefined,
          }
          : node
      ),
      edges: nextEdges,
    };

    editDocument(
      nextDocument,
      editableRemovedEdges.map((edge) => ({
        type: "remove_edge",
        ...edge,
      })),
    );
    markNodesStale(staleNodeIds);
    return acceptedEdgeIds;
  }, [
    editDocument,
    getDocumentSnapshot,
    markNodesStale,
  ]);

  const commitDeleteNode = useCallback((nodeId: string) => {
    const current = getDocumentSnapshot().document;
    if (!current || getDocumentSnapshot().editingBlocked || isRunActive) return;
    if (!current.nodes.some((node) => node.id === nodeId)) return;
    if (hasCustomManagedDownstream(current, nodeId)) return;

    const descendants = getDescendants(toRuntimeGraph(current), nodeId);
    const shouldClearSelection = selectedNodeId === nodeId;
    const nextDocument = removeNodeAndIncidentEdges(current, nodeId);
    const staleNodeIds = new Set([
      ...descendants,
      ...getChangedOutputNodeIds(current, nextDocument),
    ]);

    editDocument(nextDocument, [{ type: "delete_node", nodeId }]);
    markNodesStale(staleNodeIds);
    forgetNodes([nodeId]);
    if (shouldClearSelection) {
      setSelectedNodeId(null);
    }
  }, [
    editDocument,
    getDocumentSnapshot,
    forgetNodes,
    markNodesStale,
    selectedNodeId,
    isRunActive,
  ]);

  const handleDeleteNode = useCallback((nodeId: string) => {
    const current = getDocumentSnapshot().document;
    if (!current || getDocumentSnapshot().editingBlocked || isRunActive) return;
    const node = current.nodes.find((item) => item.id === nodeId);
    if (!node || hasCustomManagedDownstream(current, nodeId)) return;

    setPendingNodeDeletion({
      nodeId,
      label: prettifyFunctionName(node.functionName),
      incidentEdgeCount: current.edges.filter((edge) =>
        edge.fromNode === nodeId || edge.toNode === nodeId
      ).length,
    });
  }, [getDocumentSnapshot, isRunActive]);

  const confirmDeleteNode = useCallback(() => {
    if (!pendingNodeDeletion) return;
    setPendingNodeDeletion(null);
    if (isRunActive) return;
    commitDeleteNode(pendingNodeDeletion.nodeId);
  }, [commitDeleteNode, isRunActive, pendingNodeDeletion]);

  const handleNodePositionChange = useCallback((
    nodeId: string,
    position: { x: number; y: number },
  ) => {
    const current = getDocumentSnapshot().document;
    if (!current || getDocumentSnapshot().editingBlocked) return;
    const node = current.nodes.find((item) => item.id === nodeId);
    if (!node || arePositionsEqual(node.position, position)) return;
    const nextDocument = {
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId ? { ...node, position } : node
      ),
    };

    editDocument(
      nextDocument,
      [{ type: "move_node", nodeId, position }],
      "metadata",
    );
  }, [editDocument, getDocumentSnapshot]);

  const handleAutoLayout = useCallback((
    dimensions: NodeDimensionsById,
  ) => {
    const current = getDocumentSnapshot().document;
    if (!current || getDocumentSnapshot().editingBlocked) return;
    const positions = createSimpleLayout(toRuntimeGraph(current), dimensions);
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

    editDocument(
      nextDocument,
      changedPositions.map(({ nodeId, position }) => ({
        type: "move_node",
        nodeId,
        position,
      })),
      "metadata",
    );
  }, [editDocument, getDocumentSnapshot]);

  function navigateToPythonError(target: PythonEditorErrorTarget) {
    if (target.editor === "node" && target.nodeId) {
      setSelectedNodeId(target.nodeId);
      setInspectorNavigationRequest((current) => ({
        target: "node_code",
        nodeId: target.nodeId!,
        requestId: (current?.requestId ?? 0) + 1,
      }));
      return;
    }

    setSelectedNodeId(null);
    setInspectorNavigationRequest((current) => ({
      target: "document_globals",
      requestId: (current?.requestId ?? 0) + 1,
    }));
  }

  function getCurrentPythonSourceForRun(): string | undefined {
    // TODO: When the UI owns raw Python source state, pass that string here so
    // dirty editor contents can run without first saving to disk.
    return undefined;
  }

  async function handleRunToNode(
    nodeId: string,
    options: { allowDuringImport?: boolean; trace?: boolean } = {},
  ) {
    const importBlocksRun = () =>
      importInFlightRef.current && !options.allowDuringImport;
    if (isRuntimeMaintenanceActive || importBlocksRun()) return;
    if (
      !editableGraph || !(await prepareForWrite({ savePending: true }))
    ) {
      return;
    }
    if (importBlocksRun()) return;
    const runSourceValue = executionSourceValueRef.current;

    const abortController = startRunAbortController();
    activeRunTypeRef.current = "run_to_node";
    markNodeExecutionRunning(nodeId, "run_to_node");
    runToNodeMutation.mutate({
      nodeId,
      source: getCurrentPythonSourceForRun(),
      expectedRevision: getDocumentSnapshot().revision,
      trace: options.trace ?? false,
      onEvent: (event) => applyExecutionStreamEvent(event, runSourceValue),
      signal: abortController.signal,
      abortController,
      sourceValue: runSourceValue,
    });
  }

  async function handleRunGraph(trace = false) {
    if (isRuntimeMaintenanceActive || importInFlightRef.current) return;
    if (
      !editableGraph || !(await prepareForWrite({ savePending: true }))
    ) {
      return;
    }
    if (importInFlightRef.current) return;
    const runSourceValue = executionSourceValueRef.current;

    if (selectedNodeId === null) {
      showInspectorTarget("run_result");
    }
    const abortController = startRunAbortController();
    activeRunTypeRef.current = "run_graph";
    markGraphExecutionRunning();
    runGraphMutation.mutate({
      source: getCurrentPythonSourceForRun(),
      expectedRevision: getDocumentSnapshot().revision,
      trace,
      onEvent: (event) => applyExecutionStreamEvent(event, runSourceValue),
      signal: abortController.signal,
      abortController,
      sourceValue: runSourceValue,
    });
  }

  function handleRunNotificationClick(notification: RunNotification) {
    const destination = notification.destination;
    if (destination.kind === "node") {
      setSelectedNodeId(destination.nodeId);
      setCanvasFocusRequest((current) => ({
        nodeId: destination.nodeId,
        requestId: (current?.requestId ?? 0) + 1,
      }));
      setInspectorNavigationRequest((current) => ({
        target: notification.tone === "danger" ? "node_code" : "node_results",
        nodeId: destination.nodeId,
        requestId: (current?.requestId ?? 0) + 1,
      }));
      dismissRunNotification(notification.id);
      return;
    }

    dismissRunNotification(notification.id);
    showInspectorTarget(
      destination.kind === "document_globals"
        ? "document_globals"
        : "run_result",
    );
  }

  const [saveAcknowledged, setSaveAcknowledged] = useState(false);
  const saveFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (saveFeedbackTimer.current) clearTimeout(saveFeedbackTimer.current);
  }, []);

  async function handleSaveDocument() {
    setSaveAcknowledged(false);
    if (saveFeedbackTimer.current) clearTimeout(saveFeedbackTimer.current);
    if (await saveDocument()) {
      setSaveAcknowledged(true);
      saveFeedbackTimer.current = setTimeout(
        () => setSaveAcknowledged(false),
        1600,
      );
    }
  }

  function showImportNotification(
    notification: Omit<ImportNotification, "id">,
  ) {
    importNotificationIdRef.current += 1;
    setImportNotification({
      ...notification,
      id: importNotificationIdRef.current,
    });
  }

  function showInspectorTarget(target: "document_globals" | "run_result") {
    setSelectedNodeId(null);
    setInspectorNavigationRequest((current) => ({
      target,
      requestId: (current?.requestId ?? 0) + 1,
    }));
  }

  function showNodeVariable(nodeId: string, variableName: string) {
    setSelectedNodeId(nodeId);
    setInspectorNavigationRequest((current) => ({
      target: "node_results",
      nodeId,
      variableName,
      requestId: (current?.requestId ?? 0) + 1,
    }));
  }

  return (
    <div
      className={[
        themeMode === "dark" ? "dark" : "",
        "flex h-screen min-h-0 flex-col bg-zinc-100 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-100",
      ].join(" ")}
    >
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 bg-white px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h1 className="shrink-0 text-sm font-semibold">Rowcall</h1>
          <span aria-hidden="true" className="text-zinc-400 dark:text-zinc-600">
            /
          </span>

          {externalDocumentNotice.kind === "updated" && (
            <span className="hidden shrink-0 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 md:inline-flex">
              Updated from disk
            </span>
          )}
          <span
            className="min-w-0 max-w-[30vw] truncate text-xs text-zinc-600 dark:text-zinc-400"
            title={documentPath}
          >
            {compactDocumentPath(documentPath)}
          </span>
          <PythonRuntimeBadge
            isLoading={pythonRuntimeQuery.isLoading}
            error={pythonRuntimeQuery.error}
            python={pythonRuntimeQuery.data?.python ?? null}
            documentPath={documentPath}
            environment={projectEnvironmentQuery.data?.environment ?? null}
            isRunActive={isRunActive || isRuntimeMaintenanceActive}
            isRestarting={restartRuntimeMutation.isPending}
            restartError={restartRuntimeMutation.error}
            onRestart={() => restartRuntimeMutation.mutate()}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              title={saveStatus === "outcome_unknown"
                ? "Save outcome unknown; reload from disk before running"
                : isRuntimeMaintenanceActive
                ? "Wait for Python environment maintenance to finish"
                : importingFileName
                ? "Wait for the file import to finish"
                : isRunActive
                ? "A run is already in progress"
                : "Run the full graph"}
              className="inline-flex h-8 items-center gap-1.5 rounded bg-zinc-900 px-3 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
              disabled={!editableGraph || isRunActive ||
                isRuntimeMaintenanceActive ||
                importingFileName !== null ||
                saveStatus === "outcome_unknown"}
              onClick={() => void handleRunGraph()}
            >
              <Play
                aria-hidden="true"
                className="h-4 w-4"
                strokeWidth={2.25}
              />
              {isRunActive ? "Running…" : "Run graph"}
            </button>
            <RunMenu
              chevron
              disabled={!editableGraph || isRunActive ||
                isRuntimeMaintenanceActive || importingFileName !== null ||
                saveStatus === "outcome_unknown"}
              onTrace={() => void handleRunGraph(true)}
            />
          </div>
          <button
            type="button"
            title={isReadOnlyDocument
              ? "Read-only"
              : saveStatus === "outcome_unknown"
              ? "Save outcome unknown; reload from disk before saving again"
              : "Save (Ctrl+S)"}
            className="inline-flex h-8 min-w-24 justify-center items-center gap-1.5 rounded px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-100 active:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
            disabled={!editableDocument || saveStatus === "saving" ||
              saveStatus === "outcome_unknown"}
            aria-label={isReadOnlyDocument ? "Read-only" : "Save"}
            onClick={handleSaveDocument}
          >
            {!isReadOnlyDocument && (
              saveAcknowledged && pendingOperationCount === 0
                ? <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
                : (
                  <Save
                    aria-hidden="true"
                    className="h-4 w-4"
                    strokeWidth={2.25}
                  />
                )
            )}
            {isReadOnlyDocument
              ? "Read-only"
              : saveStatus === "saving"
              ? "Saving..."
              : pendingOperationCount > 0
              ? "Save •"
              : saveAcknowledged
              ? "Saved"
              : "Save"}
          </button>
          <ActionMenu
            label="More options"
            actionLabel={themeMode === "dark"
              ? "Switch to light mode"
              : "Switch to dark mode"}
            disabled={false}
            onAction={() =>
              setThemeMode((current) => current === "dark" ? "light" : "dark")}
          />
        </div>
      </header>
      {(runNotification || importNotification) && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
          {importNotification && (
            <ImportNotificationCard
              notification={importNotification}
              onDismiss={() => setImportNotification(null)}
            />
          )}
          {runNotification && (
            <RunNotificationCard
              notification={runNotification}
              nodeLabelsById={graphInspectorDetails?.nodeLabelsById ?? {}}
              onOpen={() => handleRunNotificationClick(runNotification)}
              onDismiss={() => dismissRunNotification(runNotification.id)}
            />
          )}
        </div>
      )}
      {connectionWarning && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-5 py-2 text-sm text-amber-950 dark:border-amber-900/70 dark:bg-amber-950 dark:text-amber-100"
        >
          <p className="min-w-0 flex-1">
            <span className="font-medium">{connectionWarning.title}.</span>
            <span className="ml-2">{connectionWarning.detail}</span>
          </p>
          <button
            type="button"
            aria-label="Dismiss connection warning"
            title="Dismiss"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-amber-800 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-900"
            onClick={() => setConnectionWarning(null)}
          >
            <X aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
          </button>
        </div>
      )}
      {externalDocumentNotice.kind === "dirty" && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-5 py-2 text-sm text-amber-950 dark:border-amber-900/70 dark:bg-amber-950 dark:text-amber-100">
          <p className="min-w-0 flex-1">
            <span className="font-medium">Document changed on disk.</span>
            <span className="ml-2">
              Save and run are paused until you reload. Reloading will discard
              unsaved canvas changes{firstUnsavedEditAt
                ? ` from the last ${
                  formatElapsedDuration(Date.now() - firstUnsavedEditAt)
                }`
                : ""}.
            </span>
          </p>
          <button
            type="button"
            className="shrink-0 rounded border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-50 dark:hover:bg-amber-800"
            disabled={isExternalReloading}
            onClick={() => void handleReloadDocumentFromDisk()}
          >
            {isExternalReloading ? "Reloading..." : "Reload from disk"}
          </button>
        </div>
      )}
      {externalDocumentNotice.kind === "waiting_readable" && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-5 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          <p className="min-w-0 flex-1">
            <span className="font-medium">
              Document changed on disk. Waiting for it to become readable...
            </span>
            <span className="ml-2">
              Rowcall will keep checking and update when the file is valid.
            </span>
            {externalDocumentNotice.detail && (
              <span className="ml-2 text-zinc-500 dark:text-zinc-400">
                {externalDocumentNotice.detail}
              </span>
            )}
          </p>
          <button
            type="button"
            className="shrink-0 rounded border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
            disabled={isExternalReloading}
            onClick={() => void handleReloadDocumentFromDisk()}
          >
            {isExternalReloading ? "Checking..." : "Retry now"}
          </button>
        </div>
      )}
      {saveStatus === "error" && saveError && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-900">
          <p className="min-w-0 flex-1">
            <span className="font-medium">{saveError.title}</span>
            <span className="ml-2">{saveError.detail}</span>
          </p>
          {saveError.target
            ? (
              <button
                type="button"
                className="shrink-0 rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-800 hover:bg-red-100"
                onClick={() => navigateToPythonError(saveError.target!)}
              >
                Go to error
              </button>
            )
            : (
              <button
                type="button"
                className="shrink-0 rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={documentQuery.isFetching}
                onClick={() => void handleReloadDocumentFromDisk()}
              >
                {documentQuery.isFetching ? "Reloading..." : "Reload from disk"}
              </button>
            )}
        </div>
      )}
      {saveStatus === "outcome_unknown" && saveError && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-300 bg-red-50 px-5 py-2 text-sm text-red-950 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          <p className="min-w-0 flex-1">
            <span className="font-medium">{saveError.title}.</span>
            <span className="ml-2">{saveError.detail}</span>
          </p>
          <button
            type="button"
            className="shrink-0 rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-900 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-700 dark:bg-red-900 dark:text-red-50 dark:hover:bg-red-800"
            disabled={isExternalReloading}
            onClick={() => void handleReloadDocumentFromDisk()}
          >
            {isExternalReloading
              ? "Reloading..."
              : "Reload and inspect saved state"}
          </button>
        </div>
      )}
      {documentQuery.isSuccess && (
        <RuntimeEnvironmentNotice
          environment={projectEnvironmentQuery.data?.environment ?? null}
          isRunActive={isRunActive || isRuntimeMaintenanceActive}
          isSyncing={syncEnvironmentMutation.isPending}
          syncError={syncEnvironmentMutation.error}
          onSync={() => syncEnvironmentMutation.mutate()}
        />
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
          <div className="h-full min-h-0">
            <WorkspaceSplit
              vertical
              storageKey="graph-height"
              initial={36}
              label="Resize inspector"
              focused={inspectorFocused}
              first={
                <div className="relative h-full min-h-0 min-w-0">
                  <Canvas
                    key={documentCanvasKey}
                    graph={editableGraph}
                    selectedNodeId={selectedNodeId}
                    focusNodeRequest={canvasFocusRequest}
                    nodeRunStatuses={nodeRunStatuses}
                    nodePreviews={nodePreviews}
                    nodeInputPreviews={nodeInputPreviews}
                    nodeOutputOptions={nodeOutputOptions}
                    onAddNode={canEditStructure ? handleAddNode : undefined}
                    onImportFiles={handleImportFiles}
                    onImportDirectoryRejected={handleImportDirectoryRejected}
                    importingFileName={importingFileName}
                    onAutoLayout={canEditStructure
                      ? handleAutoLayout
                      : undefined}
                    onAddChildNode={canEditStructure
                      ? handleAddChildNode
                      : undefined}
                    onConnectNodes={canEditStructure
                      ? handleConnectNodes
                      : undefined}
                    onDeleteEdges={canEditStructure
                      ? handleDeleteEdges
                      : undefined}
                    onDeleteNode={canEditStructure
                      ? handleDeleteNode
                      : undefined}
                    onNodePositionChange={editingBlocked
                      ? undefined
                      : handleNodePositionChange}
                    onNodeSelect={setSelectedNodeId}
                    onOutputsChange={canEditOutputs
                      ? handleOutputsChange
                      : undefined}
                    onRunToNode={handleRunToNode}
                    onVariableSelect={showNodeVariable}
                    onSaveDocument={handleSaveDocument}
                    outputsReadOnly={!canEditOutputs}
                    runToNodeDisabled={isRunActive ||
                      isRuntimeMaintenanceActive ||
                      importingFileName !== null ||
                      isSelectedNodeRunning ||
                      saveStatus === "outcome_unknown"}
                    onSelectionClear={() => setSelectedNodeId(null)}
                    themeMode={themeMode}
                  />
                  <ShortcutHintPanel />
                </div>
              }
              second={
                <InspectorPanel
                  focused={inspectorFocused}
                  onToggleFocus={() =>
                    setInspectorFocused((current) => !current)}
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
                  isRunActive={isRunActive || isRuntimeMaintenanceActive ||
                    importingFileName !== null}
                  readOnly={!canEditOutputs}
                  onNodeSelect={setSelectedNodeId}
                  onCodeChange={handleCodeChange}
                  onNodeNameChange={handleNodeNameChange}
                  onNodeMetadataChange={handleNodeMetadataChange}
                  onGlobalsCodeChange={handleGlobalsCodeChange}
                  onDeleteNode={canEditStructure ? handleDeleteNode : undefined}
                  onRunToNode={handleRunToNode}
                  onSelectionClear={() => setSelectedNodeId(null)}
                  actionsBlocked={saveStatus === "outcome_unknown"}
                  navigationRequest={inspectorNavigationRequest}
                  pythonEditorError={saveError?.target}
                  onShowDocumentGlobals={() =>
                    showInspectorTarget("document_globals")}
                />
              }
            />
          </div>
        )}
      </main>
      {pendingNodeDeletion && (
        <DeleteNodeDialog
          deletion={pendingNodeDeletion}
          onCancel={() => setPendingNodeDeletion(null)}
          onConfirm={confirmDeleteNode}
        />
      )}
    </div>
  );
}

function DeleteNodeDialog({
  deletion,
  onCancel,
  onConfirm,
}: {
  deletion: {
    nodeId: string;
    label: string;
    incidentEdgeCount: number;
  };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialogRef.current?.showModal();
    cancelButtonRef.current?.focus();
    return () => {
      if (dialogRef.current?.open) {
        dialogRef.current.close();
      }
      if (
        previouslyFocused instanceof HTMLElement &&
        previouslyFocused.isConnected
      ) {
        previouslyFocused.focus();
      }
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="delete-node-title"
      aria-describedby="delete-node-description"
      className="m-auto w-[min(28rem,calc(100vw-2rem))] max-w-none rounded-lg bg-transparent p-0 backdrop:bg-black/45"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onMouseDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom
        ) {
          onCancel();
        }
      }}
      onKeyDown={(event) => {
        if (
          !event.repeat && !event.metaKey && !event.ctrlKey &&
          !event.altKey &&
          (event.key === "Delete" || event.key === "Backspace")
        ) {
          event.preventDefault();
          event.stopPropagation();
          onConfirm();
        }
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-5 text-zinc-950 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
        <h2 id="delete-node-title" className="text-base font-semibold">
          Delete “{deletion.label}”?
        </h2>
        <p
          id="delete-node-description"
          className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300"
        >
          This removes the node
          {deletion.incidentEdgeCount > 0
            ? ` and ${
              deletion.incidentEdgeCount === 1
                ? "its connection"
                : `its ${deletion.incidentEdgeCount} connections`
            }`
            : ""}. Press Delete again to confirm.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelButtonRef}
            type="button"
            className="rounded border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded border border-red-700 bg-red-700 px-3 py-2 text-sm font-medium text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900"
            onClick={onConfirm}
          >
            Delete node
          </button>
        </div>
      </div>
    </dialog>
  );
}

function RunNotificationCard({
  notification,
  nodeLabelsById,
  onOpen,
  onDismiss,
}: {
  notification: RunNotification;
  nodeLabelsById: Record<string, string>;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const isDanger = notification.tone === "danger";
  const summary = getRunNotificationSummary(notification, nodeLabelsById);

  return (
    <div
      role={isDanger ? "alert" : "status"}
      aria-live={isDanger ? "assertive" : "polite"}
      className={[
        "flex w-[min(20rem,calc(100vw-2rem))] items-start overflow-hidden rounded-md border shadow-lg",
        isDanger
          ? "border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
          : "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100",
      ].join(" ")}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left hover:bg-black/5 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-current"
        aria-label={`${notification.title}. ${summary}. ${
          isDanger ? "View error details" : "View run details"
        }`}
        onClick={onOpen}
      >
        {isDanger
          ? (
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0"
              strokeWidth={2.25}
            />
          )
          : (
            <CheckCircle2
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0"
              strokeWidth={2.25}
            />
          )}
        <span className="min-w-0">
          <span className="block text-sm font-semibold">
            {notification.title}
          </span>
          <span className="block truncate text-xs opacity-80">{summary}</span>
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss run notification"
        title="Dismiss"
        className="m-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-black/10 focus:outline-none focus:ring-2 focus:ring-current"
        onClick={onDismiss}
      >
        <X aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
      </button>
    </div>
  );
}

function ImportNotificationCard({
  notification,
  onDismiss,
}: {
  notification: ImportNotification;
  onDismiss: () => void;
}) {
  const isDanger = notification.tone === "danger";
  const isWarning = notification.tone === "warning";
  const toneClass = isDanger
    ? "border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
    : isWarning
    ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    : "border-blue-300 bg-blue-50 text-blue-950 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100";

  return (
    <div
      role={isDanger ? "alert" : "status"}
      aria-live={isDanger ? "assertive" : "polite"}
      className={[
        "flex w-[min(22rem,calc(100vw-2rem))] items-start overflow-hidden rounded-md border shadow-lg",
        toneClass,
      ].join(" ")}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5">
        {isDanger || isWarning
          ? (
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0"
              strokeWidth={2.25}
            />
          )
          : (
            <FileUp
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0"
              strokeWidth={2.25}
            />
          )}
        <span className="min-w-0">
          <span className="block text-sm font-semibold">
            {notification.title}
          </span>
          <span className="mt-0.5 block text-xs leading-4 opacity-80">
            {notification.detail}
          </span>
        </span>
      </div>
      <button
        type="button"
        aria-label="Dismiss import notification"
        title="Dismiss"
        className="m-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-black/10 focus:outline-none focus:ring-2 focus:ring-current"
        onClick={onDismiss}
      >
        <X aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
      </button>
    </div>
  );
}

function ShortcutHintPanel() {
  return (
    <DismissibleDetails className="absolute bottom-3 right-3 z-10 max-w-[90%] rounded bg-white/95 px-3 py-2 text-[11px] text-zinc-500 shadow-sm dark:bg-zinc-900/95 dark:text-zinc-400">
      <summary className="cursor-pointer font-medium">Shortcuts</summary>
      <div className="mt-2 flex flex-wrap items-center gap-y-2">
        <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 font-mono text-[10px] text-zinc-700">
          Shift+Enter
        </kbd>
        <span className="mx-1">run through step</span>
        <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 font-mono text-[10px] text-zinc-700">
          A
        </kbd>
        <span className="mx-1">add nearby node</span>
        <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 font-mono text-[10px] text-zinc-700">
          Ctrl+S
        </kbd>
        <span className="mx-1">save</span>
        <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 font-mono text-[10px] text-zinc-700">
          Delete
        </kbd>
        <span className="ml-1">delete selection</span>
      </div>
    </DismissibleDetails>
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
  return `${runtimeEnvironmentLabel(python)} ${python.version}`;
}

function runtimeEnvironmentLabel(python: PythonRuntime): string {
  if (python.runtimeMode === "managed") return "Project Python";
  if (python.condaPrefix) return `Conda ${environmentName(python.condaPrefix)}`;
  if (python.virtualEnv) return "Venv Python";
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
  environment,
  isRunActive,
  isRestarting,
  restartError,
  onRestart,
}: {
  python: PythonRuntime | null;
  isLoading: boolean;
  error: Error | null;
  documentPath: string;
  environment: ProjectEnvironmentInfo | null;
  isRunActive: boolean;
  isRestarting: boolean;
  restartError: Error | null;
  onRestart: () => void;
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
    `Python: ${python.executable}`,
    `Document: ${documentPath}`,
  ].join("\n");

  return (
    <DismissibleDetails className="group relative hidden md:block">
      <summary
        className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-1.5 text-xs text-zinc-500 hover:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:text-zinc-400 dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden"
        title={title}
      >
        <span>{runtimeLabel}</span>
      </summary>
      <div className="absolute left-0 z-30 mt-2 w-[min(34rem,calc(100vw-2rem))] rounded border border-zinc-200 bg-white p-3 text-xs text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
        <div className="mb-2 flex items-center justify-between gap-3 border-b border-zinc-200 pb-2 dark:border-zinc-700">
          <span className="font-semibold">Runtime Details</span>
        </div>
        <RuntimeDetail label="Document" value={documentPath} />
        <RuntimeDetail label="Python" value={python.executable} />
        <RuntimeDetail label="Version" value={python.version} />
        {environment && (
          <RuntimeDetail
            label="Requirements"
            value={environment.requirementsStatus === "unknown"
              ? "Not tracked"
              : environment.requirementsStatus === "changed"
              ? "Sync needed"
              : environment.requirementsPresent
              ? "Requirements unchanged"
              : "No requirements file"}
            tone={environment.requirementsStatus === "changed"
              ? "warning"
              : "default"}
          />
        )}
        <details className="mt-2">
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Advanced
          </summary>
          <div className="mt-2">
            {python.condaPrefix && (
              <RuntimeDetail label="Conda" value={python.condaPrefix} />
            )}
            {python.virtualEnv && (
              <RuntimeDetail label="Venv" value={python.virtualEnv} />
            )}
            <RuntimeDetail
              label="rowcall"
              value={python.rowcallImport.ok
                ? python.rowcallImport.path ?? "importable"
                : python.rowcallImport.error ?? "not importable"}
              tone={python.rowcallImport.ok ? "default" : "warning"}
            />
          </div>
        </details>
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
          {restartError && (
            <span
              role="alert"
              className="min-w-0 text-red-600 dark:text-red-400"
            >
              {restartError.message}
            </span>
          )}
          <button
            type="button"
            className="shrink-0 rounded border border-zinc-300 bg-white px-2.5 py-1 font-medium text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
            disabled={isRunActive || isRestarting}
            title={isRunActive
              ? "Wait for the active run to finish before restarting Python"
              : "Replace the Python process without restarting Rowcall."}
            onClick={onRestart}
          >
            {isRestarting ? "Restarting..." : "Restart Python"}
          </button>
        </div>
      </div>
    </DismissibleDetails>
  );
}

function RuntimeEnvironmentNotice({
  environment,
  isRunActive,
  isSyncing,
  syncError,
  onSync,
}: {
  environment: ProjectEnvironmentInfo | null;
  isRunActive: boolean;
  isSyncing: boolean;
  syncError: Error | null;
  onSync: () => void;
}) {
  const updateAvailable = environment?.canSync &&
    environment.requirementsStatus === "changed";
  const relevantSyncError = updateAvailable ? syncError : null;
  if (!updateAvailable && !relevantSyncError) {
    return null;
  }

  const error = relevantSyncError;
  const message = error
    ? error.message
    : "requirements.txt changed. Updating will restart Python and clear current results.";

  return (
    <section
      className={[
        "border-b px-5 py-2 text-xs",
        error
          ? "border-red-200 bg-red-50 text-red-900 dark:border-red-900/70 dark:bg-red-950 dark:text-red-100"
          : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/70 dark:bg-amber-950 dark:text-amber-100",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-h-28 min-w-0 flex-1 overflow-auto whitespace-pre-wrap">
          {message}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {updateAvailable && (
            <button
              type="button"
              className="rounded border border-amber-300 bg-white px-2.5 py-1 font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-50 dark:hover:bg-amber-800"
              disabled={isRunActive || isSyncing}
              title={isRunActive
                ? "Wait for the active run to finish before updating dependencies"
                : undefined}
              onClick={onSync}
            >
              {isSyncing
                ? "Updating..."
                : syncError
                ? "Retry update"
                : "Update environment"}
            </button>
          )}
        </div>
      </div>
    </section>
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
    isPythonLoading || (!pythonError && (!python || python.rowcallImport.ok))
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
              label="rowcall"
              value={python.rowcallImport.error ?? "not importable"}
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

function formatElapsedDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
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
        displays: [],
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
      displays: [],
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
      ? Object.entries(result.variables).map(([name, variable]) => ({
        name: variable.name || name,
        type: variable.type,
        table: variable.table,
      }))
      : [],
    displays: result.displays.map((display) => ({
      name: display.name,
      type: display.type,
    })),
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error ?? null,
  };

  if (
    preview.outputs.length === 0 &&
    preview.displays.length === 0 &&
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
  nodeRunStatuses: Record<string, NodeRunVisualStatus>,
): Record<string, Array<{ name: string; type?: string }>> {
  return Object.fromEntries(
    graph.nodes.map((node) => [
      node.id,
      getNodeInputGroups(
        graph,
        node.id,
        executionStateByNodeId,
        nodeRunStatuses,
      )
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
  nodeRunStatuses: Record<string, NodeRunVisualStatus>,
): Array<{
  nodeId: string;
  label: string;
  values: Record<string, ValuePreview | null>;
  status: NodeRunVisualStatus;
}> {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const routesByUpstream = new Map<
    string,
    RuntimeGraph["edges"]
  >();
  for (const edge of graph.edges) {
    if (edge.toNode !== nodeId) continue;
    const routes = routesByUpstream.get(edge.fromNode) ?? [];
    routes.push(edge);
    routesByUpstream.set(edge.fromNode, routes);
  }

  return Array.from(routesByUpstream, ([upstreamId, routes]) => {
    const upstream = nodesById.get(upstreamId);
    if (!upstream) return null;
    const upstreamOutputs = getOutputPreviewsForNode(
      upstream.id,
      executionStateByNodeId,
    );
    return {
      nodeId: upstream.id,
      label: getNodeDisplayTitle(upstream),
      values: Object.fromEntries(
        routes.map((edge) => [
          edge.toInput,
          upstreamOutputs[edge.fromOutput] ?? null,
        ]),
      ),
      status: nodeRunStatuses[upstream.id] ?? "idle",
    };
  }).filter((group) => group !== null);
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

function getVariablePreviewsForNode(
  nodeId: string,
  executionStateByNodeId: Record<string, ExecutionDisplayState>,
): Record<string, ValuePreview> {
  const state = executionStateByNodeId[nodeId];
  if (!state) {
    return {};
  }

  if (state.status === "completed_node" || state.status === "failed_node") {
    return state.result.variables;
  }

  if (state.status === "completed") {
    return state.response.resultsByNode[nodeId]?.variables ?? {};
  }

  return {};
}

function getNodeDisplayTitle(node: RuntimeNode): string {
  return prettifyFunctionName(node.functionName);
}

function createConnectionWarning(
  document: RowcallDocumentV1,
  fromNode: string,
  fromOutput: string,
  toNode: string,
): ConnectionWarning {
  const labelsById = Object.fromEntries(
    document.nodes.map((node) => [node.id, getNodeDisplayTitle(node)]),
  );
  const sourceLabel = labelsById[fromNode] ?? fromNode;
  const targetLabel = labelsById[toNode] ?? toNode;

  return {
    title: `Couldn’t connect ${sourceLabel} to ${targetLabel}`,
    detail:
      `The input "${fromOutput}" already has a route. Remove that route before connecting a different value.`,
  };
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
  routedOutputs: string[],
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

  for (const name of routedOutputs) {
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
