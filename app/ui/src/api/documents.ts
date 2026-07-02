import type { InspectGraphValidationIssue } from "./inspectGraph.ts";
import type { NodebookDocumentV1 } from "../graph/documentTypes.ts";
import { nodebookFetch } from "./auth.ts";

const activeDocumentPath = "/document";

export type DocumentApiError = {
  ok: false;
  error: {
    kind: string;
    message: string;
    issues?: InspectGraphValidationIssue[];
  };
};

export type LoadDocumentSuccess = {
  ok: true;
  document: NodebookDocumentV1;
  path: string;
};

export type LoadDocumentResult =
  | LoadDocumentSuccess
  | DocumentApiError;

export type SaveDocumentResult =
  | LoadDocumentSuccess
  | DocumentApiError;

export class DocumentApiRequestError extends Error {
  readonly issues: InspectGraphValidationIssue[];

  constructor(message: string, issues: InspectGraphValidationIssue[] = []) {
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

export async function saveDocument(
  document: NodebookDocumentV1,
): Promise<LoadDocumentSuccess> {
  const response = await nodebookFetch(activeDocumentPath, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(document),
  });
  const result = await response.json() as SaveDocumentResult;

  if (!result.ok) {
    throw new DocumentApiRequestError(
      result.error.message,
      result.error.issues,
    );
  }

  return result;
}
