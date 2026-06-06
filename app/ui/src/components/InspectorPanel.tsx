import type {
  DisplayPreview,
  ExecutionResponse,
  NodeRunResult,
  OutputEvent,
  TableCellPreview,
  TablePreview,
  ValuePreview,
} from "../../../../types.ts";
import { Check, Play, Route, X } from "lucide-react";
import type { ReactNode } from "react";
import type { InspectGraphValidationIssue } from "../api/inspectGraph.ts";

type ExecutionTraceStep = NonNullable<ExecutionResponse["trace"]>[number];

export type NodeInspectorBadge = "Source" | "Sink" | "Isolated";

export type NodeInspectorSelection = {
  id: string;
  code: string;
  editable: boolean;
  outputs: string[];
  inferredOutputs: string[];
  inputNames: string[];
  upstreamDependencies: string[];
  downstreamDependencies: string[];
  badges: NodeInspectorBadge[];
};

export type GraphInspectorModel = {
  nodeCount: number;
  edgeCount: number;
  globalsCode: string;
  sourceNodeIds: string[];
  sinkNodeIds: string[];
  isolatedNodeIds: string[];
  sinkOutputs: Array<{
    nodeId: string;
    outputs: string[];
  }>;
};

export type ExecutionDisplayState =
  | { status: "running"; runType: ExecutionResponse["runType"] }
  | {
    status: "completed_node";
    runType: ExecutionResponse["runType"];
    result: NodeRunResult;
  }
  | {
    status: "failed_node";
    runType: ExecutionResponse["runType"];
    result: NodeRunResult;
  }
  | { status: "completed"; response: ExecutionResponse }
  | { status: "request_error"; message: string };

export type GraphExecutionDisplayState = Extract<
  ExecutionDisplayState,
  | { status: "running" }
  | { status: "completed" }
  | { status: "request_error" }
>;

type InspectorPanelProps = {
  selectedNode: NodeInspectorSelection | null;
  graph: GraphInspectorModel;
  selectedNodeExecutionState: ExecutionDisplayState | null;
  graphExecutionState: GraphExecutionDisplayState | null;
  traceEnabled: boolean;
  readOnly: boolean;
  onNodeSelect: (nodeId: string) => void;
  onOutputsChange: (nodeId: string, outputs: string[]) => void;
  onTraceEnabledChange: (value: boolean) => void;
  onRunNode: (nodeId: string) => void;
  onRunToNode: (nodeId: string) => void;
  onRunGraph: () => void;
  onSelectionClear: () => void;
  validationIssues: InspectGraphValidationIssue[];
};

function CodeList(
  { items, emptyLabel }: { items: string[]; emptyLabel: string },
) {
  if (items.length === 0) {
    return <p className="text-sm text-zinc-500">{emptyLabel}</p>;
  }

  return (
    <ul className="mt-2 space-y-1">
      {items.map((item) => (
        <li key={item}>
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-900">
            {item}
          </code>
        </li>
      ))}
    </ul>
  );
}

function NodeIdButton({
  nodeId,
  onNodeSelect,
}: {
  nodeId: string;
  onNodeSelect: (nodeId: string) => void;
}) {
  return (
    <button
      type="button"
      className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-900 hover:bg-zinc-200"
      onClick={() => onNodeSelect(nodeId)}
    >
      {nodeId}
    </button>
  );
}

function NodeIdList({
  items,
  emptyLabel,
  onNodeSelect,
}: {
  items: string[];
  emptyLabel: string;
  onNodeSelect: (nodeId: string) => void;
}) {
  if (items.length === 0) {
    return <p className="mt-2 text-sm text-zinc-500">{emptyLabel}</p>;
  }

  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li key={item}>
          <NodeIdButton nodeId={item} onNodeSelect={onNodeSelect} />
        </li>
      ))}
    </ul>
  );
}

function DependencyList({
  title,
  items,
  emptyLabel,
  onNodeSelect,
}: {
  title: string;
  items: string[];
  emptyLabel: string;
  onNodeSelect: (nodeId: string) => void;
}) {
  return (
    <section className="border-t border-zinc-200 pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase text-zinc-500">
          {title}
        </h3>
        <span className="text-xs text-zinc-500">{items.length}</span>
      </div>
      {items.length === 0
        ? <p className="mt-2 text-sm text-zinc-500">{emptyLabel}</p>
        : (
          <ul className="mt-2 space-y-1">
            {items.map((item) => (
              <li key={item}>
                <NodeIdButton nodeId={item} onNodeSelect={onNodeSelect} />
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

function PreviewBlock(
  { previews }: { previews: Record<string, ValuePreview> },
) {
  const entries = Object.entries(previews);

  if (entries.length === 0) {
    return <p className="mt-2 text-sm text-zinc-500">No values.</p>;
  }

  return (
    <div className="mt-2 space-y-2">
      {entries.map(([name, preview]) => (
        <PreviewCard key={name} preview={preview} />
      ))}
    </div>
  );
}

function TablePreviewBlock({ table }: { table: TablePreview }) {
  return (
    <div className="mt-2 overflow-hidden rounded border border-zinc-200 bg-white">
      <div className="max-h-80 overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
          <thead className="sticky top-0 z-10 bg-zinc-100 text-zinc-600">
            <tr>
              {table.index && (
                <th className="border-b border-r border-zinc-200 px-2 py-1.5 font-medium">
                  index
                </th>
              )}
              {table.columns.map((column) => (
                <th
                  key={column.name}
                  className="border-b border-r border-zinc-200 px-2 py-1.5 font-medium last:border-r-0"
                >
                  <div className="max-w-44 truncate text-zinc-800">
                    {column.name}
                  </div>
                  {column.dtype && (
                    <div className="max-w-44 truncate font-mono text-[10px] font-normal text-zinc-500">
                      {column.dtype}
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-white even:bg-zinc-50">
                {table.index && (
                  <td className="border-b border-r border-zinc-100 px-2 py-1.5 font-mono text-zinc-500">
                    <CellValue value={table.index[rowIndex] ?? null} />
                  </td>
                )}
                {row.map((cell, columnIndex) => (
                  <td
                    key={columnIndex}
                    className="border-b border-r border-zinc-100 px-2 py-1.5 last:border-r-0"
                  >
                    <CellValue value={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.truncated && (
        <p className="border-t border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs text-zinc-500">
          Showing {table.rows.length} of {table.rowCount} rows and{" "}
          {table.columns.length} of {table.columnCount} columns.
        </p>
      )}
    </div>
  );
}

function CellValue({ value }: { value: TableCellPreview }) {
  if (value === null) {
    return <span className="font-mono text-zinc-400">null</span>;
  }
  if (typeof value === "boolean") {
    return <span className="font-mono text-sky-700">{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="font-mono text-zinc-800">{value}</span>;
  }
  if (typeof value === "string") {
    return <span className="block max-w-56 truncate">{value}</span>;
  }
  if (value.kind === "nan") {
    return <span className="font-mono text-zinc-400">NaN</span>;
  }
  if (value.kind === "datetime") {
    return (
      <span className="block max-w-56 truncate font-mono text-zinc-700">
        {value.value}
      </span>
    );
  }
  return <span className="block max-w-56 truncate">{value.value}</span>;
}

function DisplayBlock({ displays }: { displays: DisplayPreview[] }) {
  if (displays.length === 0) return null;

  return (
    <section>
      <h4 className="text-xs font-semibold uppercase text-zinc-500">
        Displays
      </h4>
      <div className="mt-2 space-y-2">
        {displays.map((display, index) => (
          <PreviewCard
            key={index}
            preview={{ ...display.value, name: `display ${index + 1}` }}
          />
        ))}
      </div>
    </section>
  );
}

function InlineOutputBlock({
  events,
  stdout,
  displays,
}: {
  events?: OutputEvent[];
  stdout: string;
  displays: DisplayPreview[];
}) {
  if (events && events.length > 0) {
    let displayIndex = 0;

    return (
      <section>
        <h4 className="text-xs font-semibold uppercase text-zinc-500">
          Output
        </h4>
        <div className="mt-2 space-y-2">
          {events.map((event, index) => {
            if (event.kind === "stdout") {
              return (
                <pre
                  key={index}
                  className="max-h-48 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-5 text-zinc-900"
                >
                  {event.text}
                </pre>
              );
            }

            displayIndex += 1;
            return (
              <PreviewCard
                key={index}
                preview={{ ...event.value, name: `display ${displayIndex}` }}
              />
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <>
      <DisplayBlock displays={displays} />
      <TextOutputBlock title="Stdout" value={stdout} />
    </>
  );
}

function PreviewCard({ preview }: { preview: ValuePreview }) {
  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-semibold text-zinc-900">
          {preview.name}
        </span>
        <span className="font-mono text-xs text-zinc-500">
          {preview.type}
        </span>
      </div>
      {preview.table
        ? <TablePreviewBlock table={preview.table} />
        : (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-zinc-800">
            {preview.repr}
          </pre>
        )}
      {preview.warning && (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          {preview.warning}
        </p>
      )}
    </div>
  );
}

function WarningList({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;

  return (
    <section>
      <h4 className="text-xs font-semibold uppercase text-amber-700">
        Warnings
      </h4>
      <ul className="mt-2 space-y-1 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        {warnings.map((warning) => <li key={warning}>{warning}</li>)}
      </ul>
    </section>
  );
}

function TextOutputBlock({
  title,
  value,
  variant = "default",
}: {
  title: string;
  value: string;
  variant?: "default" | "danger";
}) {
  if (value.trim().length === 0) {
    return null;
  }

  const blockClassName = variant === "danger"
    ? "mt-2 max-h-48 overflow-auto rounded border border-red-200 bg-red-50 p-3 font-mono text-xs leading-5 text-red-950"
    : "mt-2 max-h-48 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-5 text-zinc-900";

  return (
    <section>
      <h4 className="text-xs font-semibold uppercase text-zinc-500">
        {title}
      </h4>
      <pre className={blockClassName}>{value}</pre>
    </section>
  );
}

function RunResult({
  selectedNode,
  executionState,
}: {
  selectedNode: NodeInspectorSelection;
  executionState: ExecutionDisplayState | null;
}) {
  if (!executionState) {
    return null;
  }

  if (executionState.status === "running") {
    return (
      <section className="border-t border-zinc-200 pt-4">
        <h3 className="text-xs font-semibold uppercase text-zinc-500">
          Run Result
        </h3>
        <p className="mt-2 text-sm text-zinc-600">Running...</p>
      </section>
    );
  }

  if (executionState.status === "request_error") {
    return (
      <section className="border-t border-zinc-200 pt-4">
        <h3 className="text-xs font-semibold uppercase text-zinc-500">
          Run Result
        </h3>
        <div className="mt-2 rounded border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-medium text-red-800">
            Could not start run
          </p>
          <p className="mt-1 text-sm text-red-700">
            The request failed before Python execution completed.
          </p>
          <p className="mt-2 font-mono text-xs text-red-950">
            {executionState.message}
          </p>
        </div>
      </section>
    );
  }

  if (
    executionState.status === "completed_node" ||
    executionState.status === "failed_node"
  ) {
    const nodeResult = executionState.result;
    const outputEntries = Object.entries(nodeResult.outputs);

    return (
      <section className="border-t border-zinc-200 pt-4">
        <h3 className="text-xs font-semibold uppercase text-zinc-500">
          Run Result
        </h3>
        <p
          className={[
            "mt-2 text-sm font-medium",
            nodeResult.ok ? "text-zinc-700" : "text-red-800",
          ].join(" ")}
        >
          {nodeResult.ok ? "Node completed" : "Node failed"}
        </p>

        {!nodeResult.ok && (
          <div className="mt-2 rounded border border-red-200 bg-red-50 p-3">
            <p className="text-sm font-medium text-red-800">
              Python execution failed.
            </p>
            {nodeResult.error && (
              <p className="mt-1 text-sm text-red-700">{nodeResult.error}</p>
            )}
          </div>
        )}

        <div className="mt-4 space-y-4">
          <section>
            <h4 className="text-xs font-semibold uppercase text-zinc-500">
              Outputs
            </h4>
            {outputEntries.length === 0
              ? <p className="mt-2 text-sm text-zinc-500">No outputs.</p>
              : <PreviewBlock previews={nodeResult.outputs} />}
          </section>

          <InlineOutputBlock
            events={nodeResult.outputEvents}
            stdout={nodeResult.stdout}
            displays={nodeResult.displays}
          />
          <WarningList warnings={nodeResult.warnings} />
          <TextOutputBlock
            title="Stderr"
            value={nodeResult.stderr}
            variant="danger"
          />
        </div>
      </section>
    );
  }

  const response = executionState.response;
  const nodeResult = response.resultsByNode[selectedNode.id];
  const traceStep =
    response.trace?.find((step) => step.nodeId === selectedNode.id) ?? null;

  if (!nodeResult && !response.ok) {
    const failedNodeId = response.error?.nodeId;
    const subject = response.runType === "run_to_node" &&
        response.targetNodeId === selectedNode.id
      ? "Target"
      : "This node";

    return (
      <section className="border-t border-zinc-200 pt-4">
        <h3 className="text-xs font-semibold uppercase text-zinc-500">
          Run Result
        </h3>
        <p className="mt-2 text-sm font-medium text-red-800">Run failed</p>
        <div className="mt-2 rounded border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-medium text-red-800">
            {failedNodeId
              ? (
                <>
                  {subject} did not run because{" "}
                  <code className="font-mono">{failedNodeId}</code> failed.
                </>
              )
              : `${subject} did not run because an upstream node failed.`}
          </p>
        </div>
        <NodeTraceResult step={traceStep} />
      </section>
    );
  }

  const outputs = nodeResult?.outputs ?? {};
  const outputEntries = Object.entries(outputs);

  return (
    <section className="border-t border-zinc-200 pt-4">
      <h3 className="text-xs font-semibold uppercase text-zinc-500">
        Run Result
      </h3>
      <p
        className={[
          "mt-2 text-sm font-medium",
          response.ok ? "text-zinc-700" : "text-red-800",
        ].join(" ")}
      >
        {response.ok ? "Run succeeded" : "Run failed"}
      </p>

      {!response.ok && (
        <div className="mt-2 rounded border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-medium text-red-800">
            {response.error?.message ?? "Python execution failed."}
          </p>
          {nodeResult?.error && (
            <p className="mt-1 text-sm text-red-700">{nodeResult.error}</p>
          )}
        </div>
      )}

      <div className="mt-4 space-y-4">
        <section>
          <h4 className="text-xs font-semibold uppercase text-zinc-500">
            Outputs
          </h4>
          {outputEntries.length === 0
            ? <p className="mt-2 text-sm text-zinc-500">No outputs.</p>
            : <PreviewBlock previews={outputs} />}
        </section>

        <InlineOutputBlock
          events={nodeResult?.outputEvents}
          stdout={nodeResult?.stdout ?? ""}
          displays={nodeResult?.displays ?? []}
        />
        <WarningList warnings={nodeResult?.warnings ?? []} />
        <TextOutputBlock
          title="Stderr"
          value={nodeResult?.stderr ?? ""}
          variant="danger"
        />
      </div>
      <NodeTraceResult step={traceStep} />
    </section>
  );
}

function NodeTraceResult({ step }: { step: ExecutionTraceStep | null }) {
  if (!step) {
    return null;
  }

  return (
    <TraceDetails title="Trace" summary={`Step ${step.index}: ${step.nodeId}`}>
      <TraceStep step={step} />
    </TraceDetails>
  );
}

// Keep the graph and node inspector modes together while the surface is small.
// Split these into separate files once either mode starts carrying more logic.
function MetricTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 p-3">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-zinc-950">{value}</dd>
    </div>
  );
}

function GraphInspector({
  graph,
  graphExecutionState,
  validationIssues,
  onNodeSelect,
}: {
  graph: GraphInspectorModel;
  graphExecutionState: GraphExecutionDisplayState | null;
  validationIssues: InspectGraphValidationIssue[];
  onNodeSelect: (nodeId: string) => void;
}) {
  return (
    <div className="space-y-4">
      <ValidationIssues issues={validationIssues} />

      {graph.globalsCode.trim().length > 0 && (
        <section className="border-t border-zinc-200 pt-4">
          <h3 className="text-xs font-semibold uppercase text-zinc-500">
            Document Globals
          </h3>
          <pre className="mt-2 max-h-48 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-5 text-zinc-900">
            {graph.globalsCode}
          </pre>
        </section>
      )}

      <dl className="grid grid-cols-2 gap-3">
        <MetricTile label="Nodes" value={graph.nodeCount} />
        <MetricTile label="Edges" value={graph.edgeCount} />
        <MetricTile label="Sources" value={graph.sourceNodeIds.length} />
        <MetricTile label="Sinks" value={graph.sinkNodeIds.length} />
      </dl>

      <section>
        <h3 className="text-xs font-semibold uppercase text-zinc-500">
          Sources
        </h3>
        <NodeIdList
          items={graph.sourceNodeIds}
          emptyLabel="No source nodes"
          onNodeSelect={onNodeSelect}
        />
      </section>

      <section className="border-t border-zinc-200 pt-4">
        <h3 className="text-xs font-semibold uppercase text-zinc-500">
          Sinks
        </h3>
        <NodeIdList
          items={graph.sinkNodeIds}
          emptyLabel="No sink nodes"
          onNodeSelect={onNodeSelect}
        />
      </section>

      <section className="border-t border-zinc-200 pt-4">
        <h3 className="text-xs font-semibold uppercase text-zinc-500">
          Sink Declared Outputs
        </h3>
        {graph.sinkOutputs.length === 0
          ? <p className="mt-2 text-sm text-zinc-500">No sink nodes</p>
          : (
            <div className="mt-2 space-y-3">
              {graph.sinkOutputs.map((sinkOutput) => (
                <div key={sinkOutput.nodeId}>
                  <NodeIdButton
                    nodeId={sinkOutput.nodeId}
                    onNodeSelect={onNodeSelect}
                  />
                  <CodeList
                    items={sinkOutput.outputs}
                    emptyLabel="No declared outputs"
                  />
                </div>
              ))}
            </div>
          )}
      </section>

      {graph.isolatedNodeIds.length > 0 && (
        <section className="border-t border-zinc-200 pt-4">
          <h3 className="text-xs font-semibold uppercase text-zinc-500">
            Isolated Nodes
          </h3>
          <NodeIdList
            items={graph.isolatedNodeIds}
            emptyLabel="No isolated nodes"
            onNodeSelect={onNodeSelect}
          />
        </section>
      )}

      <GraphRunResult
        executionState={graphExecutionState}
        onNodeSelect={onNodeSelect}
      />
    </div>
  );
}

function GraphRunResult({
  executionState,
  onNodeSelect,
}: {
  executionState: GraphExecutionDisplayState | null;
  onNodeSelect: (nodeId: string) => void;
}) {
  if (!executionState) {
    return null;
  }

  if (executionState.status === "running") {
    return (
      <section className="border-t border-zinc-200 pt-4">
        <h3 className="text-xs font-semibold uppercase text-zinc-500">
          Run Result
        </h3>
        <p className="mt-2 text-sm text-zinc-600">Running...</p>
      </section>
    );
  }

  if (executionState.status === "request_error") {
    return (
      <section className="border-t border-zinc-200 pt-4">
        <h3 className="text-xs font-semibold uppercase text-zinc-500">
          Run Result
        </h3>
        <div className="mt-2 rounded border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-medium text-red-800">
            Could not start run
          </p>
          <p className="mt-1 text-sm text-red-700">
            The request failed before Python execution completed.
          </p>
          <p className="mt-2 font-mono text-xs text-red-950">
            {executionState.message}
          </p>
        </div>
      </section>
    );
  }

  const response = executionState.response;
  const finalNodeIds = response.finalNodeIds.filter((nodeId) =>
    nodeId in response.finalOutputsByNode
  );

  return (
    <section className="border-t border-zinc-200 pt-4">
      <h3 className="text-xs font-semibold uppercase text-zinc-500">
        Run Result
      </h3>
      <p
        className={[
          "mt-2 text-sm font-medium",
          response.ok ? "text-zinc-700" : "text-red-800",
        ].join(" ")}
      >
        {response.ok ? "Run succeeded" : "Run failed"}
      </p>

      {response.ok
        ? (
          <div className="mt-4 space-y-4">
            <section>
              <h4 className="text-xs font-semibold uppercase text-zinc-500">
                Executed Nodes
              </h4>
              <p className="mt-2 text-sm text-zinc-700">
                {response.executedNodeIds.length}
              </p>
            </section>

            <section>
              <h4 className="text-xs font-semibold uppercase text-zinc-500">
                Final Outputs
              </h4>
              {finalNodeIds.length === 0
                ? (
                  <p className="mt-2 text-sm text-zinc-500">
                    No final outputs.
                  </p>
                )
                : (
                  <div className="mt-2 space-y-3">
                    {finalNodeIds.map((nodeId) => (
                      <div key={nodeId}>
                        <NodeIdButton
                          nodeId={nodeId}
                          onNodeSelect={onNodeSelect}
                        />
                        <PreviewBlock
                          previews={response.finalOutputsByNode[nodeId]}
                        />
                      </div>
                    ))}
                  </div>
                )}
            </section>

            <GraphTraceResult response={response} />
          </div>
        )
        : (
          <>
            <div className="mt-2 rounded border border-red-200 bg-red-50 p-3">
              <p className="text-sm font-medium text-red-800">
                {response.error?.message ?? "Graph execution failed."}
              </p>
              {response.error?.nodeId && (
                <div className="mt-2">
                  <p className="text-xs font-semibold uppercase text-red-700">
                    Failed At
                  </p>
                  <div className="mt-1">
                    <NodeIdButton
                      nodeId={response.error.nodeId}
                      onNodeSelect={onNodeSelect}
                    />
                  </div>
                </div>
              )}
            </div>
            <GraphTraceResult response={response} />
          </>
        )}
    </section>
  );
}

function GraphTraceResult({ response }: { response: ExecutionResponse }) {
  if (!response.trace) {
    return null;
  }

  const stepCount = response.trace.length;

  return (
    <TraceDetails
      title="Trace"
      summary={`${stepCount} ${stepCount === 1 ? "step" : "steps"}`}
    >
      <div className="space-y-3">
        {response.trace.map((step) => (
          <TraceStep
            key={step.index}
            step={step}
          />
        ))}
      </div>
    </TraceDetails>
  );
}

function TraceDetails({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-zinc-200 pt-4">
      <h4 className="text-xs font-semibold uppercase text-zinc-500">
        {title}
      </h4>
      <details className="mt-2 rounded border border-zinc-200 bg-white">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-zinc-700">
          {summary}
        </summary>
        <div className="border-t border-zinc-200 p-3">{children}</div>
      </details>
    </section>
  );
}

function TraceStep({ step }: { step: ExecutionTraceStep }) {
  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-zinc-500">Step {step.index}</p>
          <p className="mt-1 font-mono text-sm font-semibold text-zinc-900">
            {step.nodeId}
          </p>
        </div>
        <span
          className={[
            "rounded px-2 py-0.5 text-xs font-medium",
            step.ok
              ? "bg-emerald-50 text-emerald-700"
              : "bg-red-50 text-red-700",
          ].join(" ")}
        >
          {step.ok ? "ok" : "failed"}
        </span>
      </div>

      <div className="mt-4 space-y-4">
        <section>
          <h5 className="text-xs font-semibold uppercase text-zinc-500">
            Depends On
          </h5>
          <CodeList items={step.dependsOn} emptyLabel="No dependencies" />
        </section>

        <section>
          <h5 className="text-xs font-semibold uppercase text-zinc-500">
            Inputs
          </h5>
          <PreviewBlock previews={step.inputs} />
        </section>

        <section>
          <h5 className="text-xs font-semibold uppercase text-zinc-500">
            Outputs
          </h5>
          <PreviewBlock previews={step.outputs} />
        </section>

        <InlineOutputBlock
          events={step.outputEvents}
          stdout={step.stdout}
          displays={step.displays}
        />
        <WarningList warnings={step.warnings} />
        <TextOutputBlock title="Stderr" value={step.stderr} variant="danger" />
        {step.error && (
          <section>
            <h5 className="text-xs font-semibold uppercase text-red-700">
              Error
            </h5>
            <p className="mt-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {step.error}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

function NodeInspector({
  selectedNode,
  executionState,
  validationIssues,
  readOnly,
  onOutputsChange,
  onNodeSelect,
}: {
  selectedNode: NodeInspectorSelection;
  executionState: ExecutionDisplayState | null;
  validationIssues: InspectGraphValidationIssue[];
  readOnly: boolean;
  onOutputsChange: (nodeId: string, outputs: string[]) => void;
  onNodeSelect: (nodeId: string) => void;
}) {
  const outputsReadOnly = readOnly || !selectedNode.editable;
  const outputOptions = getOutputOptions(
    selectedNode.inputNames,
    selectedNode.inferredOutputs,
    selectedNode.outputs,
  );

  const handleOutputToggle = (name: string) => {
    if (readOnly || !selectedNode.editable) return;
    const selectedOutputs = new Set(selectedNode.outputs);
    if (selectedOutputs.has(name)) {
      selectedOutputs.delete(name);
    } else {
      selectedOutputs.add(name);
    }
    onOutputsChange(
      selectedNode.id,
      outputOptions
        .map((option) => option.name)
        .filter((optionName) => selectedOutputs.has(optionName)),
    );
  };

  return (
    <div className="space-y-4">
      <ValidationIssues issues={validationIssues} />

      <section>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase text-zinc-500">
            Declared Outputs
          </h3>
          <span className="text-xs text-zinc-500">
            {selectedNode.outputs.length} selected
          </span>
        </div>
        {outputOptions.length === 0
          ? (
            <p className="mt-2 rounded border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-500">
              No assignable outputs found.
            </p>
          )
          : (
            <ul className="mt-2 space-y-1.5">
              {outputOptions.map((option) => {
                const checked = selectedNode.outputs.includes(option.name);
                return (
                  <li key={option.name}>
                    <label
                      className={`flex items-center gap-2 rounded border px-3 py-2 text-sm ${
                        checked
                          ? "border-zinc-300 bg-white text-zinc-900"
                          : "border-zinc-200 bg-zinc-50 text-zinc-500"
                      } ${
                        outputsReadOnly
                          ? "cursor-not-allowed opacity-70"
                          : "cursor-pointer hover:bg-zinc-100"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        disabled={outputsReadOnly}
                        onChange={() => handleOutputToggle(option.name)}
                      />
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          checked
                            ? "border-zinc-900 bg-zinc-900 text-white"
                            : "border-zinc-300 bg-white"
                        }`}
                        aria-hidden="true"
                      >
                        {checked && (
                          <Check className="h-3 w-3" strokeWidth={3} />
                        )}
                      </span>
                      <code className="min-w-0 flex-1 truncate font-mono text-xs">
                        {option.name}
                      </code>
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500">
                        {option.source}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
      </section>

      <DependencyList
        title="Upstream"
        items={selectedNode.upstreamDependencies}
        emptyLabel="No upstream dependencies"
        onNodeSelect={onNodeSelect}
      />

      <DependencyList
        title="Downstream"
        items={selectedNode.downstreamDependencies}
        emptyLabel="No downstream dependencies"
        onNodeSelect={onNodeSelect}
      />

      <section className="border-t border-zinc-200 pt-4">
        <h3 className="text-xs font-semibold uppercase text-zinc-500">
          Code
        </h3>
        <pre className="mt-2 max-h-48 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-5 text-zinc-900">{selectedNode.code}</pre>
      </section>

      <RunResult selectedNode={selectedNode} executionState={executionState} />
    </div>
  );
}

function getOutputOptions(
  inputNames: string[],
  inferredOutputs: string[],
  declaredOutputs: string[],
): Array<{ name: string; source: "input" | "assigned" | "manual" }> {
  const options: Array<
    { name: string; source: "input" | "assigned" | "manual" }
  > = [];
  const seen = new Set<string>();

  for (const name of inputNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    options.push({ name, source: "input" });
  }

  for (const name of inferredOutputs) {
    if (seen.has(name)) continue;
    seen.add(name);
    options.push({ name, source: "assigned" });
  }

  for (const name of declaredOutputs) {
    if (seen.has(name)) continue;
    seen.add(name);
    options.push({ name, source: "manual" });
  }

  return options;
}

function TraceToggle({
  traceEnabled,
  onTraceEnabledChange,
}: {
  traceEnabled: boolean;
  onTraceEnabledChange: (value: boolean) => void;
}) {
  return (
    <section className="border-t border-zinc-200 pt-4">
      <label className="flex items-center gap-2 text-sm text-zinc-700">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-zinc-300"
          checked={traceEnabled}
          onChange={(event) =>
            onTraceEnabledChange(event.currentTarget.checked)}
        />
        Trace
      </label>
    </section>
  );
}

function ValidationIssues(
  { issues }: { issues: InspectGraphValidationIssue[] },
) {
  if (issues.length === 0) {
    return null;
  }

  return (
    <section className="rounded border border-red-200 bg-red-50 p-3">
      <h3 className="text-xs font-semibold uppercase text-red-700">
        Validation
      </h3>
      <p className="mt-1 text-sm text-red-700">
        Fix these issues before running the graph.
      </p>
      <ul className="mt-3 space-y-2">
        {issues.map((issue, index) => (
          <li
            key={`${issue.kind}-${issue.path ?? "graph"}-${index}`}
            className="text-sm text-red-900"
          >
            <span className="font-medium">{issue.kind}</span>
            <span className="block">{issue.message}</span>
            {issue.path && (
              <span className="mt-0.5 block font-mono text-xs text-red-700">
                {issue.path}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function InspectorPanel({
  selectedNode,
  graph,
  selectedNodeExecutionState,
  graphExecutionState,
  traceEnabled,
  readOnly,
  onNodeSelect,
  onOutputsChange,
  onTraceEnabledChange,
  onRunNode,
  onRunToNode,
  onRunGraph,
  onSelectionClear,
  validationIssues,
}: InspectorPanelProps) {
  const isSelectedNodeRunning = selectedNodeExecutionState?.status ===
    "running";
  const isGraphRunning = graphExecutionState?.status === "running";
  const isAnyRunBlockingNodeActions = isSelectedNodeRunning || isGraphRunning;
  const areNodeActionsDisabled = isSelectedNodeRunning || isGraphRunning;
  const isGraphActionDisabled = isGraphRunning;

  return (
    <aside className="flex h-full w-[560px] shrink-0 flex-col border-l border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase text-zinc-500">
            Inspector
          </p>
          {selectedNode && (
            <button
              type="button"
              aria-label="Show graph inspector"
              className="flex h-7 w-7 items-center justify-center rounded border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
              onClick={onSelectionClear}
            >
              <X aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
            </button>
          )}
          {!selectedNode && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
              disabled={isGraphActionDisabled}
              onClick={onRunGraph}
            >
              <Play aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
              {isGraphRunning ? "Running..." : "Run graph"}
            </button>
          )}
        </div>
        {selectedNode && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-zinc-950">
              {selectedNode.id}
            </h2>
            <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
              Python
            </span>
            {selectedNode.badges.map((badge) => (
              <span
                key={badge}
                className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600"
              >
                {badge}
              </span>
            ))}
          </div>
        )}
        {selectedNode && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
              disabled={areNodeActionsDisabled}
              onClick={() => onRunToNode(selectedNode.id)}
            >
              <Route
                aria-hidden="true"
                className="h-4 w-4"
                strokeWidth={2.25}
              />
              {isAnyRunBlockingNodeActions ? "Running..." : "Run to node"}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-300"
              disabled={areNodeActionsDisabled}
              onClick={() => onRunNode(selectedNode.id)}
            >
              <Play aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
              Run with cache
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="space-y-4">
          {selectedNode
            ? (
              <NodeInspector
                selectedNode={selectedNode}
                executionState={selectedNodeExecutionState}
                validationIssues={validationIssues}
                readOnly={readOnly}
                onOutputsChange={onOutputsChange}
                onNodeSelect={onNodeSelect}
              />
            )
            : (
              <GraphInspector
                graph={graph}
                graphExecutionState={graphExecutionState}
                validationIssues={validationIssues}
                onNodeSelect={onNodeSelect}
              />
            )}
          <TraceToggle
            traceEnabled={traceEnabled}
            onTraceEnabledChange={onTraceEnabledChange}
          />
        </div>
      </div>
    </aside>
  );
}
