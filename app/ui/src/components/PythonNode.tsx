import { python } from "@codemirror/lang-python";
import CodeMirror from "@uiw/react-codemirror";
import { Handle, type NodeProps, NodeToolbar, Position } from "@xyflow/react";
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

  return (
    <article
      className={[
        "relative",
        "w-[360px] rounded-lg border bg-white shadow-sm",
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
      <div className="nodrag nopan p-2 [&_.cm-editor]:max-h-[180px] [&_.cm-editor]:rounded-md [&_.cm-editor]:text-xs [&_.cm-scroller]:font-mono">
        <CodeMirror
          value={data.code}
          extensions={extensions}
          readOnly={!canEdit}
          onChange={(value) => data.onCodeChange?.(id, value)}
          basicSetup={{
            autocompletion: false,
            closeBrackets: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            lineNumbers: false,
          }}
          theme="light"
        />
      </div>
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
              className="flex h-7 w-7 items-center justify-center rounded-full border border-zinc-300 bg-white text-base font-semibold text-zinc-700 hover:bg-zinc-100"
              onClick={() => data.onAddChild?.(id)}
            >
              +
            </button>
          )}
          {data.onDelete && (
            <button
              type="button"
              aria-label={`Delete node ${data.label}`}
              title="Delete node"
              className="flex h-7 w-7 items-center justify-center rounded border border-red-200 text-xs font-semibold text-red-600 hover:bg-red-50"
              onClick={() => data.onDelete?.(id)}
            >
              x
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
