import type { DocumentOperation } from "./api/documents.ts";
import { documentOperationAffectsExecution } from "./documentOperations.ts";

export type DocumentReloadSnapshot = {
  editGeneration: number;
  pendingOperationCount: number;
  saveAttemptGeneration: number;
};

export function shouldPreserveExecutionSessionOnReload(options: {
  currentSourceRevision: string;
  loadedSourceRevision: string;
  pendingOperations: DocumentOperation[];
}): boolean {
  return options.currentSourceRevision.length > 0 &&
    options.currentSourceRevision === options.loadedSourceRevision &&
    !options.pendingOperations.some(documentOperationAffectsExecution);
}

export function shouldAutoReloadDocument(options: {
  pendingOperationCount: number;
  saveInFlight: boolean;
  saveOutcomeUnknown: boolean;
}): boolean {
  return options.pendingOperationCount === 0 && !options.saveInFlight &&
    !options.saveOutcomeUnknown;
}

export function canEditDocument(options: {
  readOnly: boolean;
  saveOutcomeUnknown: boolean;
}): boolean {
  return !options.readOnly && !options.saveOutcomeUnknown;
}

export function canApplyLoadedDocument(
  started: DocumentReloadSnapshot,
  current: DocumentReloadSnapshot & { saveInFlight: boolean },
): boolean {
  if (
    current.saveInFlight ||
    current.saveAttemptGeneration !== started.saveAttemptGeneration
  ) {
    return false;
  }

  return current.editGeneration === started.editGeneration &&
    current.pendingOperationCount === started.pendingOperationCount;
}
