import type { ExecutionResponse } from "../../../../types.ts";

export type NodeInspectorBadge = "Source" | "Sink" | "Isolated";

export type NodeInspectorSelection = {
  id: string;
  code: string;
  outputs: string[];
  upstreamDependencies: string[];
  downstreamDependencies: string[];
  badges: NodeInspectorBadge[];
};

export type GraphInspectorModel = {
  nodeCount: number;
  edgeCount: number;
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
  | { status: "completed"; response: ExecutionResponse }
  | { status: "request_error"; message: string };

type InspectorPanelProps = {
  selectedNode: NodeInspectorSelection | null;
  graph: GraphInspectorModel;
  selectedNodeExecutionState: ExecutionDisplayState | null;
  onNodeSelect: (nodeId: string) => void;
  onRunNode: (nodeId: string) => void;
  onRunToNode: (nodeId: string) => void;
  onSelectionClear: () => void;
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

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="mt-2 max-h-48 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-5 text-zinc-900">
      {JSON.stringify(value, null, 2)}
    </pre>
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

  const response = executionState.response;
  const nodeResult = response.resultsByNode[selectedNode.id];

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
            : <JsonBlock value={outputs} />}
        </section>

        <TextOutputBlock title="Stdout" value={nodeResult?.stdout ?? ""} />
        <TextOutputBlock
          title="Stderr"
          value={nodeResult?.stderr ?? ""}
          variant="danger"
        />
      </div>
    </section>
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
  onNodeSelect,
}: {
  graph: GraphInspectorModel;
  onNodeSelect: (nodeId: string) => void;
}) {
  return (
    <div className="space-y-4">
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
    </div>
  );
}

function NodeInspector({
  selectedNode,
  executionState,
  onNodeSelect,
}: {
  selectedNode: NodeInspectorSelection;
  executionState: ExecutionDisplayState | null;
  onNodeSelect: (nodeId: string) => void;
}) {
  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-xs font-semibold uppercase text-zinc-500">
          Declared Outputs
        </h3>
        <CodeList
          items={selectedNode.outputs}
          emptyLabel="No declared outputs"
        />
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

export function InspectorPanel({
  selectedNode,
  graph,
  selectedNodeExecutionState,
  onNodeSelect,
  onRunNode,
  onRunToNode,
  onSelectionClear,
}: InspectorPanelProps) {
  const isSelectedNodeRunning = selectedNodeExecutionState?.status ===
    "running";

  return (
    <aside className="flex h-full w-[400px] shrink-0 flex-col border-l border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase text-zinc-500">
            Inspector
          </p>
          {selectedNode && (
            <button
              type="button"
              aria-label="Show graph inspector"
              className="flex h-7 w-7 items-center justify-center rounded border border-zinc-300 text-sm text-zinc-600 hover:bg-zinc-100"
              onClick={onSelectionClear}
            >
              x
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
              className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
              disabled={isSelectedNodeRunning}
              onClick={() => onRunToNode(selectedNode.id)}
            >
              {isSelectedNodeRunning ? "Running..." : "Run to node"}
            </button>
            <button
              type="button"
              className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-300"
              disabled={isSelectedNodeRunning}
              onClick={() => onRunNode(selectedNode.id)}
            >
              Run node
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {selectedNode
          ? (
            <NodeInspector
              selectedNode={selectedNode}
              executionState={selectedNodeExecutionState}
              onNodeSelect={onNodeSelect}
            />
          )
          : <GraphInspector graph={graph} onNodeSelect={onNodeSelect} />}
      </div>
    </aside>
  );
}
