import type { RowcallDocumentV1 } from "../graph/documentTypes.ts";
import { rowcallFetch } from "./auth.ts";

const activeDocumentPath = "/document";
export const maxImportedFileBytes = 100 * 1024 * 1024;

export type DocumentValidationIssue = {
  kind: string;
  message: string;
  path?: string;
  nodeId?: string;
  edgeIndex?: number;
  field?: string;
  operationIndex?: number;
  operationType?: string;
};

export type DocumentApiError = {
  ok: false;
  error: {
    kind: string;
    message: string;
    issues?: DocumentValidationIssue[];
  };
};

export type LoadDocumentSuccess = {
  ok: true;
  document: RowcallDocumentV1;
  sourceRevision: string;
  path: string;
};

export type DocumentStatus = {
  path: string;
  revision?: string;
  sourceRevision: string;
  sidecarRevision: string;
  valid: boolean;
  issues: DocumentValidationIssue[];
  checkedAt: string;
};

export type LoadDocumentStatusSuccess = {
  ok: true;
  status: DocumentStatus;
};

export type LoadDocumentResult =
  | LoadDocumentSuccess
  | DocumentApiError;

export type LoadDocumentStatusResult =
  | LoadDocumentStatusSuccess
  | DocumentApiError;

export type DocumentOperation =
  | { type: "update_globals"; code: string }
  | { type: "update_node_body"; nodeId: string; code: string }
  | { type: "update_node_outputs"; nodeId: string; outputs: string[] }
  | { type: "rename_node_function"; nodeId: string; functionName: string }
  | {
    type: "add_node";
    node: {
      id: string;
      functionName: string;
      code: string;
      outputs: string[];
      position?: { x: number; y: number };
      title?: string;
      description?: string;
    };
  }
  | { type: "delete_node"; nodeId: string }
  | {
    type: "add_edge";
    fromNode: string;
    fromOutput: string;
    toNode: string;
    toInput: string;
  }
  | {
    type: "remove_edge";
    fromNode: string;
    fromOutput: string;
    toNode: string;
    toInput: string;
  }
  | { type: "move_node"; nodeId: string; position: { x: number; y: number } }
  | { type: "update_node_title"; nodeId: string; title: string }
  | {
    type: "update_node_description";
    nodeId: string;
    description: string;
  };

export type ApplyDocumentOperationsRequest = {
  baseRevision: string;
  operations: DocumentOperation[];
};

export type ApplyDocumentOperationsResult =
  | LoadDocumentSuccess
  | DocumentApiError;

export type ImportedDocumentFile = {
  originalName: string;
  storedName: string;
  relativePath: string;
  size: number;
};

export type ImportDocumentFileResult =
  | { ok: true; file: ImportedDocumentFile }
  | DocumentApiError;

export class DocumentApiRequestError extends Error {
  readonly kind: string;
  readonly issues: DocumentValidationIssue[];
  readonly status: number;

  constructor(
    message: string,
    options: {
      kind: string;
      issues?: DocumentValidationIssue[];
      status: number;
    },
  ) {
    super(message);
    this.name = "DocumentApiRequestError";
    this.kind = options.kind;
    this.issues = options.issues ?? [];
    this.status = options.status;
  }
}

export async function loadDocument(): Promise<LoadDocumentSuccess> {
  const response = await rowcallFetch(activeDocumentPath);
  const result = await response.json() as LoadDocumentResult;

  if (!result.ok) {
    throw new DocumentApiRequestError(
      result.error.message,
      {
        kind: result.error.kind,
        issues: result.error.issues,
        status: response.status,
      },
    );
  }

  return result;
}

export async function loadDocumentStatus(): Promise<LoadDocumentStatusSuccess> {
  const response = await rowcallFetch(`${activeDocumentPath}/status`);
  const result = await response.json() as LoadDocumentStatusResult;

  if (!result.ok) {
    throw new DocumentApiRequestError(
      result.error.message,
      {
        kind: result.error.kind,
        issues: result.error.issues,
        status: response.status,
      },
    );
  }

  return result;
}

export async function applyDocumentOperations(
  baseRevision: string,
  operations: DocumentOperation[],
): Promise<LoadDocumentSuccess> {
  const request: ApplyDocumentOperationsRequest = {
    baseRevision,
    operations,
  };
  const response = await rowcallFetch(`${activeDocumentPath}/operations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const result = await response.json() as ApplyDocumentOperationsResult;

  if (!result.ok) {
    throw new DocumentApiRequestError(
      result.error.message,
      {
        kind: result.error.kind,
        issues: result.error.issues,
        status: response.status,
      },
    );
  }

  return result;
}

export async function importDocumentFile(
  file: File,
): Promise<ImportedDocumentFile> {
  if (file.size > maxImportedFileBytes) {
    throw new DocumentApiRequestError(
      "Imported file exceeds the 100 MiB limit.",
      { kind: "file_too_large", status: 413 },
    );
  }

  const query = new URLSearchParams({ name: file.name });
  const response = await rowcallFetch(
    `${activeDocumentPath}/files?${query.toString()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    },
  );
  const result = await response.json() as ImportDocumentFileResult;

  if (!result.ok) {
    throw new DocumentApiRequestError(
      result.error.message,
      {
        kind: result.error.kind,
        issues: result.error.issues,
        status: response.status,
      },
    );
  }

  return result.file;
}
