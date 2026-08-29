import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createImportedFileNode,
  ensurePolarsGlobalsImport,
  importAutoPreviewSkipReason,
  importedFileKind,
} from "./importedFile.ts";

Deno.test("importedFileKind recognizes supported suffixes case-insensitively", () => {
  assertEquals(
    ["orders.csv", "events.TSV", "snapshot.Parquet", "survey.xlsx"].map(
      importedFileKind,
    ),
    ["csv", "tsv", "parquet", "unsupported"],
  );
});

Deno.test("CSV imports generate a readable Polars source node", () => {
  const result = createImportedFileNode({
    id: "n_import",
    storedName: "Customer Orders.csv",
    relativePath: "data/Customer Orders.csv",
    position: { x: 12, y: 34 },
    existingFunctionNames: [],
  });

  assertEquals(result.kind, "csv");
  assertEquals(result.node.functionName, "load_customer_orders");
  assertEquals(result.node.title, "Load Customer Orders.csv");
  assertEquals(result.node.outputs, ["customer_orders"]);
  assertEquals(result.node.position, { x: 12, y: 34 });
  assertEquals(
    result.node.code,
    [
      'source_path = "data/Customer Orders.csv"',
      "customer_orders = pl.read_csv(source_path, try_parse_dates=True)",
    ].join("\n"),
  );
});

Deno.test("Polars imports are added to globals once", () => {
  assertEquals(
    ensurePolarsGlobalsImport("from pathlib import Path"),
    "from pathlib import Path\n\nimport polars as pl",
  );
  assertEquals(
    ensurePolarsGlobalsImport("import pandas as pd\nimport polars as pl"),
    "import pandas as pd\nimport polars as pl",
  );
  assertEquals(
    ensurePolarsGlobalsImport("import os, polars as pl  # shared alias"),
    "import os, polars as pl  # shared alias",
  );
});

Deno.test("comments and strings do not satisfy the Polars globals import", () => {
  const globalsCode = [
    "# import polars as pl",
    'example = "import polars as pl"',
  ].join("\n");
  assertEquals(
    ensurePolarsGlobalsImport(globalsCode),
    `${globalsCode}\n\nimport polars as pl`,
  );
});

Deno.test("TSV and Parquet imports use their explicit readers", () => {
  const tsv = createImportedFileNode({
    id: "n_tsv",
    storedName: "events.tsv",
    relativePath: "data/events.tsv",
    position: { x: 0, y: 0 },
    existingFunctionNames: [],
  });
  const parquet = createImportedFileNode({
    id: "n_parquet",
    storedName: "events.parquet",
    relativePath: "data/events.parquet",
    position: { x: 0, y: 0 },
    existingFunctionNames: [],
  });

  assertStringIncludes(tsv.node.code, 'separator="\\t"');
  assertStringIncludes(parquet.node.code, "pl.read_parquet(source_path)");
});

Deno.test("unsupported imports generate an editable file-path node", () => {
  const result = createImportedFileNode({
    id: "n_file",
    storedName: "2026 survey.xlsx",
    relativePath: "data/2026 survey.xlsx",
    position: { x: 0, y: 0 },
    existingFunctionNames: ["load_data_2026_survey_file"],
  });

  assertEquals(result.kind, "unsupported");
  assertEquals(result.node.functionName, "load_data_2026_survey_file_2");
  assertEquals(result.node.title, "File 2026 survey.xlsx");
  assertEquals(result.node.outputs, ["data_2026_survey_file"]);
  assertEquals(
    result.node.code,
    [
      'source_path = "data/2026 survey.xlsx"',
      "data_2026_survey_file = source_path",
    ].join("\n"),
  );
});

Deno.test("auto-preview runs only for a clean, idle, ready document", () => {
  const ready = {
    hadUnsavedWork: false,
    hadRuntimeMaintenance: false,
    runtimeMaintenanceNow: false,
    runtimeWasReady: true,
    runtimeIsReady: true,
  };

  assertEquals(importAutoPreviewSkipReason(ready), null);
  assertEquals(
    importAutoPreviewSkipReason({ ...ready, hadUnsavedWork: true }),
    "unsaved_work",
  );
  assertEquals(
    importAutoPreviewSkipReason({ ...ready, runtimeIsReady: false }),
    "runtime_unavailable",
  );
});
