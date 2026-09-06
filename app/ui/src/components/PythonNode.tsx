import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Play, X } from "lucide-react";
import type { MouseEvent } from "react";
import type {
  NodeRunVisualStatus,
  PythonFlowNode,
} from "../graph/toReactFlow.ts";
import { formatPythonType } from "../graph/pythonTypeLabels.ts";

const statusStyles: Record<
  NodeRunVisualStatus,
  { label: string }
> = {
  idle: {
    label: "Not run",
  },
  stale: {
    label: "Code, outputs, or inputs changed since the last run",
  },
  queued: {
    label: "Queued to run",
  },
  running: {
    label: "Running",
  },
  blocked: {
    label: "Did not run because an upstream step failed",
  },
  blocked_globals: {
    label: "Did not run because Document Globals failed",
  },
  completed: {
    label: "Ran successfully",
  },
  failed: {
    label: "Run failed",
  },
};

export function PythonNode({ data, id, selected }: NodeProps<PythonFlowNode>) {
  const status = statusStyles[data.runStatus];
  const isRunning = data.runStatus === "running";
  const runToNodeTitle = data.runToNodeDisabled
    ? "Run unavailable"
    : "Run this step and required upstream steps fresh";
  const description = data.description?.trim();
  const hasInboundVariables = data.inputs.length > 0;
  const outputOptionsByName = new Map(
    data.outputOptions.map((option) => [option.name, option]),
  );
  const inputTypesByName = new Map(
    data.inputs.map((input) => [input.name, input.type]),
  );

  return (
    <article
      title={`${data.functionName ?? data.label} · ${status.label}`}
      data-node-id={id}
      data-run-status={data.runStatus}
      data-selected={selected || undefined}
      className={[
        "relative",
        "python-node-card",
        "w-[360px] rounded-md bg-white shadow-sm dark:bg-zinc-900",
      ].join(" ")}
    >
      {isRunning && (
        <svg className="node-running-border" aria-hidden="true">
          <rect x="1" y="1" rx="5" pathLength="100" />
        </svg>
      )}
      <Handle
        id="node-input"
        type="target"
        position={Position.Left}
        className="border-2 border-white bg-zinc-500 dark:border-zinc-900 dark:bg-zinc-400"
        style={{
          width: 14,
          height: 14,
          top: 25,
          ...(hasInboundVariables ? { backgroundColor: "#d4d4d8" } : {}),
        }}
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
                aria-label={`Run through ${data.label}`}
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
            <span className="sr-only">{status.label}</span>
          </div>
        </div>
      </div>

      <div className="space-y-3 pt-3">
        {description && (
          <p className="line-clamp-2 min-h-9 px-3 text-xs leading-[18px] text-zinc-600 dark:text-zinc-400">
            {description}
          </p>
        )}
        <VariableList
          variables={data.outputOptions.map((option) => ({
            name: option.name,
            type: data.outputPreviews[option.name] ??
              inputTypesByName.get(option.name),
            exported: data.outputs.includes(option.name),
            missing: outputOptionsByName.get(option.name)?.source === "missing",
          }))}
          onSelect={(name) => data.onVariableSelect?.(id, name)}
          onRemove={data.onOutputsChange && !data.outputsReadOnly
            ? (name) =>
              data.onOutputsChange?.(
                id,
                data.outputs.filter((output) => output !== name),
              )
            : undefined}
        />
      </div>
    </article>
  );
}

function VariableList({
  variables,
  onSelect,
  onRemove,
}: {
  variables: Array<{
    name: string;
    type?: string;
    exported?: boolean;
    missing?: boolean;
  }>;
  onSelect?: (name: string) => void;
  onRemove?: (name: string) => void;
}) {
  return (
    <section>
      <p className="px-3 text-[10px] font-medium uppercase leading-none text-zinc-500 dark:text-zinc-400">
        Variables
      </p>
      {variables.length === 0
        ? (
          <p className="mt-1.5 px-3 text-xs text-zinc-400 dark:text-zinc-500">
            none
          </p>
        )
        : (
          <div className="mt-1.5 border-y border-zinc-200 dark:border-zinc-700">
            {variables.map((variable) => (
              <div
                key={variable.name}
                role={onSelect ? "button" : undefined}
                tabIndex={onSelect ? 0 : undefined}
                className={[
                  "relative flex min-h-9 items-center justify-between gap-3 border-b px-3 py-2 pr-5 font-mono text-[11px] last:border-b-0",
                  variable.missing
                    ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
                    : variable.exported
                    ? "border-zinc-300 bg-zinc-100 text-zinc-950 dark:border-zinc-600 dark:bg-zinc-700/80 dark:text-zinc-50"
                    : "border-zinc-200 bg-zinc-50 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-200",
                ].join(" ")}
                title={variable.missing
                  ? `${variable.name} · routed output not found in code`
                  : variable.type
                  ? `${variable.name} · ${variable.type}`
                  : variable.name}
                onClick={(event) => {
                  if (
                    !onSelect ||
                    (event.target as HTMLElement).closest(
                      "button, .variable-output-handle",
                    )
                  ) {
                    return;
                  }
                  event.stopPropagation();
                  onSelect(variable.name);
                }}
                onKeyDown={(event) => {
                  if (
                    !onSelect || (event.key !== "Enter" && event.key !== " ")
                  ) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(variable.name);
                }}
              >
                <span className="min-w-0 truncate">{variable.name}</span>
                {variable.type && (
                  <span className="shrink-0 text-zinc-400 dark:text-zinc-500">
                    {formatPythonType(variable.type)}
                  </span>
                )}
                {variable.missing && onRemove && (
                  <button
                    type="button"
                    className="nodrag nopan flex h-5 w-5 shrink-0 items-center justify-center rounded text-red-500 hover:bg-red-100 hover:text-red-700 dark:hover:bg-red-900"
                    aria-label={`Remove missing output ${variable.name} and its routes`}
                    title="Remove this missing output and its routes"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemove(variable.name);
                    }}
                  >
                    <X aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                )}
                <Handle
                  id={variable.name}
                  type="source"
                  position={Position.Right}
                  className={[
                    "variable-output-handle border-2 border-white dark:border-zinc-900",
                    variable.missing
                      ? "variable-output-handle--missing"
                      : variable.exported
                      ? "variable-output-handle--exported"
                      : "variable-output-handle--available",
                  ].join(" ")}
                  style={{
                    width: 12,
                    height: 12,
                    right: 0,
                  }}
                />
              </div>
            ))}
          </div>
        )}
    </section>
  );
}
