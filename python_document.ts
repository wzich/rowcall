import {
  type DocumentOperation,
  type GraphPosition,
  type RowcallDocumentV1,
} from "./document.ts";
import type { ValidationIssue } from "./types.ts";
import {
  PythonWorkerClient,
  type PythonWorkerEvent,
} from "./python_worker_client.ts";

export type LoadPythonDocumentResult =
  | { ok: true; document: RowcallDocumentV1; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

export type ApplyPythonDocumentOperationsResult =
  | { ok: true; document: RowcallDocumentV1; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

export type PythonDocumentStatus = {
  path: string;
  revision?: string;
  sourceRevision: string;
  sidecarRevision: string;
  valid: boolean;
  issues: ValidationIssue[];
  checkedAt: string;
};

type PythonDocumentFileSnapshot = {
  path: string;
  source: string;
  sidecar: SidecarDocumentMetadata;
};

class DocumentReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DocumentReadError";
  }
}

class StaleDocumentWriteError extends Error {
  constructor() {
    super("The Python document changed while the save was being prepared.");
    this.name = "StaleDocumentWriteError";
  }
}

class DocumentAliasChangedAfterCommitError extends Error {
  constructor() {
    super(
      "The active document or sidecar path changed after files may have been committed.",
    );
    this.name = "DocumentAliasChangedAfterCommitError";
  }
}

type PathAliasIdentity = {
  requestedPath: string;
  exists: boolean;
  targetResolved: boolean;
  targetPath: string;
};

type DocumentAliasBindings = {
  source: PathAliasIdentity & { exists: true };
  sidecar: PathAliasIdentity;
};

let beforeDocumentPublishForTests: (() => void | Promise<void>) | null = null;
let beforeSidecarPublishForTests: (() => void | Promise<void>) | null = null;
let beforeDocumentWriteForTests: (() => void | Promise<void>) | null = null;

export function setBeforeDocumentPublishForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  beforeDocumentPublishForTests = hook;
}

export function setBeforeSidecarPublishForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  beforeSidecarPublishForTests = hook;
}

export function setBeforeDocumentWriteForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  beforeDocumentWriteForTests = hook;
}

let documentOperationChain: Promise<void> = Promise.resolve();
const documentStatusCache = new Map<string, PythonDocumentStatus>();

export async function loadPythonDocument(
  path: string,
): Promise<LoadPythonDocumentResult> {
  const worker = new PythonWorkerClient();
  try {
    const snapshot = await readPythonDocumentSnapshot(path);
    const event = await worker.requestFinalEvent("inspect_source", {
      source: snapshot.source,
      documentPath: snapshot.path,
    });
    if (event.type === "error") {
      return {
        ok: false,
        issues: workerValidationIssues(
          event,
          "Python worker document load failed",
        ),
      };
    }

    if (event.type !== "inspect_source_completed") {
      return {
        ok: false,
        issues: [{
          kind: "invalid_python",
          message:
            `Python worker returned unexpected document event: ${event.type}`,
        }],
      };
    }

    if (event.ok === false) {
      return {
        ok: false,
        issues: workerValidationIssues(
          event,
          "Python worker document load failed",
        ),
      };
    }

    if (!isRowcallDocument(event["document"])) {
      return {
        ok: false,
        issues: [{
          kind: "invalid_python",
          message: "Python worker document load returned an invalid document",
        }],
      };
    }

    const documentWithSidecar = await applySidecarMetadata(
      event["document"],
      snapshot.sidecar,
    );
    return { ok: true, document: documentWithSidecar, issues: [] };
  } catch (error) {
    return {
      ok: false,
      issues: [documentLoadIssue(error)],
    };
  } finally {
    await worker.shutdown();
  }
}

/**
 * Gives an external document read a causal position after every document
 * operation that was already enqueued when this function was called.
 * Save-internal inspection must use loadPythonDocument directly to avoid
 * waiting on the operation that is performing that inspection.
 */
export async function loadPythonDocumentAfterPendingOperations(
  path: string,
): Promise<LoadPythonDocumentResult> {
  return await enqueueDocumentAccess(() => loadPythonDocument(path));
}

export async function loadPythonDocumentStatus(
  path: string,
): Promise<PythonDocumentStatus> {
  const checkedAt = new Date().toISOString();
  const snapshot = await readPythonDocumentSnapshot(path);
  const sourceRevision = await sha256Text(snapshot.source);
  const sidecarRevision = await sidecarMetadataRevision(snapshot.sidecar);
  const cached = documentStatusCache.get(path);
  if (
    cached?.sourceRevision === sourceRevision &&
    cached.sidecarRevision === sidecarRevision
  ) {
    return { ...cached, checkedAt };
  }

  const loaded = await inspectPythonDocumentSnapshot(path, snapshot);

  const status = {
    path,
    ...(loaded.ok ? { revision: loaded.document.revision } : {}),
    sourceRevision,
    sidecarRevision,
    valid: loaded.ok,
    issues: loaded.ok ? [] : loaded.issues,
    checkedAt,
  };
  documentStatusCache.set(path, status);
  return status;
}

export async function loadPythonDocumentStatusAfterPendingOperations(
  path: string,
): Promise<PythonDocumentStatus> {
  return await enqueueDocumentAccess(() => loadPythonDocumentStatus(path));
}

export async function applyPythonDocumentOperations(
  path: string,
  baseRevision: string,
  operations: DocumentOperation[],
): Promise<ApplyPythonDocumentOperationsResult> {
  return await enqueueDocumentAccess(() =>
    applyPythonDocumentOperationsUnlocked(path, baseRevision, operations)
  );
}

async function enqueueDocumentAccess<T>(work: () => Promise<T>): Promise<T> {
  const previous = documentOperationChain;
  let release!: () => void;
  documentOperationChain = previous.then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

export async function readPythonDocumentSource(path: string): Promise<string> {
  return (await readPythonDocumentSnapshot(path)).source;
}

export async function readPythonDocumentSourceAtRevision(
  path: string,
  expectedRevision: string,
): Promise<{ ok: true; source: string } | { ok: false }> {
  const snapshot = await readPythonDocumentSnapshot(path);
  const revision = await documentRevisionWithSidecar(
    await sha256Text(snapshot.source),
    snapshot.sidecar,
  );
  return revision === expectedRevision
    ? { ok: true, source: snapshot.source }
    : { ok: false };
}

async function readPythonDocumentSnapshot(
  path: string,
): Promise<PythonDocumentFileSnapshot> {
  let resolvedPath: string;
  try {
    resolvedPath = await canonicalDocumentPath(path);
  } catch (error) {
    throw new DocumentReadError(
      `Unable to resolve Rowcall document ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  let lock: Deno.FsFile | null = null;
  try {
    lock = await openDocumentLock(resolvedPath);
    await recoverDocumentTransaction(resolvedPath);
    return await readPythonDocumentSnapshotUnlocked(resolvedPath);
  } catch (error) {
    if (!lock && isReadOnlyLockError(error)) {
      try {
        return await readStablePythonDocumentSnapshotWithoutLock(resolvedPath);
      } catch (fallbackError) {
        if (fallbackError instanceof DocumentReadError) throw fallbackError;
        throw new DocumentReadError(
          `Unable to read Rowcall document ${resolvedPath} without modifying its read-only directory: ${
            errorMessage(fallbackError)
          }`,
          { cause: fallbackError },
        );
      }
    }
    throw new DocumentReadError(
      `Unable to read Rowcall document ${resolvedPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    await unlockAndClose(lock);
  }
}

async function readPythonDocumentSnapshotUnlocked(
  resolvedPath: string,
): Promise<PythonDocumentFileSnapshot> {
  const source = await Deno.readTextFile(resolvedPath);
  const sidecarText = await readOptionalTextFile(
    await canonicalSidecarPath(resolvedPath),
  );
  return {
    path: resolvedPath,
    source,
    sidecar: sidecarMetadataFromText(sidecarText),
  };
}

async function readStablePythonDocumentSnapshotWithoutLock(
  resolvedPath: string,
): Promise<PythonDocumentFileSnapshot> {
  const transactionPath = transactionPathForPythonDocument(resolvedPath);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await pathExists(transactionPath)) {
      throw new DocumentReadError(
        `Rowcall cannot recover a pending document transaction in the read-only directory containing ${resolvedPath}.`,
      );
    }
    const first = await readPythonDocumentSnapshotUnlocked(resolvedPath);
    const second = await readPythonDocumentSnapshotUnlocked(resolvedPath);
    if (
      !(await pathExists(transactionPath)) &&
      first.source === second.source &&
      JSON.stringify(first.sidecar) === JSON.stringify(second.sidecar)
    ) {
      return second;
    }
  }
  throw new DocumentReadError(
    `The Rowcall document changed repeatedly while it was being read: ${resolvedPath}`,
  );
}

async function inspectPythonDocumentSnapshot(
  _path: string,
  snapshot: PythonDocumentFileSnapshot,
): Promise<LoadPythonDocumentResult> {
  const worker = new PythonWorkerClient();
  try {
    const event = await worker.requestFinalEvent("inspect_source", {
      source: snapshot.source,
      documentPath: snapshot.path,
    });
    if (event.type === "error") {
      return {
        ok: false,
        issues: workerValidationIssues(
          event,
          "Python worker document load failed",
        ),
      };
    }

    if (event.type !== "inspect_source_completed") {
      return {
        ok: false,
        issues: [{
          kind: "invalid_python",
          message:
            `Python worker returned unexpected document event: ${event.type}`,
        }],
      };
    }

    if (event.ok === false) {
      return {
        ok: false,
        issues: workerValidationIssues(
          event,
          "Python worker document load failed",
        ),
      };
    }

    if (!isRowcallDocument(event["document"])) {
      return {
        ok: false,
        issues: [{
          kind: "invalid_python",
          message: "Python worker document load returned an invalid document",
        }],
      };
    }

    const documentWithSidecar = await applySidecarMetadata(
      event["document"],
      snapshot.sidecar,
    );
    return { ok: true, document: documentWithSidecar, issues: [] };
  } catch (error) {
    return {
      ok: false,
      issues: [{
        kind: "invalid_python",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  } finally {
    await worker.shutdown();
  }
}

async function applyPythonDocumentOperationsUnlocked(
  path: string,
  baseRevision: string,
  operations: DocumentOperation[],
): Promise<ApplyPythonDocumentOperationsResult> {
  const aliasBindings = await captureDocumentAliasBindings(path);
  const resolvedPath = aliasBindings.source.targetPath;
  const loaded = await loadPythonDocument(resolvedPath);
  if (!loaded.ok) {
    return loaded;
  }

  if (!loaded.document.revision || baseRevision !== loaded.document.revision) {
    return {
      ok: false,
      issues: [{
        kind: "stale_document",
        message:
          "The Python document changed on disk after it was loaded. Reload before applying edits.",
      }],
    };
  }

  const source = await readPythonDocumentSource(resolvedPath);
  const sidecarMetadata = await readSidecar(resolvedPath);
  const worker = new PythonWorkerClient();
  try {
    const event = await worker.requestFinalEvent("apply_operations", {
      source,
      documentPath: resolvedPath,
      operations,
      ...(sidecarMetadata ? { sidecarMetadata } : {}),
    });

    if (event.type === "error") {
      return {
        ok: false,
        issues: workerValidationIssues(
          event,
          "Python worker document operation failed",
        ),
      };
    }

    if (event.type !== "apply_operations_completed") {
      return {
        ok: false,
        issues: [{
          kind: "invalid_python",
          message:
            `Python worker returned unexpected document operation event: ${event.type}`,
        }],
      };
    }

    if (event.ok === false) {
      return {
        ok: false,
        issues: workerValidationIssues(
          event,
          "Python worker document operation failed",
        ),
      };
    }

    if (typeof event.source !== "string") {
      return {
        ok: false,
        issues: [{
          kind: "invalid_python",
          message: "Python worker document operation did not return source",
        }],
      };
    }

    const nextSidecarMetadata = event.sidecarMetadata ??
      event["sidecar_metadata"] ??
      (isRowcallDocument(event.document)
        ? sidecarMetadataFromDocument(event.document)
        : sidecarMetadata);

    const latest = await loadPythonDocument(resolvedPath);
    if (!latest.ok) {
      return latest;
    }
    if (
      !latest.document.revision || latest.document.revision !== baseRevision
    ) {
      return {
        ok: false,
        issues: [{
          kind: "stale_document",
          message:
            "The Python document changed on disk after edits were prepared. Reload before applying edits.",
        }],
      };
    }

    await runBeforeDocumentWriteForTests();

    const appliedSidecarMetadata = applySidecarOperations(
      nextSidecarMetadata,
      operations,
    );

    const writeIssue = await writeDocumentFiles(
      aliasBindings,
      event.source,
      appliedSidecarMetadata,
      source,
      sidecarMetadata,
    );
    if (writeIssue) {
      return { ok: false, issues: [writeIssue] };
    }

    try {
      const committedAliases = expectedAliasesAfterWrite(
        aliasBindings,
        appliedSidecarMetadata,
        sidecarMetadata,
      );
      await assertAliasBindingsUnchanged(committedAliases, true);
      const inspected = await loadPythonDocument(
        committedAliases.source.requestedPath,
      );
      await assertAliasBindingsUnchanged(committedAliases, true);
      return postCommitInspectionResult(inspected);
    } catch (error) {
      return postCommitInspectionResult({
        ok: false,
        issues: [{
          kind: "invalid_python",
          message: error instanceof Error ? error.message : String(error),
        }],
      });
    }
  } catch (error) {
    return {
      ok: false,
      issues: [{
        kind: "invalid_python",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  } finally {
    await worker.shutdown();
  }
}

async function runBeforeDocumentWriteForTests(): Promise<void> {
  const hook = beforeDocumentWriteForTests;
  beforeDocumentWriteForTests = null;
  await hook?.();
}

export function postCommitInspectionResult(
  result: LoadPythonDocumentResult,
): ApplyPythonDocumentOperationsResult {
  if (result.ok) {
    return result;
  }

  const detail = result.issues[0]?.message;
  return {
    ok: false,
    issues: [{
      kind: "document_write_error",
      message:
        "The document files were committed, but Rowcall could not inspect the saved state. Reload from disk before editing." +
        (detail ? ` ${detail}` : ""),
    }],
  };
}

function workerValidationIssues(
  event: PythonWorkerEvent,
  fallbackMessage: string,
): ValidationIssue[] {
  if (Array.isArray(event["issues"])) {
    return event["issues"] as ValidationIssue[];
  }
  return [{
    kind: "invalid_python",
    message: event.error?.message ?? fallbackMessage,
  }];
}

function isRowcallDocument(value: unknown): value is RowcallDocumentV1 {
  const record = asRecord(value);
  return typeof record?.["version"] === "number" &&
    Array.isArray(record["nodes"]) &&
    Array.isArray(record["edges"]);
}

export function sidecarPathForPythonDocument(path: string): string {
  return path.endsWith(".py")
    ? `${path.slice(0, -3)}.rowcall.json`
    : `${path}.rowcall.json`;
}

type SidecarNodeMetadata = {
  position?: GraphPosition;
  title?: string;
  description?: string;
};

type SidecarDocumentMetadata = {
  version: 1;
  nodes: Array<
    {
      id: string;
      position?: GraphPosition;
      title?: string;
      description?: string;
    }
  >;
};

async function applySidecarMetadata(
  document: RowcallDocumentV1,
  sidecar: SidecarDocumentMetadata,
): Promise<RowcallDocumentV1> {
  const revision = await documentRevisionWithSidecar(
    document.revision,
    sidecar,
  );
  const metadataByNodeId = new Map(
    sidecar.nodes.map((node) => [node.id, sidecarNodeMetadata(node)]),
  );
  if (metadataByNodeId.size === 0) {
    return { ...document, revision };
  }

  return {
    ...document,
    revision,
    nodes: document.nodes.map((node) => {
      const metadata = metadataByNodeId.get(node.id);
      return metadata ? { ...node, ...metadata } : node;
    }),
  };
}

async function documentRevisionWithSidecar(
  sourceRevision: string | undefined,
  sidecar: SidecarDocumentMetadata,
): Promise<string> {
  const payload = JSON.stringify({
    sourceRevision: sourceRevision ?? "",
    sidecar: normalizeSidecarMetadata(sidecar),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sidecarMetadataRevision(
  sidecar: SidecarDocumentMetadata,
): Promise<string> {
  return await sha256Text(JSON.stringify(normalizeSidecarMetadata(sidecar)));
}

async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readSidecar(path: string): Promise<SidecarDocumentMetadata> {
  const resolvedPath = await canonicalDocumentPath(path);
  const lock = await openDocumentLock(resolvedPath);
  try {
    await recoverDocumentTransaction(resolvedPath);
    return sidecarMetadataFromText(
      await readOptionalTextFile(await canonicalSidecarPath(resolvedPath)),
    );
  } finally {
    await unlockAndClose(lock);
  }
}

function sidecarMetadataFromText(text: string | null): SidecarDocumentMetadata {
  if (text === null) {
    return { version: 1, nodes: [] };
  }

  try {
    return normalizeSidecarMetadata(JSON.parse(text));
  } catch {
    return { version: 1, nodes: [] };
  }
}

function sidecarNodeMetadata(
  node: SidecarDocumentMetadata["nodes"][number],
): SidecarNodeMetadata {
  return {
    ...(node.position ? { position: node.position } : {}),
    ...(typeof node.title === "string" ? { title: node.title } : {}),
    ...(typeof node.description === "string"
      ? { description: node.description }
      : {}),
  };
}

function sidecarMetadataFromDocument(
  document: RowcallDocumentV1,
): SidecarDocumentMetadata {
  return {
    version: 1,
    nodes: document.nodes.flatMap((node) => {
      const metadata = {
        id: node.id,
        ...(node.position ? { position: node.position } : {}),
        ...(node.title?.trim() ? { title: node.title.trim() } : {}),
        ...(node.description?.trim()
          ? { description: node.description.trim() }
          : {}),
      };

      return Object.keys(metadata).length > 1 ? [metadata] : [];
    }),
  };
}

async function writeDocumentFiles(
  aliases: DocumentAliasBindings,
  nextSource: string,
  sidecarMetadata: unknown,
  expectedSource: string,
  expectedSidecarMetadata: unknown,
): Promise<ValidationIssue | null> {
  const resolvedPath = aliases.source.targetPath;
  const lock = await openDocumentLock(resolvedPath);
  const sidecar = normalizeSidecarMetadata(sidecarMetadata);
  try {
    await assertAliasBindingsUnchanged(aliases, false);
    await recoverDocumentTransaction(resolvedPath);
    const sidecarPath = aliases.sidecar.exists
      ? aliases.sidecar.targetPath
      : aliases.sidecar.requestedPath;
    const currentSource = await Deno.readTextFile(resolvedPath);
    if (currentSource !== expectedSource) {
      return staleWriteIssue();
    }
    const originalSidecarText = await readOptionalTextFile(sidecarPath);
    const currentSidecar = sidecarMetadataFromText(originalSidecarText);
    if (
      JSON.stringify(normalizeSidecarMetadata(currentSidecar)) !==
        JSON.stringify(normalizeSidecarMetadata(expectedSidecarMetadata))
    ) {
      return staleWriteIssue();
    }
    const sidecarChanged =
      JSON.stringify(sidecar) !== JSON.stringify(currentSidecar);
    const nextSidecarText = sidecarChanged
      ? `${JSON.stringify(sidecar, null, 2)}\n`
      : originalSidecarText;
    const postWriteAliases = expectedAliasesAfterWrite(
      aliases,
      sidecar,
      currentSidecar,
    );
    await commitDocumentTransaction(
      resolvedPath,
      nextSource,
      sidecarPath,
      nextSidecarText,
      currentSource,
      originalSidecarText,
      aliases,
      postWriteAliases,
    );
    await assertAliasBindingsUnchanged(postWriteAliases, true);
    return null;
  } catch (error) {
    if (error instanceof StaleDocumentWriteError) {
      return staleWriteIssue();
    }
    return {
      kind: "document_write_error",
      message: `The document save did not complete. Reload before editing: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    await unlockAndClose(lock);
  }
}

type DocumentTransaction = {
  version: 1;
  sourcePath: string;
  sidecarPath: string;
  sourceTempPath: string;
  sidecarTempPath: string;
  newSourceRevision: string;
  oldSidecarRevision: string;
  newSidecarRevision: string;
};

async function commitDocumentTransaction(
  path: string,
  nextSource: string,
  sidecarPath: string,
  nextSidecar: string | null,
  currentSource: string,
  currentSidecar: string | null,
  aliasesBefore: DocumentAliasBindings,
  aliasesAfter: DocumentAliasBindings,
): Promise<void> {
  const sourceDirectory = containingDirectory(path);
  const sidecarDirectory = containingDirectory(sidecarPath);
  const sourceInfo = await Deno.stat(path);
  const sidecarInfo = await optionalStat(sidecarPath);
  const sourceChanged = nextSource !== currentSource;
  const sidecarChanged = nextSidecar !== currentSidecar;
  if (!sourceChanged && !sidecarChanged) return;
  if (!sourceChanged && nextSidecar !== null) {
    const sidecarTempPath = await writeSyncedTempFile(
      sidecarDirectory,
      ".rowcall-sidecar-",
      nextSidecar,
      sidecarInfo?.mode,
    );
    try {
      await syncDirectory(sidecarDirectory);
      await runBeforeDocumentPublishForTests();
      await assertDocumentFilesUnchanged(
        path,
        currentSource,
        sidecarPath,
        currentSidecar,
      );
      await assertAliasBindingsUnchanged(aliasesBefore, false);
      await Deno.rename(sidecarTempPath, sidecarPath);
      await syncDirectory(sidecarDirectory);
      await assertAliasBindingsUnchanged(aliasesAfter, true);
    } catch (error) {
      await removeIfPresent(sidecarTempPath);
      throw error;
    }
    return;
  }
  if (!sidecarChanged) {
    const sourceTempPath = await writeSyncedTempFile(
      sourceDirectory,
      ".rowcall-source-",
      nextSource,
      sourceInfo.mode,
    );
    try {
      await syncDirectory(sourceDirectory);
      await runBeforeDocumentPublishForTests();
      await assertDocumentFilesUnchanged(
        path,
        currentSource,
        sidecarPath,
        currentSidecar,
      );
      await assertAliasBindingsUnchanged(aliasesBefore, false);
      await Deno.rename(sourceTempPath, path);
      await syncDirectory(sourceDirectory);
      await assertAliasBindingsUnchanged(aliasesAfter, true);
    } catch (error) {
      await removeIfPresent(sourceTempPath);
      throw error;
    }
    return;
  }
  if (nextSidecar === null) {
    throw new Error("Cannot remove Rowcall sidecar metadata during a save.");
  }
  const sourceTempPath = await writeSyncedTempFile(
    sourceDirectory,
    ".rowcall-source-",
    nextSource,
    sourceInfo.mode,
  );
  let sidecarTempPath: string | null = null;
  try {
    sidecarTempPath = await writeSyncedTempFile(
      sidecarDirectory,
      ".rowcall-sidecar-",
      nextSidecar,
      sidecarInfo?.mode,
    );
    const transaction: DocumentTransaction = {
      version: 1,
      sourcePath: path,
      sidecarPath,
      sourceTempPath,
      sidecarTempPath,
      newSourceRevision: await sha256Text(nextSource),
      oldSidecarRevision: await sha256Text(currentSidecar ?? ""),
      newSidecarRevision: await sha256Text(nextSidecar),
    };
    await syncDirectory(sourceDirectory);
    if (sidecarDirectory !== sourceDirectory) {
      await syncDirectory(sidecarDirectory);
    }
    await runBeforeDocumentPublishForTests();
    await assertDocumentFilesUnchanged(
      path,
      currentSource,
      sidecarPath,
      currentSidecar,
    );
    await assertAliasBindingsUnchanged(aliasesBefore, false);
    const journalPath = transactionPathForPythonDocument(path);
    await atomicWriteTextFile(
      journalPath,
      `${JSON.stringify(transaction, null, 2)}\n`,
    );

    // Revalidate after publishing the journal as well. The lock coordinates
    // Rowcall writers, but an editor or another process can still replace
    // either user file while a save is being prepared.
    try {
      await assertDocumentFilesUnchanged(
        path,
        currentSource,
        sidecarPath,
        currentSidecar,
      );
      await assertAliasBindingsUnchanged(aliasesBefore, false);
    } catch (error) {
      await removeIfPresent(journalPath);
      await removeIfPresent(sourceTempPath);
      await removeIfPresent(sidecarTempPath);
      sidecarTempPath = null;
      await syncDirectory(sourceDirectory);
      throw error;
    }

    // Installing Python is the commit point. Readers recover the matching
    // sidecar before returning either file.
    await Deno.rename(sourceTempPath, path);
    await syncDirectory(sourceDirectory);
    await runBeforeSidecarPublishForTests();
    await assertCommittedSourceAndSidecarReady(
      path,
      nextSource,
      sidecarPath,
      currentSidecar,
    );
    await assertAliasBindingsUnchanged(aliasesBefore, true);
    await Deno.rename(sidecarTempPath, sidecarPath);
    sidecarTempPath = null;
    if (sidecarDirectory !== sourceDirectory) {
      await syncDirectory(sidecarDirectory);
    } else {
      await syncDirectory(sourceDirectory);
    }
    await removeIfPresent(journalPath);
    await syncDirectory(sourceDirectory);
    await assertAliasBindingsUnchanged(aliasesAfter, true);
  } catch (error) {
    // Before the durable journal exists, prepared files are disposable. Once
    // it exists, recovery decides whether the commit point was crossed.
    if (!(await pathExists(transactionPathForPythonDocument(path)))) {
      await removeIfPresent(sourceTempPath);
      if (sidecarTempPath) await removeIfPresent(sidecarTempPath);
    }
    throw error;
  }
}

async function runBeforeDocumentPublishForTests(): Promise<void> {
  const hook = beforeDocumentPublishForTests;
  beforeDocumentPublishForTests = null;
  await hook?.();
}

async function runBeforeSidecarPublishForTests(): Promise<void> {
  const hook = beforeSidecarPublishForTests;
  beforeSidecarPublishForTests = null;
  await hook?.();
}

async function assertDocumentFilesUnchanged(
  sourcePath: string,
  expectedSource: string,
  sidecarPath: string,
  expectedSidecar: string | null,
): Promise<void> {
  const source = await Deno.readTextFile(sourcePath);
  const sidecar = await readOptionalTextFile(sidecarPath);
  if (source !== expectedSource || sidecar !== expectedSidecar) {
    throw new StaleDocumentWriteError();
  }
}

async function assertCommittedSourceAndSidecarReady(
  sourcePath: string,
  committedSource: string,
  sidecarPath: string,
  expectedSidecar: string | null,
): Promise<void> {
  const source = await Deno.readTextFile(sourcePath);
  const sidecar = await readOptionalTextFile(sidecarPath);
  if (source !== committedSource || sidecar !== expectedSidecar) {
    throw new Error(
      "A document file changed after the Python save commit point. Rowcall preserved the external file and left the transaction journal for explicit recovery.",
    );
  }
}

async function recoverDocumentTransaction(path: string): Promise<void> {
  const journalPath = transactionPathForPythonDocument(path);
  const journalText = await readOptionalTextFile(journalPath);
  if (journalText === null) return;

  const expectedSidecarPath = await canonicalSidecarPath(path);
  let transaction: DocumentTransaction | null = null;
  try {
    const parsed = JSON.parse(journalText) as Partial<DocumentTransaction>;
    if (
      parsed.version === 1 && parsed.sourcePath === path &&
      parsed.sidecarPath === expectedSidecarPath &&
      typeof parsed.sourceTempPath === "string" &&
      typeof parsed.sidecarTempPath === "string" &&
      typeof parsed.newSourceRevision === "string" &&
      typeof parsed.oldSidecarRevision === "string" &&
      typeof parsed.newSidecarRevision === "string" &&
      isPreparedTransactionPath(
        path,
        parsed.sourceTempPath,
        ".rowcall-source-",
      ) &&
      isPreparedTransactionPath(
        expectedSidecarPath,
        parsed.sidecarTempPath,
        ".rowcall-sidecar-",
      )
    ) {
      transaction = parsed as DocumentTransaction;
    }
  } catch {
    // A malformed journal cannot authorize replacing user files.
  }
  if (!transaction) {
    throw new Error(
      `Cannot recover malformed Rowcall transaction journal: ${journalPath}`,
    );
  }

  const currentSourceRevision = await sha256Text(
    await Deno.readTextFile(path),
  );
  if (currentSourceRevision === transaction.newSourceRevision) {
    const currentSidecar = await readOptionalTextFile(transaction.sidecarPath);
    const currentSidecarRevision = await sha256Text(currentSidecar ?? "");
    if (currentSidecarRevision === transaction.newSidecarRevision) {
      // Both files reached their intended revisions before the interruption.
    } else if (
      currentSidecarRevision === transaction.oldSidecarRevision &&
      await fileHasRevision(
        transaction.sidecarTempPath,
        transaction.newSidecarRevision,
      )
    ) {
      await Deno.rename(
        transaction.sidecarTempPath,
        transaction.sidecarPath,
      );
      await syncDirectory(containingDirectory(transaction.sidecarPath));
    } else {
      throw new Error(
        `Cannot recover Rowcall transaction after the Python file was committed: ${journalPath}`,
      );
    }
  }

  // Old source means the commit point was not reached. Any other revision is
  // an external edit. In both cases the Python file wins and temps are dropped.
  await removeIfPresent(transaction.sourceTempPath);
  await removeIfPresent(transaction.sidecarTempPath);
  await removeIfPresent(journalPath);
  await syncDirectory(containingDirectory(path));
}

function isPreparedTransactionPath(
  targetPath: string,
  preparedPath: string,
  prefix: string,
): boolean {
  const target = splitPath(targetPath);
  const prepared = splitPath(preparedPath);
  return prepared.directory === target.directory &&
    prepared.name.startsWith(prefix);
}

async function captureDocumentAliasBindings(
  path: string,
): Promise<DocumentAliasBindings> {
  const source = await capturePathAlias(path);
  if (!source.exists || !source.targetResolved) {
    throw new DocumentReadError(`Rowcall document does not exist: ${path}`);
  }
  const sidecar = await capturePathAlias(
    sidecarPathForPythonDocument(source.targetPath),
  );
  if (sidecar.exists && !sidecar.targetResolved) {
    throw new DocumentReadError(
      `Rowcall sidecar is a dangling symlink: ${sidecar.requestedPath}`,
    );
  }
  return { source: { ...source, exists: true }, sidecar };
}

async function capturePathAlias(path: string): Promise<PathAliasIdentity> {
  const requestedPath = path.startsWith("/") ? path : `${Deno.cwd()}/${path}`;
  try {
    return {
      requestedPath,
      exists: true,
      targetResolved: true,
      targetPath: await Deno.realPath(requestedPath),
    };
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    try {
      await Deno.lstat(requestedPath);
      return {
        requestedPath,
        exists: true,
        targetResolved: false,
        targetPath: requestedPath,
      };
    } catch (lstatError) {
      if (!(lstatError instanceof Deno.errors.NotFound)) throw lstatError;
      return {
        requestedPath,
        exists: false,
        targetResolved: false,
        targetPath: requestedPath,
      };
    }
  }
}

function sameAliasIdentity(
  left: PathAliasIdentity,
  right: PathAliasIdentity,
): boolean {
  return left.requestedPath === right.requestedPath &&
    left.exists === right.exists &&
    left.targetResolved === right.targetResolved &&
    left.targetPath === right.targetPath;
}

async function assertAliasBindingsUnchanged(
  expected: DocumentAliasBindings,
  commitMayHaveOccurred: boolean,
): Promise<void> {
  const currentSource = await capturePathAlias(expected.source.requestedPath);
  const currentSidecar = await capturePathAlias(expected.sidecar.requestedPath);
  if (
    sameAliasIdentity(expected.source, currentSource) &&
    sameAliasIdentity(expected.sidecar, currentSidecar)
  ) {
    return;
  }
  if (commitMayHaveOccurred) {
    throw new DocumentAliasChangedAfterCommitError();
  }
  throw new StaleDocumentWriteError();
}

function expectedAliasesAfterWrite(
  aliases: DocumentAliasBindings,
  nextSidecarMetadata: unknown,
  currentSidecarMetadata: unknown,
): DocumentAliasBindings {
  const sidecarChanges = JSON.stringify(
    normalizeSidecarMetadata(nextSidecarMetadata),
  ) !== JSON.stringify(normalizeSidecarMetadata(currentSidecarMetadata));
  if (!sidecarChanges || aliases.sidecar.exists) return aliases;
  return {
    source: aliases.source,
    sidecar: {
      ...aliases.sidecar,
      exists: true,
      targetResolved: true,
      targetPath: aliases.sidecar.requestedPath,
    },
  };
}

async function canonicalDocumentPath(path: string): Promise<string> {
  return await Deno.realPath(path);
}

async function canonicalSidecarPath(path: string): Promise<string> {
  const sidecarPath = sidecarPathForPythonDocument(path);
  try {
    return await Deno.realPath(sidecarPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return sidecarPath;
    throw error;
  }
}

async function openDocumentLock(path: string): Promise<Deno.FsFile> {
  const lock = await Deno.open(lockPathForPythonDocument(path), {
    read: true,
    write: true,
    create: true,
    mode: 0o600,
  });
  try {
    await lock.lock(true);
    return lock;
  } catch (error) {
    lock.close();
    throw error;
  }
}

function lockPathForPythonDocument(path: string): string {
  const document = splitPath(path);
  return joinPath(document.directory, `.${document.name}.rowcall.lock`);
}

function transactionPathForPythonDocument(path: string): string {
  const document = splitPath(path);
  return joinPath(
    document.directory,
    `.${document.name}.rowcall-transaction.json`,
  );
}

async function atomicWriteTextFile(path: string, text: string): Promise<void> {
  await atomicReplaceTextFile(path, text, 0o600);
}

async function atomicReplaceTextFile(
  path: string,
  text: string,
  mode: number | null | undefined,
): Promise<void> {
  const directory = containingDirectory(path);
  const tempPath = await writeSyncedTempFile(
    directory,
    ".rowcall-marker-",
    text,
    mode,
  );
  try {
    await Deno.rename(tempPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await removeIfPresent(tempPath);
    throw error;
  }
}

async function writeSyncedTempFile(
  directory: string,
  prefix: string,
  text: string,
  mode: number | null | undefined,
): Promise<string> {
  const path = await Deno.makeTempFile({ dir: directory, prefix });
  const file = await Deno.open(path, {
    read: true,
    write: true,
    truncate: true,
  });
  try {
    if (typeof mode === "number" && Deno.build.os !== "windows") {
      await Deno.chmod(path, mode & 0o7777);
    }
    await writeTextToOpenFile(file, text);
    await file.sync();
  } finally {
    file.close();
  }
  return path;
}

async function syncDirectory(path: string): Promise<void> {
  if (Deno.build.os === "windows") return;
  const directory = await Deno.open(path, { read: true });
  try {
    await directory.sync();
  } finally {
    directory.close();
  }
}

async function optionalStat(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function readOptionalTextFile(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await optionalStat(path)) !== null;
}

async function fileHasRevision(
  path: string,
  revision: string,
): Promise<boolean> {
  const text = await readOptionalTextFile(path);
  return text !== null && await sha256Text(text) === revision;
}

function containingDirectory(path: string): string {
  return splitPath(path).directory;
}

function splitPath(path: string): { directory: string; name: string } {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator < 0 ? { directory: ".", name: path } : {
    directory: separator === 0 ? path.slice(0, 1) : path.slice(0, separator),
    name: path.slice(separator + 1),
  };
}

function joinPath(directory: string, name: string): string {
  if (directory === ".") return name;
  const separator = directory.includes("\\") && !directory.includes("/")
    ? "\\"
    : "/";
  return `${directory}${directory.endsWith(separator) ? "" : separator}${name}`;
}

async function writeTextToOpenFile(
  file: Deno.FsFile,
  text: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  await file.truncate(0);
  await file.seek(0, Deno.SeekMode.Start);
  let written = 0;
  while (written < bytes.length) {
    const count = await file.write(bytes.subarray(written));
    if (count === 0) {
      throw new Error("Unable to write Rowcall document file.");
    }
    written += count;
  }
}

async function unlockAndClose(file: Deno.FsFile | null): Promise<void> {
  if (!file) return;
  try {
    await file.unlock();
  } catch {
    // The file may not have been locked if open failed midway.
  }
  file.close();
}

function isReadOnlyLockError(error: unknown): boolean {
  return error instanceof Deno.errors.PermissionDenied ||
    (error instanceof Error &&
      (error.name === "ReadOnlyFilesystem" ||
        error.message.toLowerCase().includes("read-only file system")));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function documentLoadIssue(error: unknown): ValidationIssue {
  return {
    kind: error instanceof DocumentReadError
      ? "document_read_error"
      : "invalid_python",
    message: errorMessage(error),
  };
}

function staleWriteIssue(): ValidationIssue {
  return {
    kind: "stale_document",
    message:
      "The Python document changed on disk before edits were written. Reload before applying edits.",
  };
}

function normalizeSidecarMetadata(value: unknown): SidecarDocumentMetadata {
  const record = asRecord(value);
  const rawNodes = record?.["nodes"];
  const nodeRecord = asRecord(rawNodes);
  const nodes = Array.isArray(rawNodes)
    ? rawNodes
    : nodeRecord
    ? Object.entries(nodeRecord).map(([id, metadata]) => ({
      id,
      ...(asRecord(metadata) ?? {}),
    }))
    : [];

  return {
    version: 1,
    nodes: nodes.flatMap((node) => {
      const nodeRecord = asRecord(node);
      if (!nodeRecord || typeof nodeRecord["id"] !== "string") {
        return [];
      }

      const positionRecord = asRecord(nodeRecord["position"]);
      const metadata = {
        id: nodeRecord["id"],
        ...(typeof positionRecord?.["x"] === "number" &&
            typeof positionRecord?.["y"] === "number"
          ? {
            position: {
              x: positionRecord["x"],
              y: positionRecord["y"],
            },
          }
          : {}),
        ...(typeof nodeRecord["title"] === "string" &&
            nodeRecord["title"].trim()
          ? { title: nodeRecord["title"].trim() }
          : {}),
        ...(typeof nodeRecord["description"] === "string" &&
            nodeRecord["description"].trim()
          ? { description: nodeRecord["description"].trim() }
          : {}),
      };

      return Object.keys(metadata).length > 1 ? [metadata] : [];
    }),
  };
}

function applySidecarOperations(
  sidecarMetadata: unknown,
  operations: DocumentOperation[],
): SidecarDocumentMetadata {
  const metadata = normalizeSidecarMetadata(sidecarMetadata);
  const nodesById = new Map(metadata.nodes.map((node) => [node.id, node]));

  for (const operation of operations) {
    switch (operation.type) {
      case "add_node": {
        const nodeMetadata = {
          id: operation.node.id,
          ...(operation.node.position
            ? { position: operation.node.position }
            : {}),
          ...(operation.node.title?.trim()
            ? { title: operation.node.title.trim() }
            : {}),
          ...(operation.node.description?.trim()
            ? { description: operation.node.description.trim() }
            : {}),
        };
        nodesById.set(operation.node.id, nodeMetadata);
        break;
      }
      case "delete_node":
        nodesById.delete(operation.nodeId);
        break;
      case "move_node":
        nodesById.set(operation.nodeId, {
          id: operation.nodeId,
          ...nodesById.get(operation.nodeId),
          position: operation.position,
        });
        break;
      case "update_node_title": {
        const node = {
          id: operation.nodeId,
          ...nodesById.get(operation.nodeId),
        };
        if (operation.title.trim()) {
          nodesById.set(operation.nodeId, {
            ...node,
            title: operation.title.trim(),
          });
        } else {
          delete node.title;
          nodesById.set(operation.nodeId, node);
        }
        break;
      }
      case "update_node_description": {
        const node = {
          id: operation.nodeId,
          ...nodesById.get(operation.nodeId),
        };
        if (operation.description.trim()) {
          nodesById.set(operation.nodeId, {
            ...node,
            description: operation.description.trim(),
          });
        } else {
          delete node.description;
          nodesById.set(operation.nodeId, node);
        }
        break;
      }
    }
  }

  return {
    version: 1,
    nodes: [...nodesById.values()],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
