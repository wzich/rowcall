export type DocumentReloadSnapshot = {
  editGeneration: number;
  pendingOperationCount: number;
  saveAttemptGeneration: number;
};

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
