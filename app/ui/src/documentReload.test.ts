import { assertEquals } from "@std/assert";
import {
  canApplyLoadedDocument,
  canEditDocument,
  shouldAutoReloadDocument,
} from "./documentReload.ts";

Deno.test("unknown save outcome makes an otherwise editable document non-editable", () => {
  assertEquals(
    canEditDocument({ readOnly: false, saveOutcomeUnknown: true }),
    false,
  );
});

Deno.test("status polling never auto-reloads an unknown save outcome", () => {
  assertEquals(
    shouldAutoReloadDocument({
      pendingOperationCount: 0,
      saveInFlight: false,
      saveOutcomeUnknown: true,
    }),
    false,
  );
});

Deno.test("status polling never auto-reloads while a save is active", () => {
  assertEquals(
    shouldAutoReloadDocument({
      pendingOperationCount: 0,
      saveInFlight: true,
      saveOutcomeUnknown: false,
    }),
    false,
  );
});

Deno.test("reload cannot apply if a save overlapped the disk read", () => {
  const started = {
    editGeneration: 4,
    pendingOperationCount: 0,
    saveAttemptGeneration: 2,
  };

  assertEquals(
    canApplyLoadedDocument(
      started,
      { ...started, saveAttemptGeneration: 3, saveInFlight: false },
    ),
    false,
  );
  assertEquals(
    canApplyLoadedDocument(
      started,
      { ...started, saveInFlight: true },
    ),
    false,
  );
});

Deno.test("automatic reload cannot discard edits made during its disk read", () => {
  const started = {
    editGeneration: 4,
    pendingOperationCount: 0,
    saveAttemptGeneration: 2,
  };

  assertEquals(
    canApplyLoadedDocument(
      started,
      {
        ...started,
        editGeneration: 5,
        pendingOperationCount: 1,
        saveInFlight: false,
      },
    ),
    false,
  );
});
