import { assertStringIncludes } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "npm:react-dom@19.2.5/server";
import type { TablePreview } from "../../../../types.ts";
import { ResultTable } from "./ResultTable.tsx";

function renderTable(table: TablePreview): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ResultTable
        identity={{ runId: "test-run", documentRevision: "test-revision" }}
        nodeId="source"
        outputName="data"
        initialTable={table}
      />
    </QueryClientProvider>,
  );
}

Deno.test("result table shows first-column types with and without a dataframe index", () => {
  const table: TablePreview = {
    columns: [{ name: "amount", dtype: "Float64" }],
    rows: [[12.5]],
    rowCount: 1,
    columnCount: 1,
    truncated: false,
  };
  for (const preview of [table, { ...table, index: [0] }]) {
    const html = renderTable(preview);
    assertStringIncludes(html, "Float64");
    assertStringIncludes(html, "12.5");
    assertStringIncludes(html, 'aria-sort="none"');
  }
});
