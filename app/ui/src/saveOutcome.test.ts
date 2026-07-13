import { assertEquals } from "@std/assert";
import { DocumentApiRequestError } from "./api/documents.ts";
import { classifySaveFailure } from "./saveOutcome.ts";

Deno.test("structured document rejection has a definite save outcome", () => {
  assertEquals(
    classifySaveFailure(
      new DocumentApiRequestError("stale revision", {
        kind: "stale_document",
        status: 409,
      }),
    ),
    "definite_rejection",
  );
});

Deno.test("document write error leaves the save outcome unknown", () => {
  assertEquals(
    classifySaveFailure(
      new DocumentApiRequestError("write failed", {
        kind: "document_write_error",
        status: 500,
      }),
    ),
    "unknown_outcome",
  );
});

Deno.test("transport failure leaves the save outcome unknown", () => {
  assertEquals(
    classifySaveFailure(new TypeError("connection closed")),
    "unknown_outcome",
  );
});

Deno.test("unexpected response decoding failure leaves the outcome unknown", () => {
  assertEquals(
    classifySaveFailure(new SyntaxError("invalid JSON")),
    "unknown_outcome",
  );
});
