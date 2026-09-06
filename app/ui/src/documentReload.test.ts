import { assertEquals } from "@std/assert";
import {
  canApplyLoadedDocument,
  canEditDocument,
  shouldAutoReloadDocument,
  shouldPreserveExecutionSessionOnReload,
} from "./documentReload.ts";

Deno.test("sidecar-only reloads preserve execution results", () => {
  assertEquals(
    shouldPreserveExecutionSessionOnReload({
      currentSourceRevision: "source-1",
      loadedSourceRevision: "source-1",
      pendingOperations: [{
        type: "move_node",
        nodeId: "n_test",
        position: { x: 10, y: 20 },
      }],
    }),
    true,
  );
});

Deno.test("source changes and pending executable edits do not preserve execution results", () => {
  assertEquals(
    shouldPreserveExecutionSessionOnReload({
      currentSourceRevision: "source-1",
      loadedSourceRevision: "source-2",
      pendingOperations: [],
    }),
    false,
  );
  assertEquals(
    shouldPreserveExecutionSessionOnReload({
      currentSourceRevision: "source-1",
      loadedSourceRevision: "source-1",
      pendingOperations: [{
        type: "update_node_body",
        nodeId: "n_test",
        code: "value = 2",
      }],
    }),
    false,
  );
});

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
