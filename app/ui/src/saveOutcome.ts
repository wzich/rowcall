import { DocumentApiRequestError } from "./api/documents.ts";

export type SaveFailureDisposition = "definite_rejection" | "unknown_outcome";

const definiteRejectionKinds = new Set([
  "document_decode_error",
  "invalid_json",
  "invalid_request",
  "stale_document",
  "validation_error",
]);

/**
 * Only errors that explicitly describe request rejection or pre-commit
 * validation establish that no write occurred. In particular, a structured
 * `document_write_error` may have happened during or after commit and remains
 * uncertain, just like transport, decoding, and unexpected failures.
 */
export function classifySaveFailure(error: unknown): SaveFailureDisposition {
  return error instanceof DocumentApiRequestError &&
      definiteRejectionKinds.has(error.kind)
    ? "definite_rejection"
    : "unknown_outcome";
}
