import type { InspectGraphValidationIssue } from "./inspectGraph.ts";
import type { NodebookDocumentV1 } from "../graph/documentTypes.ts";

const scratchDocumentPath = "/documents/scratch";

export type DocumentApiError = {
  ok: false;
  error: {
    kind: string;
    message: string;
    issues?: InspectGraphValidationIssue[];
  };
};

export type LoadScratchDocumentSuccess = {
  ok: true;
  document: NodebookDocumentV1;
  path: string;
};

export type LoadScratchDocumentResult =
  | LoadScratchDocumentSuccess
  | DocumentApiError;

export type SaveScratchDocumentResult =
  | LoadScratchDocumentSuccess
  | DocumentApiError;

export class DocumentApiRequestError extends Error {
  readonly issues: InspectGraphValidationIssue[];

  constructor(message: string, issues: InspectGraphValidationIssue[] = []) {
    super(message);
    this.name = "DocumentApiRequestError";
    this.issues = issues;
  }
}

export async function loadScratchDocument(): Promise<
  LoadScratchDocumentSuccess
> {
  const response = await fetch(scratchDocumentPath);
  const result = await response.json() as LoadScratchDocumentResult;

  if (!result.ok) {
    throw new DocumentApiRequestError(
      result.error.message,
      result.error.issues,
    );
  }

  return result;
}

export async function saveScratchDocument(
  document: NodebookDocumentV1,
): Promise<LoadScratchDocumentSuccess> {
  const response = await fetch(scratchDocumentPath, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(document),
  });
  const result = await response.json() as SaveScratchDocumentResult;

  if (!result.ok) {
    throw new DocumentApiRequestError(
      result.error.message,
      result.error.issues,
    );
  }

  return result;
}
