import { python } from "@codemirror/lang-python";
import CodeMirror from "@uiw/react-codemirror";
import { Handle, type NodeProps, NodeToolbar, Position } from "@xyflow/react";
import { Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";
import type {
  NodeRunVisualStatus,
  PythonFlowNode,
} from "../graph/toReactFlow.ts";

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
  const extensions = useMemo(() => [python()], []);
  const outputs = data.outputs.length > 0 ? data.outputs.join(", ") : "none";
  const status = statusStyles[data.runStatus];
  const canEdit = Boolean(data.onCodeChange);
  const isSelected = Boolean(selected);
  const preview = data.preview;
  const showOutputs = preview?.ok && preview.outputs.length > 0;
  const showStdout = Boolean(preview?.stdout);
  const showStderr = Boolean(preview?.stderr);
  const showError = Boolean(preview?.error);
  const hasPreview = showOutputs || showStdout || showStderr || showError;
  const hasStalePreview = data.runStatus === "stale" && hasPreview;
  const showPreviewBody = hasPreview && !hasStalePreview;

  return (
    <article
      className={[
        "relative",
        "w-[480px] rounded-lg border bg-white shadow-sm",
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
        <p className="mt-1 truncate text-xs text-zinc-500">
          outputs: {outputs}
        </p>
      </div>
      <div className="nodrag nopan p-2">
        {isSelected
          ? (
            <div className="[&_.cm-editor]:max-h-[180px] [&_.cm-editor]:rounded-md [&_.cm-editor]:text-xs [&_.cm-scroller]:font-mono">
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
          )
          : <CodePreview value={data.code} />}
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
          {showOutputs && preview && (
            <div className="flex flex-wrap gap-1.5">
              {preview.outputs.map((output) => (
                <span
                  key={output.name}
                  className="max-w-full truncate rounded border border-emerald-200 bg-emerald-50 px-2 py-1 font-mono text-[11px] leading-none text-emerald-800"
                  title={`${output.name} · ${output.type}`}
                >
                  {output.name} · {output.type}
                </span>
              ))}
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
              title="Add child node"
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
