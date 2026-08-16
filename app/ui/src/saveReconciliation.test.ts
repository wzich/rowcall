import { assertEquals } from "@std/assert";
import type { RowcallDocumentV1 } from "./graph/documentTypes.ts";
import { formatSaveReconciliationNotice } from "./saveReconciliation.ts";

function documentWithDeclarations(
  outputs: string[],
): RowcallDocumentV1 {
  return {
    version: 1,
    nodes: [{
      id: "n_start",
      functionName: "start",
      code: "pass",
      outputs,
    }],
    edges: [],
  };
}

Deno.test("save reconciliation notice describes automatically removed declarations", () => {
  const notice = formatSaveReconciliationNotice(
    documentWithDeclarations(["message", "kept"]),
    documentWithDeclarations(["kept"]),
  );

  assertEquals(
    notice,
    'Removed stale declaration while saving: output "message" from start.',
  );
});

Deno.test("save reconciliation notice ignores unchanged and deleted nodes", () => {
  const unchanged = documentWithDeclarations(["message"]);
  assertEquals(formatSaveReconciliationNotice(unchanged, unchanged), null);
  assertEquals(
    formatSaveReconciliationNotice(unchanged, {
      version: 1,
      nodes: [],
      edges: [],
    }),
    null,
  );
});
