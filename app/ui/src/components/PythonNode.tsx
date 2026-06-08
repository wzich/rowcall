import { python } from "@codemirror/lang-python";
import { keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { Handle, type NodeProps, NodeToolbar, Position } from "@xyflow/react";
import { Check, Play, Plus, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
import { useMemo } from "react";
import type { TableCellPreview, TablePreview } from "../../../../types.ts";
import type {
  NodeRunVisualStatus,
  PythonFlowNode,
} from "../graph/toReactFlow.ts";
import { formatPythonType } from "../graph/pythonTypeLabels.ts";

const statusStyles: Record<
  NodeRunVisualStatus,
  { border: string; dot: string; label: string }
> = {
  idle: {
    border: "border-zinc-300",
    dot: "bg-zinc-300",
    label: "Idle",
  },
  stale: {
    border: "border-amber-400",
    dot: "bg-amber-400",
    label: "Stale",
  },
  queued: {
    border: "border-zinc-400",
    dot: "bg-zinc-400",
    label: "Queued",
  },
  running: {
    border: "border-blue-400",
    dot: "bg-blue-500",
    label: "Running",
  },
  completed: {
    border: "border-emerald-500",
    dot: "bg-emerald-500",
    label: "Completed",
  },
  failed: {
    border: "border-red-500",
    dot: "bg-red-500",
    label: "Failed",
  },
};

export function PythonNode({ data, id, selected }: NodeProps<PythonFlowNode>) {
  const extensions = useMemo(() => [
    python(),
    keymap.of([
      {
        key: "Shift-Enter",
        run: () => {
          if (!data.onRunToNode || data.runToNodeDisabled) {
            return true;
          }

          data.onRunToNode(id);
          return true;
        },
      },
      {
        key: "Mod-s",
        run: () => {
          data.onSaveDocument?.();
          return true;
        },
      },
    ]),
  ], [data.onRunToNode, data.onSaveDocument, data.runToNodeDisabled, id]);
  const status = statusStyles[data.runStatus];
  const canEdit = Boolean(data.onCodeChange);
  const isSelected = Boolean(selected);
  const outputsReadOnly = data.outputsReadOnly || !data.editable;
  const runToNodeTitle = data.runToNodeDisabled
    ? "Run unavailable"
    : "Run to node (Shift+Enter)";
  const preview = data.preview;
  const previewOutputsByName = new Map(
    preview?.ok ? preview.outputs.map((output) => [output.name, output]) : [],
  );
  const showRuntimeOutputTypes = data.outputs.some((output) =>
    previewOutputsByName.has(output)
  );
  const showStdout = Boolean(preview?.stdout);
  const showStderr = Boolean(preview?.stderr);
  const showError = Boolean(preview?.error);
  const tablePreviews = preview?.ok ? getNodeTablePreviews(preview) : [];
  const visibleTablePreviews = tablePreviews.slice(0, 2);
  const hiddenTablePreviewCount = Math.max(
    0,
    tablePreviews.length - visibleTablePreviews.length,
  );
  const showTables = visibleTablePreviews.length > 0;
  const hasPreview = showRuntimeOutputTypes || showTables || showStdout ||
    showStderr || showError;
  const hasStalePreview = data.runStatus === "stale" && hasPreview;
  const showPreviewBody = (showTables || showStdout || showStderr || showError) &&
    !hasStalePreview;

  const handleOutputToggle = (name: string) => {
    if (outputsReadOnly || !data.onOutputsChange) return;

    const selectedOutputs = new Set(data.outputs);
    if (selectedOutputs.has(name)) {
      selectedOutputs.delete(name);
    } else {
      selectedOutputs.add(name);
    }

    data.onOutputsChange(
      id,
      data.outputOptions
        .map((option) => option.name)
        .filter((optionName) => selectedOutputs.has(optionName)),
    );
  };

  return (
    <article
      className={[
        "relative",
        "w-[800px] rounded-lg border bg-white shadow-sm",
        selected ? "border-zinc-900" : status.border,
      ].join(" ")}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="h-3 w-3 border-2 border-white bg-zinc-500"
      />
      <div className="cursor-grab border-b border-zinc-200 px-3 py-2 active:cursor-grabbing">
        <div className="flex items-center justify-between gap-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-950">
            {data.label}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            {data.onRunToNode && (
              <button
                type="button"
                aria-label={`Run to node ${data.label}`}
                title={runToNodeTitle}
                disabled={data.runToNodeDisabled}
                className="nodrag nopan flex h-7 w-7 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-300"
                onClick={(event: MouseEvent<HTMLButtonElement>) => {
                  event.stopPropagation();
                  data.onRunToNode?.(id);
                }}
              >
                <Play
                  aria-hidden="true"
                  className="h-3.5 w-3.5"
                  strokeWidth={2.5}
                />
              </button>
            )}
            <span
              className={[
                "h-2.5 w-2.5 shrink-0 rounded-full",
                data.runStatus === "running" ? "animate-pulse" : "",
                status.dot,
              ].join(" ")}
              title={status.label}
              aria-label={status.label}
            />
            <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
              Python
            </span>
          </div>
        </div>
      </div>
      <div className="nodrag nopan p-2">
        {isSelected
          ? (
            <div className="[&_.cm-editor]:max-h-[180px] [&_.cm-editor]:rounded-md [&_.cm-editor]:text-xs [&_.cm-scroller]:font-mono">
              <div data-shortcut-scope="editor">
                <CodeMirror
                  value={data.code}
                  extensions={extensions}
                  readOnly={!canEdit}
                  onChange={(value) => data.onCodeChange?.(id, value)}
                  basicSetup={{
                    autocompletion: false,
                    closeBrackets: true,
                    foldGutter: false,
                    highlightActiveLine: false,
                    highlightActiveLineGutter: true,
                    lineNumbers: false,
                  }}
                  theme="light"
                />
              </div>
            </div>
          )
          : <CodePreview value={data.code} />}
      </div>
      <div className="border-t border-zinc-200 px-3 py-2">
        {isSelected
          ? (
            <OutputChecklist
              outputs={data.outputs}
              outputOptions={data.outputOptions}
              readOnly={outputsReadOnly}
              onToggle={handleOutputToggle}
            />
          )
          : (
            <OutputChips
              outputs={data.outputs}
              previewOutputsByName={previewOutputsByName}
            />
          )}
      </div>
      {hasStalePreview && (
        <div className="border-t border-zinc-200 px-3 py-2">
          <p className="text-[11px] font-medium uppercase text-amber-700">
            Stale preview
          </p>
        </div>
      )}
      {showPreviewBody && (
        <div className="space-y-2 border-t border-zinc-200 px-3 py-2">
          {showTables && (
            <div className="space-y-2">
              {visibleTablePreviews.map((tablePreview) => (
                <CompactTablePreview
                  key={tablePreview.key}
                  title={tablePreview.title}
                  table={tablePreview.table}
                />
              ))}
              {hiddenTablePreviewCount > 0 && (
                <p className="text-[11px] text-zinc-500">
                  +{hiddenTablePreviewCount} more table preview
                  {hiddenTablePreviewCount === 1 ? "" : "s"}
                </p>
              )}
            </div>
          )}
          {showStdout && preview && (
            <TextPreviewBlock title="stdout" value={preview.stdout} />
          )}
          {showStderr && preview && (
            <TextPreviewBlock
              title="stderr"
              value={preview.stderr}
              variant="danger"
            />
          )}
          {showError && preview?.error && (
            <TextPreviewBlock
              title="error"
              value={preview.error}
              variant="danger"
            />
          )}
        </div>
      )}
      <NodeToolbar
        isVisible={selected}
        position={Position.Bottom}
        offset={12}
      >
        <div className="flex items-center gap-2 rounded border border-zinc-200 bg-white p-1 shadow-sm">
          {data.onAddChild && (
            <button
              type="button"
              aria-label={`Add child node after ${data.label}`}
              title="Add child node (A)"
              className="flex h-7 w-7 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100"
              onClick={() => data.onAddChild?.(id)}
            >
              <Plus aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
            </button>
          )}
          {data.onDelete && (
            <button
              type="button"
              aria-label={`Delete node ${data.label}`}
              title="Delete node"
              className="flex h-7 w-7 items-center justify-center rounded border border-red-200 text-red-600 hover:bg-red-50"
              onClick={() => data.onDelete?.(id)}
            >
              <Trash2
                aria-hidden="true"
                className="h-3.5 w-3.5"
                strokeWidth={2.25}
              />
            </button>
          )}
        </div>
      </NodeToolbar>
      <Handle
        type="source"
        position={Position.Bottom}
        className="h-3 w-3 border-2 border-white bg-zinc-500"
      />
    </article>
  );
}

function getNodeTablePreviews(
  preview: NonNullable<PythonFlowNode["data"]["preview"]>,
): Array<{ key: string; title: string; table: TablePreview }> {
  const outputEvents = preview.outputEvents ?? [];
  return outputEvents.flatMap((event, index) =>
    event.kind === "display" && event.value.table
      ? [{
        key: `display:${index}`,
        title: `display ${index + 1}`,
        table: event.value.table,
      }]
      : []
  );
}

function CompactTablePreview({
  title,
  table,
}: {
  title: string;
  table: TablePreview;
}) {
  const columns = Array.isArray(table.columns) ? table.columns.slice(0, 5) : [];
  const rows = Array.isArray(table.rows) ? table.rows.slice(0, 5) : [];
  const rowIndexes = Array.isArray(table.index) ? table.index.slice(0, 5) : null;
  if (columns.length === 0) {
    return null;
  }
  const clippedRows = table.rowCount > rows.length;
  const clippedColumns = table.columnCount > columns.length;

  return (
    <div className="overflow-hidden rounded border border-zinc-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-2 py-1">
        <span className="min-w-0 truncate font-mono text-[11px] font-semibold text-zinc-800">
          {title}
        </span>
        <span className="shrink-0 text-[10px] text-zinc-500">
          {table.rowCount} x {table.columnCount}
        </span>
      </div>
      <div className="overflow-hidden">
        <table className="w-full table-fixed border-separate border-spacing-0 text-left text-[10px]">
          <thead className="bg-zinc-100 text-zinc-600">
            <tr>
              {rowIndexes && (
                <th className="w-14 border-b border-r border-zinc-200 px-1.5 py-1 font-medium">
                  index
                </th>
              )}
              {columns.map((column) => (
                <th
                  key={column.name}
                  className="border-b border-r border-zinc-200 px-1.5 py-1 font-medium last:border-r-0"
                >
                  <span className="block truncate" title={column.name}>
                    {column.name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-white even:bg-zinc-50">
                {rowIndexes && (
                  <td className="border-b border-r border-zinc-100 px-1.5 py-1 font-mono text-zinc-500">
                    <CompactCellValue value={rowIndexes[rowIndex] ?? null} />
                  </td>
                )}
                {columns.map((column, columnIndex) => (
                  <td
                    key={column.name}
                    className="border-b border-r border-zinc-100 px-1.5 py-1 last:border-r-0"
                  >
                    <CompactCellValue
                      value={Array.isArray(row) ? row[columnIndex] ?? null : null}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(table.truncated || clippedRows || clippedColumns) && (
        <p className="border-t border-zinc-200 bg-zinc-50 px-2 py-1 text-[10px] text-zinc-500">
          Showing {rows.length} of {table.rowCount} rows and {columns.length} of{" "}
          {table.columnCount} columns
        </p>
      )}
    </div>
  );
}

function CompactCellValue({ value }: { value: TableCellPreview }) {
  const rendered = renderCompactCellValue(value);
  return (
    <span
      className={[
        "block truncate",
        rendered.muted ? "text-zinc-400" : "text-zinc-800",
        rendered.mono ? "font-mono" : "",
      ].join(" ")}
      title={rendered.title}
    >
      {rendered.label}
    </span>
  );
}

function renderCompactCellValue(
  value: TableCellPreview,
): { label: string; title: string; muted: boolean; mono: boolean } {
  if (value === null) {
    return { label: "null", title: "null", muted: true, mono: true };
  }
  if (typeof value === "string") {
    return { label: value, title: value, muted: false, mono: false };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const label = String(value);
    return { label, title: label, muted: false, mono: true };
  }
  if (value.kind === "nan") {
    return { label: "NaN", title: "NaN", muted: true, mono: true };
  }
  return {
    label: value.value,
    title: value.value,
    muted: false,
    mono: value.kind === "datetime",
  };
}

function OutputChecklist({
  outputs,
  outputOptions,
  readOnly,
  onToggle,
}: {
  outputs: string[];
  outputOptions: PythonFlowNode["data"]["outputOptions"];
  readOnly: boolean;
  onToggle: (name: string) => void;
}) {
  if (outputOptions.length === 0) {
    return (
      <div className="space-y-1">
        <OutputFooterLabel />
        <p className="text-xs text-zinc-500">no outputs</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <OutputFooterLabel />
        <span className="text-[11px] text-zinc-500">
          {outputs.length} selected
        </span>
      </div>
      <div className="grid max-h-32 grid-cols-2 gap-1.5 overflow-auto">
        {outputOptions.map((option) => {
          const checked = outputs.includes(option.name);
          return (
            <label
              key={option.name}
              className={`nodrag nopan flex min-w-0 items-center gap-1.5 rounded border px-2 py-1.5 text-xs ${
                checked
                  ? "border-zinc-300 bg-white text-zinc-900"
                  : "border-zinc-200 bg-zinc-50 text-zinc-500"
              } ${
                readOnly
                  ? "cursor-not-allowed opacity-70"
                  : "cursor-pointer hover:bg-zinc-100"
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={checked}
                disabled={readOnly}
                onChange={() => onToggle(option.name)}
              />
              <span
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                  checked
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-300 bg-white"
                }`}
                aria-hidden="true"
              >
                {checked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
              </span>
              <code className="min-w-0 flex-1 truncate font-mono text-[11px]">
                {option.name}
              </code>
              <span className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] text-zinc-500">
                {option.source}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function OutputChips({
  outputs,
  previewOutputsByName,
}: {
  outputs: string[];
  previewOutputsByName: Map<string, { name: string; type: string }>;
}) {
  return (
    <div className="space-y-1.5">
      <OutputFooterLabel />
      {outputs.length === 0
        ? <p className="text-xs text-zinc-500">no outputs</p>
        : (
          <div className="flex flex-wrap gap-1.5">
            {outputs.map((name) => {
              const previewOutput = previewOutputsByName.get(name);
              const label = previewOutput
                ? `${name} · ${formatPythonType(previewOutput.type)}`
                : name;
              const title = previewOutput
                ? `${name} · ${previewOutput.type}`
                : name;
              return (
                <span
                  key={name}
                  className="max-w-full truncate rounded border border-emerald-200 bg-emerald-50 px-2 py-1 font-mono text-[11px] leading-none text-emerald-800"
                  title={title}
                >
                  {label}
                </span>
              );
            })}
          </div>
        )}
    </div>
  );
}

function OutputFooterLabel() {
  return (
    <p className="text-[10px] font-medium uppercase leading-none text-zinc-500">
      Outputs
    </p>
  );
}

function CodePreview({ value }: { value: string }) {
  const preview = truncateCodePreview(value);
  const isTruncated = preview !== value.replace(/\s+$/u, "");

  return (
    <pre
      className="max-h-[120px] overflow-hidden whitespace-pre-wrap break-words rounded-md bg-zinc-50 px-2 py-1.5 font-mono text-xs leading-5 text-zinc-800"
      title={isTruncated ? "Code preview is truncated" : undefined}
    >
      {preview}
    </pre>
  );
}

function TextPreviewBlock({
  title,
  value,
  variant = "default",
}: {
  title: string;
  value: string;
  variant?: "default" | "danger";
}) {
  const truncated = truncatePreviewText(value);
  const isTruncated = truncated !== value;
  const className = variant === "danger"
    ? "border-red-200 bg-red-50 text-red-900"
    : "border-zinc-200 bg-zinc-50 text-zinc-800";

  return (
    <div className={["rounded border p-2", className].join(" ")}>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">
        {title}
      </div>
      <pre
        className="max-h-28 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-4"
        title={isTruncated ? value : undefined}
      >
        {truncated}
      </pre>
    </div>
  );
}

function truncateCodePreview(value: string): string {
  const normalized = value.replace(/\s+$/u, "");
  const maxLength = 420;
  const maxLines = 6;
  const lines = normalized.split(/\r?\n/u);
  const lineLimited = lines.length > maxLines
    ? `${lines.slice(0, maxLines).join("\n")}\n...`
    : normalized;

  if (lineLimited.length <= maxLength) {
    return lineLimited;
  }

  return `${lineLimited.slice(0, maxLength)}...`;
}

function truncatePreviewText(value: string): string {
  const normalized = value.replace(/\s+$/u, "");
  const maxLength = 700;
  const lines = normalized.split(/\r?\n/u);
  const lineLimited = lines.length > 8
    ? `${lines.slice(0, 8).join("\n")}\n...`
    : normalized;

  if (lineLimited.length <= maxLength) {
    return lineLimited;
  }

  return `${lineLimited.slice(0, maxLength)}...`;
}
