import type { RuntimeNode } from "./graph/runtimeTypes.ts";
import { isValidPythonIdentifier } from "./graph/nodeNames.ts";

export type ImportedFileKind = "csv" | "tsv" | "parquet" | "unsupported";
export type ImportAutoPreviewSkipReason =
  | "unsaved_work"
  | "runtime_unavailable";

export function importAutoPreviewSkipReason(state: {
  hadUnsavedWork: boolean;
  hadRuntimeMaintenance: boolean;
  runtimeMaintenanceNow: boolean;
  runtimeWasReady: boolean;
  runtimeIsReady: boolean;
}): ImportAutoPreviewSkipReason | null {
  if (state.hadUnsavedWork) return "unsaved_work";
  if (
    state.hadRuntimeMaintenance || state.runtimeMaintenanceNow ||
    !state.runtimeWasReady || !state.runtimeIsReady
  ) {
    return "runtime_unavailable";
  }
  return null;
}

export function importedFileKind(storedName: string): ImportedFileKind {
  const lowerName = storedName.toLowerCase();
  if (lowerName.endsWith(".csv")) return "csv";
  if (lowerName.endsWith(".tsv")) return "tsv";
  if (lowerName.endsWith(".parquet")) return "parquet";
  return "unsupported";
}

export function ensurePolarsGlobalsImport(globalsCode: string): string {
  if (hasPolarsGlobalsImport(globalsCode)) return globalsCode;
  if (!globalsCode) return "import polars as pl";

  const separator = globalsCode.endsWith("\n\n")
    ? ""
    : globalsCode.endsWith("\n")
    ? "\n"
    : "\n\n";
  return `${globalsCode}${separator}import polars as pl`;
}

export function createImportedFileNode(options: {
  id: string;
  storedName: string;
  relativePath: string;
  position: { x: number; y: number };
  existingFunctionNames: Iterable<string>;
}): { node: RuntimeNode; kind: ImportedFileKind } {
  const kind = importedFileKind(options.storedName);
  const baseIdentifier = identifierFromStoredName(options.storedName, kind);
  const outputName = kind === "unsupported"
    ? `${baseIdentifier}_file`
    // A local named pl would shadow the shared Polars import in the reader.
    : baseIdentifier === "pl"
    ? "pl_data"
    : baseIdentifier;
  const functionName = uniqueFunctionName(
    `load_${outputName}`,
    new Set(options.existingFunctionNames),
  );
  const pathLiteral = pythonStringLiteral(options.relativePath);
  const code = readerCode(kind, outputName, pathLiteral);

  return {
    kind,
    node: {
      id: options.id,
      functionName,
      title: kind === "unsupported"
        ? `File ${options.storedName}`
        : `Load ${options.storedName}`,
      description: `Imported from ${options.relativePath}.`,
      parameters: [],
      code,
      outputs: [outputName],
      customReturn: false,
      editable: true,
      position: options.position,
    },
  };
}

function readerCode(
  kind: ImportedFileKind,
  outputName: string,
  pathLiteral: string,
): string {
  if (kind === "unsupported") {
    return [
      `source_path = ${pathLiteral}`,
      `${outputName} = source_path`,
    ].join("\n");
  }

  const readExpression = kind === "parquet"
    ? `pl.read_parquet(source_path)`
    : kind === "tsv"
    ? `pl.read_csv(source_path, separator="\\t", try_parse_dates=True)`
    : `pl.read_csv(source_path, try_parse_dates=True)`;
  return [
    `source_path = ${pathLiteral}`,
    `${outputName} = ${readExpression}`,
  ].join("\n");
}

function hasPolarsGlobalsImport(globalsCode: string): boolean {
  for (const line of globalsCode.split(/\r?\n/u)) {
    const importList = /^\s*import\s+([^#]+?)(?:\s*#.*)?$/u.exec(line)?.[1];
    if (
      importList?.split(",").some((entry) =>
        /^polars\s+as\s+pl$/u.test(entry.trim())
      )
    ) {
      return true;
    }
  }
  return false;
}

function identifierFromStoredName(
  storedName: string,
  kind: ImportedFileKind,
): string {
  const knownSuffix = kind === "unsupported" ? "" : `.${kind}`;
  const withoutKnownSuffix = knownSuffix &&
      storedName.toLowerCase().endsWith(knownSuffix)
    ? storedName.slice(0, -knownSuffix.length)
    : stripLastExtension(storedName);
  let identifier = withoutKnownSuffix
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^A-Za-z0-9_]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
  if (!identifier) identifier = "data";
  if (/^[0-9]/u.test(identifier)) identifier = `data_${identifier}`;
  identifier = identifier.slice(0, 64).replace(/_+$/u, "") || "data";
  if (!isValidPythonIdentifier(identifier)) identifier = `${identifier}_data`;
  return identifier;
}

function stripLastExtension(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index > 0 ? filename.slice(0, index) : filename;
}

function uniqueFunctionName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let index = 2; index <= 10_000; index += 1) {
    const candidate = `${base}_${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function pythonStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
