import { assertEquals } from "@std/assert";
import type { RowcallDocumentV1 } from "./graph/documentTypes.ts";
import { formatSaveReconciliationNotice } from "./saveReconciliation.ts";

function documentWithDeclarations(
  outputs: string[],
  views: string[],
): RowcallDocumentV1 {
  return {
    version: 1,
    nodes: [{
      id: "n_start",
      functionName: "start",
      code: "pass",
      outputs,
      views,
    }],
    edges: [],
  };
}

Deno.test("save reconciliation notice describes automatically removed declarations", () => {
  const notice = formatSaveReconciliationNotice(
    documentWithDeclarations(["message", "kept"], ["chart"]),
    documentWithDeclarations(["kept"], []),
  );

  assertEquals(
    notice,
    'Removed stale declarations while saving: output "message" from start and view "chart" from start.',
  );
});

Deno.test("save reconciliation notice ignores unchanged and deleted nodes", () => {
  const unchanged = documentWithDeclarations(["message"], []);
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
