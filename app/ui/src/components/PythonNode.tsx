import { Handle, type NodeProps, NodeToolbar, Position } from "@xyflow/react";
import { Play, Plus } from "lucide-react";
import type { MouseEvent } from "react";
import type {
  NodeRunVisualStatus,
  PythonFlowNode,
} from "../graph/toReactFlow.ts";
import { formatPythonType } from "../graph/pythonTypeLabels.ts";

const statusStyles: Record<
  NodeRunVisualStatus,
  { dot: string; label: string }
> = {
  idle: {
    dot: "bg-zinc-300",
    label: "Not run",
  },
  stale: {
    dot: "bg-amber-400",
    label: "Code, outputs, or inputs changed since the last run",
  },
  queued: {
    dot: "bg-zinc-400",
    label: "Queued to run",
  },
  running: {
    dot: "bg-blue-500",
    label: "Running",
  },
  blocked: {
    dot: "bg-red-300",
    label: "Did not run because an upstream step failed",
  },
  completed: {
    dot: "bg-emerald-500",
    label: "Ran successfully",
  },
  failed: {
    dot: "bg-red-500",
    label: "Run failed",
  },
};

export function PythonNode({ data, id, selected }: NodeProps<PythonFlowNode>) {
  const status = statusStyles[data.runStatus];
  const isRunning = data.runStatus === "running";
  const runToNodeTitle = data.runToNodeDisabled
    ? "Run unavailable"
    : "Run upstream to this step";
  const description = data.description?.trim();
  const outputOptionsByName = new Map(
    data.outputOptions.map((option) => [option.name, option]),
  );

  return (
    <article
      title={data.functionName ?? data.label}
      data-node-id={id}
      data-run-status={data.runStatus}
      className={[
        "relative",
        "python-node-card",
        "w-[360px] rounded-md border bg-white shadow-sm dark:bg-zinc-900",
        selected
          ? "border-zinc-900 shadow-md dark:border-zinc-100"
          : "border-zinc-200 dark:border-zinc-700",
      ].join(" ")}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="border-2 border-white bg-zinc-500 dark:border-zinc-900 dark:bg-zinc-400"
        style={{ width: 14, height: 14 }}
      />
      <div className="cursor-grab border-b border-zinc-200 px-3 py-2 active:cursor-grabbing dark:border-zinc-800">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-zinc-950 dark:text-zinc-100">
              {data.label}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
              {data.functionName ?? "custom Python"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {data.onRunToNode && (
              <button
                type="button"
                aria-label={`Run upstream to ${data.label}`}
                title={runToNodeTitle}
                disabled={data.runToNodeDisabled}
                className="nodrag nopan flex h-7 w-7 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:disabled:border-zinc-800 dark:disabled:text-zinc-600"
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
              key={`${id}:${data.runStatus}`}
              className="node-run-status-indicator"
            >
              {isRunning
                ? (
                  <span
                    aria-label={status.label}
                    title={status.label}
                    className="node-run-spinner h-3.5 w-3.5 shrink-0 rounded-full border-2"
                  />
                )
                : (
                  <span
                    className={[
                      "h-2.5 w-2.5 shrink-0 rounded-full",
                      status.dot,
                    ].join(" ")}
                    title={status.label}
                    aria-label={status.label}
                  />
                )}
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-3 px-3 py-3">
        {description && (
          <p className="line-clamp-2 min-h-9 text-xs leading-[18px] text-zinc-600 dark:text-zinc-400">
            {description}
          </p>
        )}
        <PortList title="Inputs" ports={data.inputs} emptyLabel="none" />
        <PortList
          title="Outputs"
          ports={data.outputs.map((name) => ({
            name,
            type: data.outputPreviews[name],
            missing: outputOptionsByName.get(name)?.source === "missing",
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
        <div className="flex items-center gap-2 rounded border border-zinc-200 bg-white p-1 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
          {data.onAddChild && (
            <button
              type="button"
              aria-label={`Add child node after ${data.label}`}
              title="Add child node (A)"
              className="flex h-7 w-7 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              onClick={() => data.onAddChild?.(id)}
            >
              <Plus aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </NodeToolbar>
      <Handle
        type="source"
        position={Position.Bottom}
        className="border-2 border-white bg-zinc-500 dark:border-zinc-900 dark:bg-zinc-400"
        style={{ width: 14, height: 14 }}
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
  ports: Array<{ name: string; type?: string; missing?: boolean }>;
  emptyLabel: string;
  variant?: "input" | "output";
}) {
  const chipClassName = variant === "output"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
    : "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300";

  return (
    <section>
      <p className="text-[10px] font-medium uppercase leading-none text-zinc-500 dark:text-zinc-400">
        {title}
      </p>
      {ports.length === 0
        ? (
          <p className="mt-1.5 text-xs text-zinc-400 dark:text-zinc-500">
            {emptyLabel}
          </p>
        )
        : (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {ports.map((port) => (
              <span
                key={port.name}
                className={[
                  "max-w-full truncate rounded border px-2 py-1 font-mono text-[11px] leading-none",
                  port.missing
                    ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
                    : chipClassName,
                ].join(" ")}
                title={port.missing
                  ? `${port.name} · declared output not found in code`
                  : port.type
                  ? `${port.name} · ${port.type}`
                  : port.name}
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
