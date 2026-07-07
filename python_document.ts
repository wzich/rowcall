import {
  type DocumentOperation,
  type GraphPosition,
  type NodebookDocumentV1,
} from "./document.ts";
import type { ValidationIssue } from "./types.ts";
import {
  PythonWorkerClient,
  type PythonWorkerEvent,
} from "./python_worker_client.ts";

export type LoadPythonDocumentResult =
  | { ok: true; document: NodebookDocumentV1; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

export type ApplyPythonDocumentOperationsResult =
  | { ok: true; document: NodebookDocumentV1; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

type PythonDocumentFileSnapshot = {
  source: string;
  sidecar: SidecarDocumentMetadata;
};

let documentOperationChain: Promise<void> = Promise.resolve();

export async function loadPythonDocument(
  path: string,
): Promise<LoadPythonDocumentResult> {
  const worker = new PythonWorkerClient();
  try {
    const snapshot = await readPythonDocumentSnapshot(path);
    const event = await worker.requestFinalEvent("inspect_source", {
      source: snapshot.source,
      documentPath: path,
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

    if (!isNodebookDocument(event["document"])) {
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

export async function applyPythonDocumentOperations(
  path: string,
  baseRevision: string,
  operations: DocumentOperation[],
  _clientBatchId?: string,
): Promise<ApplyPythonDocumentOperationsResult> {
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
    return await applyPythonDocumentOperationsUnlocked(
      path,
      baseRevision,
      operations,
    );
  } finally {
    release();
  }
}

export async function readPythonDocumentSource(path: string): Promise<string> {
  return await readLockedTextFile(path);
}

async function readPythonDocumentSnapshot(
  path: string,
): Promise<PythonDocumentFileSnapshot> {
  const sourceFile = await Deno.open(path, { read: true });
  try {
    await sourceFile.lock(false);
    const source = await Deno.readTextFile(path);
    const sidecarText = await readOptionalLockedTextFile(
      sidecarPathForPythonDocument(path),
    );
    return {
      source,
      sidecar: sidecarMetadataFromText(sidecarText),
    };
  } finally {
    await unlockAndClose(sourceFile);
  }
}

async function applyPythonDocumentOperationsUnlocked(
  path: string,
  baseRevision: string,
  operations: DocumentOperation[],
): Promise<ApplyPythonDocumentOperationsResult> {
  const loaded = await loadPythonDocument(path);
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

  const source = await readPythonDocumentSource(path);
  const sidecarMetadata = await readSidecar(path);
  const worker = new PythonWorkerClient();
  try {
    const event = await worker.requestFinalEvent("apply_operations", {
      source,
      documentPath: path,
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
      (isNodebookDocument(event.document)
        ? sidecarMetadataFromDocument(event.document)
        : sidecarMetadata);

    const latest = await loadPythonDocument(path);
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

    const writeIssue = await writeDocumentFiles(
      path,
      event.source,
      sidecarPathForPythonDocument(path),
      applySidecarOperations(nextSidecarMetadata, operations),
      source,
      sidecarMetadata,
    );
    if (writeIssue) {
      return { ok: false, issues: [writeIssue] };
    }

    return await loadPythonDocument(path);
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

function isNodebookDocument(value: unknown): value is NodebookDocumentV1 {
  const record = asRecord(value);
  return typeof record?.["version"] === "number" &&
    Array.isArray(record["nodes"]) &&
    Array.isArray(record["edges"]);
}

export function sidecarPathForPythonDocument(path: string): string {
  return path.endsWith(".py")
    ? `${path.slice(0, -3)}.nodebook.json`
    : `${path}.nodebook.json`;
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
  document: NodebookDocumentV1,
  sidecar: SidecarDocumentMetadata,
): Promise<NodebookDocumentV1> {
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

async function readSidecar(path: string): Promise<SidecarDocumentMetadata> {
  const metadataByNodeId = await loadSidecarNodeMetadata(
    sidecarPathForPythonDocument(path),
  );
  return {
    version: 1,
    nodes: [...metadataByNodeId.entries()].map(([id, metadata]) => ({
      id,
      ...metadata,
    })),
  };
}

async function loadSidecarNodeMetadata(
  path: string,
): Promise<Map<string, SidecarNodeMetadata>> {
  let text: string;
  try {
    text = await readLockedTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Map();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map();
  }

  const normalized = normalizeSidecarMetadata(parsed);

  return new Map(
    normalized.nodes.flatMap((node) => {
      const nodeRecord = asRecord(node);
      if (!nodeRecord) {
        return [];
      }

      const nodeId = nodeRecord["id"];
      if (typeof nodeId !== "string") {
        return [];
      }

      const positionRecord = asRecord(nodeRecord["position"]);
      const metadata: SidecarNodeMetadata = {};
      if (
        typeof positionRecord?.["x"] === "number" &&
        typeof positionRecord?.["y"] === "number"
      ) {
        metadata.position = { x: positionRecord["x"], y: positionRecord["y"] };
      }
      if (typeof nodeRecord["title"] === "string") {
        metadata.title = nodeRecord["title"];
      }
      if (typeof nodeRecord["description"] === "string") {
        metadata.description = nodeRecord["description"];
      }

      if (Object.keys(metadata).length === 0) {
        return [];
      }

      return [[
        nodeId,
        metadata,
      ]];
    }),
  );
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
  document: NodebookDocumentV1,
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
  path: string,
  nextSource: string,
  sidecarPath: string,
  sidecarMetadata: unknown,
  expectedSource: string,
  expectedSidecarMetadata: unknown,
): Promise<ValidationIssue | null> {
  const sidecar = normalizeSidecarMetadata(sidecarMetadata);
  const sidecarText = `${JSON.stringify(sidecar, null, 2)}\n`;
  let sourceFile: Deno.FsFile | null = null;
  let sidecarFile: Deno.FsFile | null = null;
  let sourceTouched = false;
  let sidecarTouched = false;
  let sidecarCreated = false;
  let originalSidecarText: string | null = null;

  try {
    sourceFile = await Deno.open(path, { read: true, write: true });
    await sourceFile.lock(true);
    const currentSource = await Deno.readTextFile(path);
    if (currentSource !== expectedSource) {
      return staleWriteIssue();
    }

    try {
      sidecarFile = await Deno.open(sidecarPath, { read: true, write: true });
      await sidecarFile.lock(true);
      originalSidecarText = await Deno.readTextFile(sidecarPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    const currentSidecar = sidecarMetadataFromText(originalSidecarText);
    if (
      JSON.stringify(normalizeSidecarMetadata(currentSidecar)) !==
        JSON.stringify(normalizeSidecarMetadata(expectedSidecarMetadata))
    ) {
      return staleWriteIssue();
    }

    sourceTouched = true;
    await writeTextToOpenFile(sourceFile, nextSource);
    await sourceFile.syncData();

    if (sidecarFile) {
      sidecarTouched = true;
      await writeTextToOpenFile(sidecarFile, sidecarText);
      await sidecarFile.syncData();
    } else {
      sidecarFile = await Deno.open(sidecarPath, {
        read: true,
        write: true,
        createNew: true,
      });
      sidecarCreated = true;
      await sidecarFile.lock(true);
      sidecarTouched = true;
      await writeTextToOpenFile(sidecarFile, sidecarText);
      await sidecarFile.syncData();
    }

    return null;
  } catch (error) {
    if (sidecarTouched && sidecarFile) {
      try {
        if (sidecarCreated) {
          await unlockAndClose(sidecarFile);
          sidecarFile = null;
          await Deno.remove(sidecarPath);
        } else if (originalSidecarText !== null) {
          await writeTextToOpenFile(sidecarFile, originalSidecarText);
          await sidecarFile.syncData();
        }
      } catch {
        // Preserve the original write error below; rollback is best effort.
      }
    }
    if (sourceTouched && sourceFile) {
      try {
        await writeTextToOpenFile(sourceFile, expectedSource);
        await sourceFile.syncData();
      } catch {
        // Preserve the original write error below; rollback is best effort.
      }
    }
    return {
      kind: "document_write_error",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await unlockAndClose(sidecarFile);
    await unlockAndClose(sourceFile);
  }
}

async function readLockedTextFile(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  try {
    await file.lock(false);
    return await Deno.readTextFile(path);
  } finally {
    await unlockAndClose(file);
  }
}

async function readOptionalLockedTextFile(
  path: string,
): Promise<string | null> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }

  try {
    await file.lock(false);
    return await Deno.readTextFile(path);
  } finally {
    await unlockAndClose(file);
  }
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
      throw new Error("Unable to write Nodebook document file.");
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
