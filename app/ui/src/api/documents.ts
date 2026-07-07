import type { NodebookDocumentV1 } from "../graph/documentTypes.ts";
import { nodebookFetch } from "./auth.ts";

const activeDocumentPath = "/document";

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
  document: NodebookDocumentV1;
  path: string;
  clientBatchId?: string;
};

export type LoadDocumentResult =
  | LoadDocumentSuccess
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
  | { type: "add_edge"; fromNode: string; toNode: string }
  | { type: "remove_edge"; fromNode: string; toNode: string }
  | { type: "move_node"; nodeId: string; position: { x: number; y: number } }
  | { type: "update_node_title"; nodeId: string; title: string }
  | {
    type: "update_node_description";
    nodeId: string;
    description: string;
  };

export type ApplyDocumentOperationsRequest = {
  baseRevision: string;
  clientBatchId?: string;
  operations: DocumentOperation[];
};

export type ApplyDocumentOperationsResult =
  | LoadDocumentSuccess
  | DocumentApiError;

export class DocumentApiRequestError extends Error {
  readonly issues: DocumentValidationIssue[];

  constructor(message: string, issues: DocumentValidationIssue[] = []) {
    super(message);
    this.name = "DocumentApiRequestError";
    this.issues = issues;
  }
}

export async function loadDocument(): Promise<LoadDocumentSuccess> {
  const response = await nodebookFetch(activeDocumentPath);
  const result = await response.json() as LoadDocumentResult;

  if (!result.ok) {
    throw new DocumentApiRequestError(
      result.error.message,
      result.error.issues,
    );
  }

  return result;
}

export async function applyDocumentOperations(
  baseRevision: string,
  operations: DocumentOperation[],
  clientBatchId?: string,
): Promise<LoadDocumentSuccess> {
  const request: ApplyDocumentOperationsRequest = {
    baseRevision,
    operations,
    ...(clientBatchId ? { clientBatchId } : {}),
  };
  const response = await nodebookFetch(`${activeDocumentPath}/operations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const result = await response.json() as ApplyDocumentOperationsResult;

  if (!result.ok) {
    throw new DocumentApiRequestError(
      result.error.message,
      result.error.issues,
    );
  }

  return result;
}
