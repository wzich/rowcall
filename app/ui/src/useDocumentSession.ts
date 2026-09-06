import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyDocumentOperations,
  type DocumentOperation,
  loadDocument,
  loadDocumentStatus,
  type LoadDocumentSuccess,
} from "./api/documents.ts";
import { coalesceDocumentOperations } from "./documentOperations.ts";
import {
  canApplyLoadedDocument,
  shouldAutoReloadDocument,
  shouldPreserveExecutionSessionOnReload,
} from "./documentReload.ts";
import {
  formatSaveError,
  type PythonEditorErrorTarget,
  type SaveErrorMessage,
} from "./documentSaveError.ts";
import type { RowcallDocumentV1 } from "./graph/documentTypes.ts";
import { toReactFlowGraph } from "./graph/toReactFlow.ts";
import { classifySaveFailure } from "./saveOutcome.ts";

const documentStatusPollIntervalMs = 4_000;
const invalidExternalDocumentGraceMs = 4_000;
const updatedFromDiskNoticeMs = 3_500;

type ExternalDocumentNotice =
  | { kind: "idle" }
  | { kind: "dirty"; detectedAt: number }
  | { kind: "waiting_readable"; detectedAt: number; detail?: string }
  | { kind: "updated"; updatedAt: number };

type DocumentSessionCallbacks = {
  onLoaded: (
    document: RowcallDocumentV1,
    preserveExecutionSession: boolean,
  ) => void;
  onExecutionEdit: () => void;
  onPythonError: (target: PythonEditorErrorTarget) => void;
};

export function useDocumentSession(callbacks: DocumentSessionCallbacks) {
  // Callback identity must not reload the document or replace an unsaved draft.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const [editableDocument, setEditableDocument] = useState<
    RowcallDocumentV1 | null
  >(null);
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error" | "outcome_unknown"
  >("idle");
  const [saveError, setSaveError] = useState<SaveErrorMessage | null>(null);
  const [documentPath, setDocumentPath] = useState("Active document");
  const [pendingOperationCount, setPendingOperationCount] = useState(0);
  const [firstUnsavedEditAt, setFirstUnsavedEditAt] = useState<number | null>(
    null,
  );
  const [isExternalReloading, setIsExternalReloading] = useState(false);
  const [externalDocumentNotice, setExternalDocumentNotice] = useState<
    ExternalDocumentNotice
  >({ kind: "idle" });
  const editGenerationRef = useRef(0);
  const editableDocumentRef = useRef<RowcallDocumentV1 | null>(null);
  const baseRevisionRef = useRef("");
  const baseSourceRevisionRef = useRef("");
  const saveOutcomeUnknownRef = useRef(false);
  const firstUnsavedEditAtRef = useRef<number | null>(null);
  const invalidExternalDocumentSinceRef = useRef<number | null>(null);
  const isReloadingExternalDocumentRef = useRef(false);
  const pendingOperationsRef = useRef<DocumentOperation[]>([]);
  const flushPromiseRef = useRef<Promise<boolean> | null>(null);
  const saveAttemptGenerationRef = useRef(0);
  const documentQuery = useQuery({
    queryKey: ["rowcall-document", "active"],
    queryFn: loadDocument,
    refetchOnWindowFocus: false,
  });
  const documentStatusQuery = useQuery({
    queryKey: ["rowcall-document-status", "active"],
    queryFn: loadDocumentStatus,
    enabled: documentQuery.isSuccess,
    refetchInterval: documentStatusPollIntervalMs,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const refetchStatus = documentStatusQuery.refetch;

  const applyLoadedDocument = useCallback(
    (
      loaded: LoadDocumentSuccess,
      options: { preserveExecutionSession?: boolean } = {},
    ) => {
      const graph = loaded.document;
      setDocumentPath(loaded.path);
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
      callbacksRef.current.onLoaded(
        graph,
        Boolean(options.preserveExecutionSession),
      );
      baseRevisionRef.current = graph.revision ?? "";
      baseSourceRevisionRef.current = loaded.sourceRevision;
      pendingOperationsRef.current = [];
      setPendingOperationCount(0);
      firstUnsavedEditAtRef.current = null;
      setFirstUnsavedEditAt(null);
      invalidExternalDocumentSinceRef.current = null;
      setSaveStatus("idle");
      saveOutcomeUnknownRef.current = false;
      setSaveError(null);
      editGenerationRef.current = 0;
    },
    [],
  );

  useEffect(() => {
    if (!documentQuery.isSuccess) {
      return;
    }

    applyLoadedDocument(documentQuery.data);
  }, [applyLoadedDocument, documentQuery.data, documentQuery.isSuccess]);

  const editDocument = useCallback((
    nextDocument: RowcallDocumentV1,
    operations: DocumentOperation[],
    impact: "execution" | "metadata" = "execution",
  ) => {
    if (saveOutcomeUnknownRef.current) return;
    if (impact === "execution") callbacksRef.current.onExecutionEdit();
    if (firstUnsavedEditAtRef.current === null) {
      const now = Date.now();
      firstUnsavedEditAtRef.current = now;
      setFirstUnsavedEditAt(now);
    }
    editGenerationRef.current += 1;
    for (const operation of operations) {
      pendingOperationsRef.current = coalesceDocumentOperations([
        ...pendingOperationsRef.current,
        operation,
      ]);
    }
    setPendingOperationCount(pendingOperationsRef.current.length);
    if (pendingOperationsRef.current.length === 0) {
      firstUnsavedEditAtRef.current = null;
      setFirstUnsavedEditAt(null);
    }
    setSaveStatus("idle");
    setSaveError(null);
    editableDocumentRef.current = nextDocument;
    setEditableDocument(nextDocument);
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
    const editGeneration = editGenerationRef.current;

    pendingOperationsRef.current = [];
    saveAttemptGenerationRef.current += 1;
    setSaveStatus("saving");
    setSaveError(null);

    const promise = applyDocumentOperations(
      baseRevision,
      operations,
    )
      .then((result) => {
        setDocumentPath(result.path);
        baseRevisionRef.current = result.document.revision ?? "";
        baseSourceRevisionRef.current = result.sourceRevision;
        if (editGeneration === editGenerationRef.current) {
          editableDocumentRef.current = result.document;
          setEditableDocument(result.document);
          setSaveStatus("saved");
        } else if (pendingOperationsRef.current.length > 0) {
          setSaveStatus("idle");
        } else {
          setSaveStatus("saved");
        }
        setPendingOperationCount(pendingOperationsRef.current.length);
        if (pendingOperationsRef.current.length === 0) {
          firstUnsavedEditAtRef.current = null;
          setFirstUnsavedEditAt(null);
        }
        void refetchStatus();
        return pendingOperationsRef.current.length === 0;
      })
      .catch((error) => {
        pendingOperationsRef.current = coalesceDocumentOperations([
          ...operations,
          ...pendingOperationsRef.current,
        ]);
        setPendingOperationCount(pendingOperationsRef.current.length);
        if (classifySaveFailure(error) === "unknown_outcome") {
          saveOutcomeUnknownRef.current = true;
          setSaveStatus("outcome_unknown");
          setSaveError({
            title: "Save outcome unknown",
            detail:
              "Rowcall lost confirmation of the save and cannot safely tell whether it committed. Save and run are blocked. Reload from disk to inspect the actual saved state; reloading discards the local canvas edits shown here.",
          });
        } else {
          const formattedError = formatSaveError(error, operations);
          setSaveStatus("error");
          setSaveError(formattedError);
          if (formattedError.target) {
            callbacksRef.current.onPythonError(formattedError.target);
          }
        }
        return false;
      })
      .finally(() => {
        flushPromiseRef.current = null;
      });

    flushPromiseRef.current = promise;
    return await promise;
  }, [refetchStatus]);

  useEffect(() => {
    if (
      pendingOperationCount === 0 && saveStatus !== "outcome_unknown"
    ) {
      return;
    }

    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", warnBeforeUnload);
    return () =>
      globalThis.removeEventListener("beforeunload", warnBeforeUnload);
  }, [pendingOperationCount, saveStatus]);

  async function reloadDocumentFromDisk(
    options: { showUpdatedNotice?: boolean } = {},
  ): Promise<boolean> {
    if (isReloadingExternalDocumentRef.current) {
      return false;
    }

    if (flushPromiseRef.current) {
      setExternalDocumentNotice({
        kind: "dirty",
        detectedAt: Date.now(),
      });
      return false;
    }

    const started = {
      editGeneration: editGenerationRef.current,
      pendingOperationCount: pendingOperationsRef.current.length,
      saveAttemptGeneration: saveAttemptGenerationRef.current,
    };
    const startedPendingOperations = [...pendingOperationsRef.current];
    isReloadingExternalDocumentRef.current = true;
    setIsExternalReloading(true);
    try {
      const loaded = await loadDocument();

      if (
        !canApplyLoadedDocument(
          started,
          {
            editGeneration: editGenerationRef.current,
            pendingOperationCount: pendingOperationsRef.current.length,
            saveAttemptGeneration: saveAttemptGenerationRef.current,
            saveInFlight: flushPromiseRef.current !== null,
          },
        )
      ) {
        setExternalDocumentNotice({
          kind: "dirty",
          detectedAt: Date.now(),
        });
        return false;
      }

      applyLoadedDocument(loaded, {
        preserveExecutionSession: shouldPreserveExecutionSessionOnReload({
          currentSourceRevision: baseSourceRevisionRef.current,
          loadedSourceRevision: loaded.sourceRevision,
          pendingOperations: startedPendingOperations,
        }),
      });
      invalidExternalDocumentSinceRef.current = null;
      setExternalDocumentNotice(
        options.showUpdatedNotice
          ? { kind: "updated", updatedAt: Date.now() }
          : { kind: "idle" },
      );
      return true;
    } catch (error) {
      setExternalDocumentNotice({
        kind: "waiting_readable",
        detectedAt: Date.now(),
        detail: error instanceof Error ? error.message : undefined,
      });
      return false;
    } finally {
      isReloadingExternalDocumentRef.current = false;
      setIsExternalReloading(false);
    }
  }

  async function ensureDocumentFreshForWrite(): Promise<boolean> {
    if (saveOutcomeUnknownRef.current) {
      return false;
    }

    const result = await refetchStatus();
    if (!result.isSuccess) {
      setExternalDocumentNotice({
        kind: "waiting_readable",
        detectedAt: Date.now(),
        detail: result.error instanceof Error
          ? result.error.message
          : undefined,
      });
      return false;
    }

    const status = result.data.status;
    if (!status.valid || !status.revision) {
      setExternalDocumentNotice({
        kind: "waiting_readable",
        detectedAt: Date.now(),
        detail: status.issues[0]?.message,
      });
      return false;
    }

    if (status.revision === baseRevisionRef.current) {
      baseSourceRevisionRef.current = status.sourceRevision;
      return true;
    }

    if (pendingOperationsRef.current.length > 0) {
      setExternalDocumentNotice({
        kind: "dirty",
        detectedAt: Date.now(),
      });
      return false;
    }

    await reloadDocumentFromDisk({ showUpdatedNotice: true });
    return false;
  }

  useEffect(() => {
    const status = documentStatusQuery.data?.status;
    if (!documentQuery.isSuccess || !status) {
      return;
    }
    if (isReloadingExternalDocumentRef.current) {
      return;
    }

    if (status.valid && status.revision) {
      invalidExternalDocumentSinceRef.current = null;
      if (status.revision === baseRevisionRef.current) {
        baseSourceRevisionRef.current = status.sourceRevision;
        setExternalDocumentNotice((current) =>
          current.kind === "dirty" || current.kind === "waiting_readable"
            ? { kind: "idle" }
            : current
        );
        return;
      }

      if (
        shouldAutoReloadDocument({
          pendingOperationCount: pendingOperationsRef.current.length,
          saveInFlight: flushPromiseRef.current !== null,
          saveOutcomeUnknown: saveOutcomeUnknownRef.current,
        })
      ) {
        void reloadDocumentFromDisk({ showUpdatedNotice: true });
        return;
      }

      setExternalDocumentNotice((current) =>
        current.kind === "dirty"
          ? current
          : { kind: "dirty", detectedAt: Date.now() }
      );
      return;
    }

    const now = Date.now();
    if (invalidExternalDocumentSinceRef.current === null) {
      invalidExternalDocumentSinceRef.current = now;
      return;
    }

    if (
      now - invalidExternalDocumentSinceRef.current >=
        invalidExternalDocumentGraceMs
    ) {
      setExternalDocumentNotice({
        kind: "waiting_readable",
        detectedAt: invalidExternalDocumentSinceRef.current,
        detail: status.issues[0]?.message,
      });
    }
  }, [
    documentQuery.isSuccess,
    documentStatusQuery.data?.status,
  ]);
  useEffect(() => {
    if (externalDocumentNotice.kind !== "updated") {
      return;
    }

    const timeoutId = setTimeout(() => {
      setExternalDocumentNotice((current) =>
        current.kind === "updated" &&
          current.updatedAt === externalDocumentNotice.updatedAt
          ? { kind: "idle" }
          : current
      );
    }, updatedFromDiskNoticeMs);

    return () => clearTimeout(timeoutId);
  }, [externalDocumentNotice]);
  // Async callers read current state after awaits rather than a render's snapshot.
  const getSnapshot = useCallback(() => ({
    document: editableDocumentRef.current,
    editingBlocked: saveOutcomeUnknownRef.current,
    hasUnsavedWork: pendingOperationsRef.current.length > 0 ||
      flushPromiseRef.current !== null,
    editGeneration: editGenerationRef.current,
    revision: baseRevisionRef.current,
  }), []);

  const waitForActiveSave = useCallback(
    async () => flushPromiseRef.current ? await flushPromiseRef.current : true,
    [],
  );

  async function prepareForWrite(options: { savePending?: boolean } = {}) {
    if (!(await ensureDocumentFreshForWrite())) return false;
    return options.savePending ? await flushPendingOperations() : true;
  }

  async function saveDocument() {
    if (
      !editableDocumentRef.current || flushPromiseRef.current ||
      saveOutcomeUnknownRef.current
    ) return;
    await prepareForWrite({ savePending: true });
  }

  return {
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
    getSnapshot,
    waitForActiveSave,
    prepareForWrite,
    saveDocument,
    reloadDocument: () => reloadDocumentFromDisk(),
  };
}
