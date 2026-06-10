import { Handle, type NodeProps, NodeToolbar, Position } from "@xyflow/react";
import { Play, Plus, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
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
  const status = statusStyles[data.runStatus];
  const runToNodeTitle = data.runToNodeDisabled
    ? "Run unavailable"
    : "Run upstream to this step";
  const description = data.description?.trim();

  return (
    <article
      title={`${data.functionName ?? data.label}\n${data.nodeId}`}
      className={[
        "relative",
        "w-[360px] rounded-md border bg-white shadow-sm",
        selected ? "border-zinc-900 shadow-md" : status.border,
      ].join(" ")}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="h-3 w-3 border-2 border-white bg-zinc-500"
      />
      <div className="cursor-grab border-b border-zinc-200 px-3 py-2 active:cursor-grabbing">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-zinc-950">
              {data.label}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-400">
              {data.functionName ?? data.nodeId}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {data.onRunToNode && (
              <button
                type="button"
                aria-label={`Run upstream to ${data.label}`}
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
          </div>
        </div>
      </div>

      <div className="space-y-3 px-3 py-3">
        {description && (
          <p className="line-clamp-2 min-h-9 text-xs leading-[18px] text-zinc-600">
            {description}
          </p>
        )}
        <PortList title="Inputs" ports={data.inputs} emptyLabel="none" />
        <PortList
          title="Outputs"
          ports={data.outputs.map((name) => ({
            name,
            type: data.outputPreviews[name],
          }))}
          emptyLabel="none"
          variant="output"
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

function PortList({
  title,
  ports,
  emptyLabel,
  variant = "input",
}: {
  title: string;
  ports: Array<{ name: string; type?: string }>;
  emptyLabel: string;
  variant?: "input" | "output";
}) {
  const chipClassName = variant === "output"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : "border-sky-200 bg-sky-50 text-sky-800";

  return (
    <section>
      <p className="text-[10px] font-medium uppercase leading-none text-zinc-500">
        {title}
      </p>
      {ports.length === 0
        ? <p className="mt-1.5 text-xs text-zinc-400">{emptyLabel}</p>
        : (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {ports.map((port) => (
              <span
                key={port.name}
                className={[
                  "max-w-full truncate rounded border px-2 py-1 font-mono text-[11px] leading-none",
                  chipClassName,
                ].join(" ")}
                title={port.type ? `${port.name} · ${port.type}` : port.name}
              >
                {port.name}
                {port.type && (
                  <span className="text-current opacity-60">
                    {" · "}
                    {formatPythonType(port.type)}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
    </section>
  );
}
