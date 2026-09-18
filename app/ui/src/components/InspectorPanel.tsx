import { RunMenu } from "./RunMenu.tsx";
import type {
  ExecutionResponse,
  ImagePreview,
  NodeRunResult,
  ResultStoreIdentity,
  TableCellPreview,
  TablePreview,
  ValuePreview,
} from "../../../../types.ts";
import { python } from "@codemirror/lang-python";
import {
  Decoration,
  EditorView,
  gutterLineClass,
  GutterMarker,
  keymap,
} from "@codemirror/view";
import { RangeSet, StateField } from "@codemirror/state";
import CodeMirror from "@uiw/react-codemirror";
import {
  AlertTriangle,
  Maximize2,
  Play,
  Presentation,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { NodeNameChangeResult, ThemeMode } from "../App.tsx";
import type { PythonEditorErrorTarget } from "../documentSaveError.ts";
import { formatPythonType } from "../graph/pythonTypeLabels.ts";
import type { NodeRunVisualStatus } from "../graph/toReactFlow.ts";
import { JsonPreview, JsonPreviewThemeScope } from "./JsonPreview.tsx";
import {
  readPreference,
  savePreference,
  WorkspaceSplit,
} from "./WorkspaceSplit.tsx";
import { ResultTable } from "./ResultTable.tsx";
import { resolveGraphOutputSelection } from "./graphOutputSelection.ts";

type ExecutionTraceStep = NonNullable<ExecutionResponse["trace"]>[number];

export type NodeInspectorBadge = "Source" | "Sink" | "Isolated";

export type NodeInspectorSelection = {
  lastSuccessfulResult?: NodeRunResult;
  id: string;
  displayName: string;
  description: string;
  functionName: string | null;
  code: string;
  editable: boolean;
  routedOutputs: string[];
  variables: Array<{
    name: string;
    source: "input" | "assigned" | "missing";
  }>;
  variablePreviews: Record<string, ValuePreview>;
  inputSources?: Record<string, string>;
  upstreamDependencies: string[];
  downstreamDependencies: string[];
  nodeLabelsById: Record<string, string>;
  badges: NodeInspectorBadge[];
};

type NodeInspectorMode = "code" | "results" | "details";
type GraphInspectorMode = "overview" | "results";

export type GraphInspectorModel = {
  nodeCount: number;
  edgeCount: number;
  globalsCode: string;
  sourceNodeIds: string[];
  sinkNodeIds: string[];
  isolatedNodeIds: string[];
  nodeLabelsById: Record<string, string>;
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
  | {
    status: "completed";
    response: ExecutionResponse;
    freshness: ResultFreshness;
    latestFailure?: ExecutionResponse;
  }
  | { status: "request_error"; message: string };

export type GraphExecutionDisplayState =
  | { status: "running" }
  | {
    status: "completed";
    response: ExecutionResponse;
    freshness: ResultFreshness;
    latestFailure?: ExecutionResponse;
  }
  | { status: "request_error"; message: string };

export type ResultFreshness =
  | "fresh"
  | "failed_run"
  | "document_changed"
  | "replaced";

export type InspectorNavigationRequest =
  | {
    target: "document_globals" | "run_result";
    requestId: number;
  }
  | {
    target: "node_code" | "node_results";
    nodeId: string;
    variableName?: string;
    requestId: number;
  };

type InspectorPanelProps = {
  focused: boolean;
  onToggleFocus: () => void;
  themeMode: ThemeMode;
  selectedNode: NodeInspectorSelection | null;
  graph: GraphInspectorModel;
  selectedNodeExecutionState: ExecutionDisplayState | null;
  selectedNodeRunStatus: NodeRunVisualStatus;
  graphExecutionState: GraphExecutionDisplayState | null;
  isRunActive: boolean;
  readOnly: boolean;
  onNodeSelect: (nodeId: string) => void;
  onCodeChange: (nodeId: string, code: string) => void;
  onNodeNameChange: (
    nodeId: string,
    displayName: string,
  ) => NodeNameChangeResult;
  onNodeMetadataChange: (
    nodeId: string,
    metadata: { description?: string },
  ) => void;
  onGlobalsCodeChange: (code: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  onRunToNode: (nodeId: string, options?: { trace?: boolean }) => void;
  onSelectionClear: () => void;
  actionsBlocked?: boolean;
  navigationRequest?: InspectorNavigationRequest | null;
  pythonEditorError?: PythonEditorErrorTarget;
  onShowDocumentGlobals?: () => void;
};

class ErrorLineMarker extends GutterMarker {
  override elementClass = "cm-error-gutter";
}

function errorLineExtension(line: number) {
  const position = StateField.define<number>({
    create: (state) =>
      line > 0 && line <= state.doc.lines ? state.doc.line(line).from : -1,
    update: (value, transaction) => transaction.docChanged ? -1 : value,
  });
  return [
    position,
    EditorView.decorations.compute([position], (state) => {
      const from = state.field(position);
      return from < 0 ? Decoration.none : Decoration.set([
        Decoration.line({ class: "cm-error-line" }).range(from),
      ]);
    }),
    gutterLineClass.compute([position], (state) => {
      const from = state.field(position);
      return from < 0
        ? RangeSet.empty
        : RangeSet.of([new ErrorLineMarker().range(from)]);
    }),
  ];
}

function focusEditorLocation(
  view: EditorView,
  location: { line: number; column: number },
) {
  const lineNumber = Math.min(
    Math.max(location.line, 1),
    view.state.doc.lines,
  );
  const line = view.state.doc.line(lineNumber);
  const position = Math.min(
    line.to,
    line.from + Math.max(location.column - 1, 0),
  );
  view.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, { y: "center" }),
  });
  view.focus();
}

function LabelList(
  { items, emptyLabel }: { items: string[]; emptyLabel: string },
) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{emptyLabel}</p>
    );
  }

  return (
    <ul className="mt-2 space-y-1">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">
            {item}
          </span>
        </li>
      ))}
    </ul>
  );
}

function NodeIdButton({
  nodeId,
  label = nodeId,
  onNodeSelect,
}: {
  nodeId: string;
  label?: string;
  onNodeSelect: (nodeId: string) => void;
}) {
  return (
    <button
      type="button"
      className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
      onClick={() => onNodeSelect(nodeId)}
    >
      {label}
    </button>
  );
}

function PreviewBlock(
  { previews }: { previews: Record<string, ValuePreview | null> },
) {
  const entries = Object.entries(previews);

  if (entries.length === 0) {
    return (
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        No values.
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {entries.map(([name, preview]) => (
        preview
          ? <PreviewCard key={name} preview={preview} />
          : <MissingPreviewCard key={name} name={name} />
      ))}
    </div>
  );
}

function MissingPreviewCard({ name }: { name: string }) {
  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {name}
        </span>
        <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
          not previewed
        </span>
      </div>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        Run through the step to prepare and preview this input.
      </p>
    </div>
  );
}

function TablePreviewBlock({ table }: { table: TablePreview }) {
  return (
    <div className="mt-2 overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
      <div className="max-h-80 overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
          <thead className="sticky top-0 z-10 bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            <tr>
              {table.index && (
                <th className="sticky left-0 z-20 whitespace-nowrap border-b border-r border-zinc-200 bg-zinc-100 px-2 py-1.5 font-medium dark:border-zinc-700 dark:bg-zinc-800">
                  {table.indexLabel ?? "index"}
                </th>
              )}
              {table.columns.map((column) => (
                <th
                  key={column.name}
                  title={column.dtype
                    ? `${column.name} · ${column.dtype}`
                    : column.name}
                  className="border-b border-r border-zinc-200 px-2 py-1.5 font-medium last:border-r-0 dark:border-zinc-700"
                >
                  <div className="max-w-44 truncate text-zinc-800 dark:text-zinc-100">
                    {column.name}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                className="odd:bg-white even:bg-zinc-50 dark:odd:bg-zinc-900 dark:even:bg-zinc-800/70"
              >
                {table.index && (
                  <td
                    className={[
                      "sticky left-0 z-[1] whitespace-nowrap border-b border-r border-zinc-100 px-2 py-1.5 font-mono text-zinc-500 dark:border-zinc-800 dark:text-zinc-400",
                      rowIndex % 2 === 0
                        ? "bg-white dark:bg-zinc-900"
                        : "bg-zinc-50 dark:bg-zinc-800",
                    ].join(" ")}
                  >
                    <CellValue value={table.index[rowIndex] ?? null} />
                  </td>
                )}
                {row.map((cell, columnIndex) => (
                  <td
                    key={columnIndex}
                    className="border-b border-r border-zinc-100 px-2 py-1.5 last:border-r-0 dark:border-zinc-800"
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
        <p className="border-t border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
          Showing {table.rows.length} of {table.rowCount}{" "}
          rows{table.columns.length < table.columnCount
            ? ` · ${table.columns.length} of ${table.columnCount} columns`
            : ""}
        </p>
      )}
    </div>
  );
}

function CellValue({ value }: { value: TableCellPreview }) {
  if (value === null) {
    return (
      <span className="font-mono text-zinc-400 dark:text-zinc-500">null</span>
    );
  }
  if (typeof value === "boolean") {
    return (
      <span className="font-mono text-sky-700 dark:text-sky-300">
        {String(value)}
      </span>
    );
  }
  if (typeof value === "number") {
    return (
      <span className="font-mono text-zinc-800 dark:text-zinc-100">
        {value}
      </span>
    );
  }
  if (typeof value === "string") {
    return (
      <span className="block max-w-56 truncate" title={value}>{value}</span>
    );
  }
  if (value.kind === "nan") {
    return (
      <span className="font-mono text-zinc-400 dark:text-zinc-500">NaN</span>
    );
  }
  if (value.kind === "datetime") {
    return (
      <span
        className="block max-w-56 truncate font-mono text-zinc-700 dark:text-zinc-200"
        title={value.value}
      >
        {value.value}
      </span>
    );
  }
  return (
    <span className="block max-w-56 truncate" title={value.value}>
      {value.value}
    </span>
  );
}

function ImagePreviewBlock({
  image,
  alt,
  expandable = false,
}: {
  image: ImagePreview;
  alt: string;
  expandable?: boolean;
}) {
  const [expandedImage, setExpandedImage] = useState<
    {
      image: ImagePreview;
      alt: string;
    } | null
  >(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const imageSource = `data:${image.mimeType};base64,${image.dataBase64}`;
  const closeExpandedImage = () => {
    setExpandedImage(null);
    requestAnimationFrame(() => expandButtonRef.current?.focus());
  };

  return (
    <>
      <div className="mt-2 overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-950">
        <div className="flex max-h-[32rem] justify-center overflow-auto">
          {expandable
            ? (
              <button
                ref={expandButtonRef}
                type="button"
                className="group relative flex w-full cursor-zoom-in justify-center p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
                aria-label={`Expand ${alt}`}
                title={`Expand ${alt}`}
                onClick={() => setExpandedImage({ image, alt })}
              >
                <img
                  src={imageSource}
                  alt={alt}
                  className="h-auto max-w-full object-contain"
                />
                <span className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded bg-zinc-950/75 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <Maximize2 aria-hidden="true" className="h-3.5 w-3.5" />
                  Expand
                </span>
              </button>
            )
            : (
              <div className="flex justify-center p-3">
                <img
                  src={imageSource}
                  alt={alt}
                  className="h-auto max-w-full object-contain"
                />
              </div>
            )}
        </div>
      </div>
      {expandedImage && (
        <ExpandedImageDialog
          image={expandedImage.image}
          alt={expandedImage.alt}
          onClose={closeExpandedImage}
        />
      )}
    </>
  );
}

function ExpandedImageDialog({
  image,
  alt,
  onClose,
}: {
  image: ImagePreview;
  alt: string;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialogRef.current?.showModal();
    closeButtonRef.current?.focus();
    return () => {
      if (dialogRef.current?.open) {
        dialogRef.current.close();
      }
      if (
        previouslyFocused instanceof HTMLElement &&
        previouslyFocused.isConnected
      ) {
        previouslyFocused.focus();
      }
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-label={`${alt} expanded image`}
      className="m-auto w-[min(64rem,calc(100vw-3rem))] max-w-none rounded-lg bg-transparent p-0 backdrop:bg-black/45"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom
        ) {
          onClose();
        }
      }}
    >
      <div className="flex max-h-[calc(100vh-3rem)] flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white text-zinc-950 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
        <div className="flex items-center justify-between gap-4 border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{alt}</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="shrink-0 rounded p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Close expanded image"
            onClick={onClose}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 overflow-auto p-4">
          <img
            src={`data:${image.mimeType};base64,${image.dataBase64}`}
            alt={alt}
            className="mx-auto block h-auto max-h-[calc(100vh-10rem)] max-w-full object-contain"
          />
        </div>
      </div>
    </dialog>
  );
}

function PreviewCard({
  preview,
  imageExpandable = false,
}: {
  preview: ValuePreview;
  imageExpandable?: boolean;
}) {
  const typeLabel = formatPythonType(preview.type);

  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {preview.name}
        </span>
        <span
          className="font-mono text-xs text-zinc-500 dark:text-zinc-400"
          title={preview.type}
        >
          {typeLabel}
        </span>
      </div>
      {preview.image
        ? (
          <ImagePreviewBlock
            image={preview.image}
            alt={preview.name}
            expandable={imageExpandable}
          />
        )
        : preview.table
        ? <TablePreviewBlock table={preview.table} />
        : <JsonPreview preview={preview} />}
      {preview.warning && (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          {preview.warning}
        </p>
      )}
    </div>
  );
}

function previewUpdateTooltip(status?: NodeRunVisualStatus) {
  if (status === "running" || status === "queued") {
    return "Running… showing the last successful values.";
  }
  if (
    status === "failed" || status === "blocked" || status === "blocked_globals"
  ) return "This run failed. Showing the last successful values.";
  return "Showing the last successful run. Run again to apply your changes.";
}

function FlatPreview({
  preview,
  showName = false,
  header,
  previous = false,
  runStatus,
  provenance,
  metadataSuffix,
  interactiveTable,
  imageExpandable = false,
}: {
  preview: ValuePreview;
  showName?: boolean;
  header?: ReactNode;
  previous?: boolean;
  runStatus?: NodeRunVisualStatus;
  provenance?: string;
  metadataSuffix?: ReactNode;
  interactiveTable?: {
    identity: ResultStoreIdentity;
    nodeId: string;
    outputName: string;
  };
  imageExpandable?: boolean;
}) {
  const typeLabel = formatPythonType(preview.type);

  return (
    <div>
      <div
        title={[preview.type, provenance].filter(Boolean).join(" · ")}
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400"
      >
        <div className="flex min-w-0 items-center gap-2">
          {header ??
            (showName && (
              <span className="truncate font-mono font-semibold text-zinc-900 dark:text-zinc-100">
                {preview.name}
              </span>
            ))}
          {previous && (
            <span
              className="shrink-0 text-amber-800/80 dark:text-amber-200/60"
              title={previewUpdateTooltip(runStatus)}
            >
              Not updated
            </span>
          )}
        </div>
        {metadataSuffix}
        <span
          className="ml-auto shrink-0 font-mono"
          title={preview.table
            ? `${preview.table.rowCount} rows × ${preview.table.columnCount} columns`
            : preview.type}
        >
          {preview.table
            ? `${preview.table.rowCount} × ${preview.table.columnCount}`
            : preview.image
            ? null
            : typeLabel}
        </span>
      </div>
      {preview.image
        ? (
          <ImagePreviewBlock
            image={preview.image}
            alt={preview.name}
            expandable={imageExpandable}
          />
        )
        : preview.table
        ? interactiveTable
          ? (
            <ResultTable
              key={`${interactiveTable.nodeId}\u0000${interactiveTable.outputName}`}
              {...interactiveTable}
              initialTable={preview.table}
            />
          )
          : <TablePreviewBlock table={preview.table} />
        : <JsonPreview preview={preview} />}
      {preview.warning && (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          {preview.warning}
        </p>
      )}
    </div>
  );
}

function DisplayResults({ displays }: { displays: ValuePreview[] }) {
  if (displays.length === 0) return null;

  return (
    <section>
      <h4 className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">
        Displays
      </h4>
      <div className="mt-3 space-y-3">
        {displays.map((display, index) => (
          <PreviewCard key={index} preview={display} imageExpandable />
        ))}
      </div>
    </section>
  );
}

function WarningList({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;

  return (
    <section>
      <h4 className="text-xs font-semibold uppercase text-amber-700 dark:text-amber-300">
        Warnings
      </h4>
      <ul className="mt-2 space-y-1 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
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
    ? "mt-2 max-h-48 overflow-auto rounded border border-red-200 bg-red-50 p-3 font-mono text-xs leading-5 text-red-950 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    : "mt-2 max-h-48 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-5 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";

  return (
    <section>
      <h4 className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">
        {title}
      </h4>
      <pre className={blockClassName}>{value}</pre>
    </section>
  );
}

function NodeTraceResult({
  step,
  label,
  nodeLabelsById,
}: {
  step: ExecutionTraceStep | null;
  label: string;
  nodeLabelsById: Record<string, string>;
}) {
  if (!step) {
    return null;
  }

  return (
    <TraceDetails title="Trace" summary={`Step ${step.index}: ${label}`}>
      <TraceStep
        step={step}
        label={label}
        nodeLabelsById={nodeLabelsById}
      />
    </TraceDetails>
  );
}

function GraphInspector({
  themeMode,
  graph,
  graphExecutionState,
  mode,
  readOnly,
  onNodeSelect,
  onGlobalsCodeChange,
  onModeChange,
  selectedOutputKey,
  onSelectedOutputKeyChange,
  pythonEditorError,
  errorFocusRequestId,
}: {
  themeMode: ThemeMode;
  graph: GraphInspectorModel;
  graphExecutionState: GraphExecutionDisplayState | null;
  mode: GraphInspectorMode;
  readOnly: boolean;
  onNodeSelect: (nodeId: string) => void;
  onGlobalsCodeChange: (code: string) => void;
  onModeChange: (mode: GraphInspectorMode) => void;
  selectedOutputKey: string;
  onSelectedOutputKeyChange: (key: string) => void;
  pythonEditorError?: PythonEditorErrorTarget;
  errorFocusRequestId?: number;
}) {
  const globalsEditorRef = useRef<EditorView | null>(null);
  const globalsError = graphExecutionState?.status === "completed" &&
      !graphExecutionState.response.ok &&
      graphExecutionState.response.error?.phase === "document_globals"
    ? graphExecutionState.response.error
    : null;

  useEffect(() => {
    if (
      mode === "overview" && pythonEditorError?.editor === "globals" &&
      errorFocusRequestId !== undefined && globalsEditorRef.current
    ) {
      focusEditorLocation(globalsEditorRef.current, pythonEditorError);
    }
  }, [errorFocusRequestId, mode, pythonEditorError]);

  if (mode === "results") {
    return (
      <div className="h-full" data-inspector-target="run_result">
        <GraphRunResult
          executionState={graphExecutionState}
          nodeLabelsById={graph.nodeLabelsById}
          onNodeSelect={onNodeSelect}
          onShowDocumentGlobals={() => onModeChange("overview")}
          selectedOutputKey={selectedOutputKey}
          onSelectedOutputKeyChange={onSelectedOutputKeyChange}
        />
      </div>
    );
  }

  return (
    <section
      data-inspector-target="document_globals"
      className={[
        "flex h-full min-h-0 flex-col",
        globalsError
          ? "rounded border border-red-300 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/40"
          : "",
      ].join(" ")}
    >
      <h3
        className={[
          "text-xs font-semibold uppercase",
          globalsError ? "text-red-800 dark:text-red-300" : "text-zinc-500",
        ].join(" ")}
      >
        Document Globals
      </h3>
      <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        Imports, constants, and helpers shared by every step.
      </p>
      <div
        className={[
          "mt-3 min-h-52 flex-1 overflow-hidden [&_.cm-content]:pb-6 [&_.cm-editor]:h-full [&_.cm-editor]:text-sm [&_.cm-scroller]:font-mono",
          globalsError ? "border-red-300" : "border-zinc-200",
        ].join(" ")}
      >
        <CodeMirror
          className="inspector-code-editor h-full"
          value={graph.globalsCode}
          height="100%"
          extensions={[
            python(),
            EditorView.contentAttributes.of({
              "aria-label": "Document globals Python code",
            }),
          ]}
          readOnly={readOnly}
          onCreateEditor={(view) => {
            globalsEditorRef.current = view;
          }}
          onChange={onGlobalsCodeChange}
          basicSetup={{
            autocompletion: false,
            closeBrackets: true,
            foldGutter: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            lineNumbers: true,
          }}
          theme={themeMode}
        />
      </div>
      {pythonEditorError?.editor === "globals" && (
        <p className="mt-2 text-sm font-medium text-red-800 dark:text-red-200">
          Line {pythonEditorError.line}, column {pythonEditorError.column}:
          {"  "}{pythonEditorError.message}
        </p>
      )}
      {globalsError && (
        <div className="mt-2 text-sm text-red-800 dark:text-red-200">
          <p className="font-medium">
            {globalsError.message || "Document Globals failed."}
          </p>
          {globalsError.error && globalsError.error !== globalsError.message &&
            (
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                {globalsError.error}
              </p>
            )}
          {globalsError.pythonExecutable && (
            <p className="mt-1 truncate font-mono text-xs opacity-80">
              Python: {globalsError.pythonExecutable}
            </p>
          )}
          {globalsError.stderr?.trim() && (
            <details className="mt-3 overflow-hidden rounded border border-red-300 bg-white/60 dark:border-red-800 dark:bg-red-950/40">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                Python traceback
              </summary>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-red-300 p-3 font-mono text-xs leading-5 dark:border-red-800">
                {globalsError.stderr}
              </pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function GraphRunResult({
  executionState,
  nodeLabelsById,
  onNodeSelect,
  onShowDocumentGlobals,
  selectedOutputKey,
  onSelectedOutputKeyChange,
}: {
  executionState: GraphExecutionDisplayState | null;
  nodeLabelsById: Record<string, string>;
  onNodeSelect: (nodeId: string) => void;
  onShowDocumentGlobals: () => void;
  selectedOutputKey: string;
  onSelectedOutputKeyChange: (key: string) => void;
}) {
  if (!executionState) {
    return (
      <div className="flex h-full min-h-72 flex-col items-center justify-center rounded border border-dashed border-zinc-300 px-8 text-center dark:border-zinc-700">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
          No graph results yet
        </p>
        <p className="mt-1 max-w-sm text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          Run the graph to inspect its displays and sink outputs here.
        </p>
      </div>
    );
  }

  if (executionState.status === "running") {
    return (
      <div className="rounded border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/40">
        <p className="text-sm font-medium text-blue-900 dark:text-blue-200">
          Running graph…
        </p>
        <p className="mt-1 text-xs text-blue-700 dark:text-blue-300">
          Displays and sink outputs will appear when the run completes.
        </p>
      </div>
    );
  }

  if (executionState.status === "request_error") {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
        <p className="text-sm font-medium text-red-800 dark:text-red-200">
          Could not start graph run
        </p>
        <p className="mt-2 font-mono text-xs text-red-950 dark:text-red-300">
          {executionState.message}
        </p>
      </div>
    );
  }

  const response = executionState.response;
  const latestFailure = executionState.freshness === "failed_run"
    ? executionState.latestFailure
    : undefined;

  return (
    <div className="space-y-4">
      {executionState.freshness !== "fresh" && (
        <div className="py-2 text-xs text-amber-800 dark:text-amber-200">
          <p className="text-sm font-medium">
            {executionState.freshness === "failed_run"
              ? "Showing the previous result"
              : "Results are stale"}
          </p>
          <p className="mt-1 text-xs">
            {executionState.freshness === "failed_run"
              ? "The latest run failed, so this successful result was kept for inspection."
              : executionState.freshness === "replaced"
              ? "A newer successful run replaced the live result set. This preview is preserved for context."
              : "The graph changed after this run. These results are preserved for context until you run the graph again."}
          </p>
        </div>
      )}

      {latestFailure && (
        <GraphFailureDetails
          response={latestFailure}
          nodeLabelsById={nodeLabelsById}
          onNodeSelect={onNodeSelect}
          onShowDocumentGlobals={onShowDocumentGlobals}
        />
      )}

      <div
        className={executionState.freshness === "document_changed" ||
            executionState.freshness === "replaced"
          ? "opacity-60"
          : ""}
      >
        {response.ok
          ? (
            <GraphOutputPreview
              response={response}
              freshness={executionState.freshness}
              nodeLabelsById={nodeLabelsById}
              onNodeSelect={onNodeSelect}
              selectedKey={selectedOutputKey}
              onSelectedKeyChange={onSelectedOutputKeyChange}
            />
          )
          : (
            <GraphFailureDetails
              response={response}
              nodeLabelsById={nodeLabelsById}
              onNodeSelect={onNodeSelect}
              onShowDocumentGlobals={onShowDocumentGlobals}
            />
          )}
      </div>

      <GraphTraceResult
        response={latestFailure ?? response}
        nodeLabelsById={nodeLabelsById}
      />
    </div>
  );
}

function GraphFailureDetails({
  response,
  nodeLabelsById,
  onNodeSelect,
  onShowDocumentGlobals,
}: {
  response: ExecutionResponse;
  nodeLabelsById: Record<string, string>;
  onNodeSelect: (nodeId: string) => void;
  onShowDocumentGlobals: () => void;
}) {
  return (
    <div className="rounded border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
      <p className="text-sm font-medium text-red-800 dark:text-red-200">
        Latest graph run failed
      </p>
      <p className="mt-1 text-sm text-red-700 dark:text-red-300">
        {response.error?.message ?? "Python execution failed."}
      </p>
      {response.error?.phase === "document_globals" && (
        <button
          type="button"
          className="mt-3 rounded border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100 dark:border-red-700 dark:bg-red-950 dark:text-red-200 dark:hover:bg-red-900"
          onClick={onShowDocumentGlobals}
        >
          Open Document Globals
        </button>
      )}
      {response.error?.nodeId && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase text-red-700 dark:text-red-300">
            Failed at
          </p>
          <div className="mt-1">
            <NodeIdButton
              nodeId={response.error.nodeId}
              label={nodeLabelsById[response.error.nodeId]}
              onNodeSelect={onNodeSelect}
            />
          </div>
        </div>
      )}
    </div>
  );
}

type GraphOutputOption = {
  key: string;
  kind: "output" | "display";
  nodeId: string;
  nodeLabel: string;
  name: string;
  preview: ValuePreview;
};

function graphOutputOptions(
  response: ExecutionResponse,
  nodeLabelsById: Record<string, string>,
): GraphOutputOption[] {
  const displayOptions = response.executedNodeIds.flatMap((nodeId) =>
    (response.resultsByNode[nodeId]?.displays ?? []).map(
      (preview, index) => ({
        key: `display:${nodeId}:${index}`,
        kind: "display" as const,
        nodeId,
        nodeLabel: nodeLabelsById[nodeId] ?? nodeId,
        name: preview.name,
        preview,
      }),
    )
  );
  const outputOptions = response.finalNodeIds.flatMap((nodeId) =>
    Object.entries(response.finalOutputsByNode[nodeId] ?? {}).map(
      ([name, preview]) => ({
        key: `output:${nodeId}:${name}`,
        kind: "output" as const,
        nodeId,
        nodeLabel: nodeLabelsById[nodeId] ?? nodeId,
        name,
        preview,
      }),
    )
  );
  return [...displayOptions, ...outputOptions];
}

function GraphOutputPreview({
  response,
  freshness,
  nodeLabelsById,
  onNodeSelect,
  selectedKey,
  onSelectedKeyChange,
}: {
  response: ExecutionResponse;
  freshness: ResultFreshness;
  nodeLabelsById: Record<string, string>;
  onNodeSelect: (nodeId: string) => void;
  selectedKey: string;
  onSelectedKeyChange: (key: string) => void;
}) {
  const options = graphOutputOptions(response, nodeLabelsById);
  const resolvedSelectedKey = resolveGraphOutputSelection(
    selectedKey,
    options.map((option) => option.key),
  );

  useEffect(() => {
    if (resolvedSelectedKey !== selectedKey) {
      onSelectedKeyChange(resolvedSelectedKey);
    }
  }, [onSelectedKeyChange, resolvedSelectedKey, selectedKey]);

  const selected =
    options.find((option) => option.key === resolvedSelectedKey) ??
      options[0];

  if (!selected) {
    return (
      <div className="rounded border border-zinc-200 p-4 dark:border-zinc-700">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
          Graph completed
        </p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          No displays or sink outputs were produced.
        </p>
      </div>
    );
  }

  return (
    <section>
      <div>
        <FlatPreview
          showName
          preview={{ ...selected.preview, name: selected.name }}
          imageExpandable={selected.kind === "display"}
          interactiveTable={response.finalOutputsByNode[selected.nodeId]?.[
              selected.name
            ] &&
              response.resultStore &&
              (freshness === "fresh" || freshness === "failed_run")
            ? {
              identity: response.resultStore,
              nodeId: selected.nodeId,
              outputName: selected.name,
            }
            : undefined}
          metadataSuffix={
            <span className="font-sans">
              {selected.kind} from{" "}
              <button
                type="button"
                className="font-medium text-zinc-700 hover:underline dark:text-zinc-200"
                onClick={() => onNodeSelect(selected.nodeId)}
              >
                {selected.nodeLabel}
              </button>
            </span>
          }
        />
      </div>
    </section>
  );
}

function GraphTraceResult({
  response,
  nodeLabelsById,
}: {
  response: ExecutionResponse;
  nodeLabelsById: Record<string, string>;
}) {
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
            label={nodeLabelsById[step.nodeId]}
            nodeLabelsById={nodeLabelsById}
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

function TraceStep({
  step,
  label = "Step",
  nodeLabelsById = {},
}: {
  step: ExecutionTraceStep;
  label?: string;
  nodeLabelsById?: Record<string, string>;
}) {
  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-zinc-500">Step {step.index}</p>
          <p className="mt-1 text-sm font-semibold text-zinc-900">
            {label}
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
          <LabelList
            items={step.dependsOn.map((nodeId) =>
              nodeLabelsById[nodeId] ?? "Step"
            )}
            emptyLabel="No dependencies"
          />
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
        <DisplayResults displays={step.displays} />
        <TextOutputBlock title="Stdout" value={step.stdout} />
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
  nameEditor,
  themeMode,
  selectedNode,
  executionState,
  runStatus,
  mode,
  onModeChange,
  readOnly,
  actionsDisabled,
  onCodeChange,
  onNodeMetadataChange,
  onNodeSelect,
  onRunToNode,
  onDeleteNode,
  onShowDocumentGlobals,
  onOpenCode,
  pythonEditorError,
  errorFocusRequestId,
  selectedContent,
  onContentSelect,
  selectedVariableName,
  onVariableSelect,
}: {
  nameEditor: ReactNode;
  themeMode: ThemeMode;
  selectedNode: NodeInspectorSelection;
  executionState: ExecutionDisplayState | null;
  runStatus: NodeRunVisualStatus;
  mode: NodeInspectorMode;
  onModeChange: (mode: NodeInspectorMode) => void;
  readOnly: boolean;
  actionsDisabled: boolean;
  onCodeChange: (nodeId: string, code: string) => void;
  onNodeMetadataChange: (
    nodeId: string,
    metadata: { description?: string },
  ) => void;
  onNodeSelect: (nodeId: string) => void;
  onRunToNode: (nodeId: string, options?: { trace?: boolean }) => void;
  onDeleteNode?: (nodeId: string) => void;
  onShowDocumentGlobals?: () => void;
  onOpenCode: () => void;
  pythonEditorError?: PythonEditorErrorTarget;
  errorFocusRequestId?: number;
  selectedContent: string;
  onContentSelect: (content: string) => void;
  selectedVariableName: string;
  onVariableSelect: (name: string) => void;
}) {
  const metadataReadOnly = readOnly || !selectedNode.editable;
  const codeReadOnly = readOnly || !selectedNode.editable;
  const runSummary = getNodeRunSummary(
    selectedNode,
    executionState,
    runStatus,
  );
  const isBlockedByDocumentGlobals = executionState?.status === "completed" &&
    !executionState.response.ok &&
    executionState.response.error?.phase === "document_globals";
  const extensions = useMemo(() => [
    python(),
    EditorView.contentAttributes.of({ "aria-label": "Step Python code" }),
    EditorView.lineWrapping,
    keymap.of([
      {
        key: "Shift-Enter",
        run: () => {
          if (actionsDisabled) {
            return true;
          }

          onRunToNode(selectedNode.id);
          return true;
        },
      },
    ]),
  ], [actionsDisabled, onRunToNode, selectedNode.id]);
  const [runtimeFocus, setRuntimeFocus] = useState<
    { target: PythonEditorErrorTarget; requestId: number } | null
  >(null);
  const currentResult = getNodeResult(executionState, selectedNode.id);
  const snapshot = currentResult?.ok
    ? currentResult
    : selectedNode.lastSuccessfulResult;
  const latestResult =
    executionState?.status === "completed" && executionState.latestFailure
      ? executionState.latestFailure.resultsByNode[selectedNode.id]
      : currentResult;
  const items = [
    ...(latestResult?.error ? [{ id: "error", label: "Error" }] : []),
    ...(latestResult?.displays ?? []).map((display, index) => ({
      id: `display:${index}`,
      label: display.name,
    })),
    ...(latestResult?.stdout || latestResult?.stderr ||
        latestResult?.warnings.length
      ? [{ id: "console", label: "Console" }]
      : []),
    ...(executionState?.status === "completed" &&
        (executionState.latestFailure ?? executionState.response).trace
      ? [{ id: "trace", label: "Trace" }]
      : []),
  ];
  const codeError = pythonEditorError?.editor === "node" &&
      pythonEditorError.nodeId === selectedNode.id
    ? pythonEditorError
    : runStatus === "failed" && latestResult?.errorLocation
    ? {
      ...latestResult.errorLocation,
      editor: "node" as const,
      nodeId: selectedNode.id,
      message: latestResult.error ?? "Run failed",
    }
    : undefined;
  const failureNodeId = executionState?.status === "completed"
    ? (executionState.latestFailure ?? executionState.response).error?.nodeId
    : undefined;
  const codeSummary: NodeRunSummary = codeError
    ? {
      variant: "danger",
      title: pythonEditorError ? "Code error" : runSummary.title,
      detail: codeError.message,
    }
    : runSummary;
  const openFailureCode = () => {
    if (codeError) {
      setRuntimeFocus({
        target: codeError,
        requestId: Date.now(),
      });
    }
    onOpenCode();
  };
  const content = selectedContent === "variables" ||
      items.some((item) => item.id === selectedContent)
    ? selectedContent
    : "variables";
  return (
    <div className="inspector-body">
      <nav className="inspector-nav" aria-label="Inspector navigation">
        <button
          type="button"
          className={latestResult?.error || pythonEditorError?.editor === "node"
            ? "code-tab-error"
            : undefined}
          title={latestResult?.error
            ? "This step failed — open Code to fix it"
            : undefined}
          aria-pressed={mode === "code"}
          onClick={() => onModeChange("code")}
        >
          Code
        </button>
        <button
          type="button"
          aria-pressed={mode === "results"}
          onClick={() => onModeChange("results")}
        >
          Results
        </button>
        {mode === "results" && (
          <div className="result-nav-children">
            {selectedNode.variables.map((variable) => (
              <button
                type="button"
                className="result-nav-item"
                title={variable.name}
                key={variable.name}
                aria-pressed={content === "variables" &&
                  selectedVariableName === variable.name}
                onClick={() => {
                  onContentSelect("variables");
                  onVariableSelect(variable.name);
                }}
              >
                <span className="truncate font-mono">{variable.name}</span>
              </button>
            ))}
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                className="result-nav-item"
                title={item.label}
                aria-label={item.id.startsWith("display:")
                  ? `${item.label} display`
                  : item.label}
                aria-pressed={content === item.id}
                onClick={() => onContentSelect(item.id)}
              >
                {item.id.startsWith("display:")
                  ? (
                    <>
                      <span className="truncate font-mono">{item.label}</span>
                      <Presentation
                        aria-hidden="true"
                        className="h-3 w-3 shrink-0 opacity-60"
                      />
                    </>
                  )
                  : item.label}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          aria-pressed={mode === "details"}
          onClick={() => onModeChange("details")}
        >
          Details
        </button>
      </nav>
      <div className="min-w-0 min-h-0 flex-1">
        <div
          hidden={mode !== "details"}
          className="h-full overflow-y-auto px-5 py-3"
        >
          {nameEditor}
          <div className="mt-4 text-xs text-zinc-500">Function name</div>
          <p className="mt-1 font-mono text-sm">
            {selectedNode.functionName ?? "Custom Python"}
          </p>
          <div className="space-y-4 py-3">
            <section>
              <label className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">
                Description
              </label>
              <textarea
                aria-label="Step description"
                className="mt-2 min-h-24 w-full resize-y rounded border border-zinc-200 bg-white p-3 text-sm leading-5 text-zinc-800 outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                value={selectedNode.description}
                placeholder="What does this step do?"
                readOnly={metadataReadOnly}
                onChange={(event) =>
                  onNodeMetadataChange(selectedNode.id, {
                    description: event.currentTarget.value,
                  })}
              />
            </section>

            {onDeleteNode && (
              <DeleteNodeAction
                selectedNode={selectedNode}
                disabled={actionsDisabled}
                onDeleteNode={onDeleteNode}
              />
            )}
          </div>
        </div>
        <div hidden={mode !== "results"} className="h-full">
          <NodeResults
            snapshot={snapshot}
            selectedNode={selectedNode}
            executionState={executionState}
            runStatus={runStatus}
            runSummary={runSummary}
            onViewError={isBlockedByDocumentGlobals
              ? onShowDocumentGlobals
              : undefined}
            onOpenCode={runStatus === "failed" ? openFailureCode : undefined}
            selectedVariableName={selectedVariableName}
            selectedContent={content}
          />
        </div>
        <div hidden={mode !== "code"} className="h-full">
          <div className="flex h-full min-h-0 flex-col">
            {codeSummary.variant === "danger" && (
              <NodeRunBanner
                summary={codeSummary}
                onLocate={codeError
                  ? openFailureCode
                  : failureNodeId && failureNodeId !== selectedNode.id
                  ? () => onNodeSelect(failureNodeId)
                  : undefined}
                inputStatus={snapshot
                  ? "Previous variable values are preserved."
                  : undefined}
                onViewError={isBlockedByDocumentGlobals
                  ? onShowDocumentGlobals
                  : undefined}
              />
            )}
            <div className="min-h-0 flex-1">
              <CodeWorkspace
                snapshot={snapshot}
                selectedNode={selectedNode}
                runStatus={runStatus}
              >
                <NodeCode
                  themeMode={themeMode}
                  selectedNode={selectedNode}
                  codeReadOnly={codeReadOnly}
                  extensions={extensions}
                  onCodeChange={onCodeChange}
                  pythonEditorError={codeError}
                  errorFocusRequestId={errorFocusRequestId ??
                    runtimeFocus?.requestId}
                />
              </CodeWorkspace>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CodeWorkspace(
  { snapshot, selectedNode, runStatus, children }: {
    snapshot?: NodeRunResult;
    selectedNode: NodeInspectorSelection;
    runStatus: NodeRunVisualStatus;
    children: ReactNode;
  },
) {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const inputs = snapshot?.inputs ?? {};
  const outputs = snapshot?.outputs ?? {};
  const pane = (
    kind: "Input" | "Output",
    values: Record<string, ValuePreview>,
    selection: string,
    choose: (name: string) => void,
  ) => {
    const names = Object.keys(values);
    const name = names.includes(selection) ? selection : names[0];
    const header = (
      <div className="flex min-w-0 items-center gap-3">
        <span className="text-xs text-zinc-500">
          {kind}s · {names.length}
        </span>
        {names.length > 0 && (
          <select
            aria-label={`Select ${kind.toLowerCase()} variable`}
            className="min-w-0 max-w-48 truncate"
            title={selectedNode.inputSources?.[name]}
            value={name}
            onChange={(event) => choose(event.target.value)}
          >
            {names.map((name) => (
              <option key={name} value={name}>
                {name}
                {kind === "Input" && selectedNode.inputSources?.[name]
                  ? ` · ${selectedNode.inputSources[name]}`
                  : ""}
              </option>
            ))}
          </select>
        )}
      </div>
    );
    return (
      <section className="preview-pane" aria-label={`${kind} preview`}>
        {name
          ? (
            <FlatPreview
              preview={values[name]}
              header={header}
              previous={runStatus !== "completed"}
              runStatus={runStatus}
              provenance={kind === "Input"
                ? `Captured before this step · from ${
                  selectedNode.inputSources?.[name] ?? "upstream"
                }`
                : "Latest successful run"}
              imageExpandable
            />
          )
          : (
            <div>
              {header}
              <p className="mt-6 text-sm text-zinc-500">
                {snapshot
                  ? `No ${kind.toLowerCase()} variables.`
                  : "Run this step to preview its input and output values."}
              </p>
            </div>
          )}
      </section>
    );
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <WorkspaceSplit
          storageKey="code-width"
          initial={54}
          label="Resize code and previews"
          first={children}
          second={
            <WorkspaceSplit
              vertical
              storageKey="input-height"
              label="Resize input and output previews"
              first={pane("Input", inputs, input, setInput)}
              second={pane("Output", outputs, output, setOutput)}
            />
          }
        />
      </div>
    </div>
  );
}

function NodeCode({
  themeMode,
  selectedNode,
  codeReadOnly,
  extensions,
  onCodeChange,
  pythonEditorError,
  errorFocusRequestId,
}: {
  themeMode: ThemeMode;
  selectedNode: NodeInspectorSelection;
  codeReadOnly: boolean;
  extensions: Array<
    ReturnType<typeof python> | ReturnType<typeof keymap.of>
  >;
  onCodeChange: (nodeId: string, code: string) => void;
  pythonEditorError?: PythonEditorErrorTarget;
  errorFocusRequestId?: number;
}) {
  const errorDecorations = useMemo(
    () => pythonEditorError ? errorLineExtension(pythonEditorError.line) : [],
    [
      pythonEditorError?.line,
      pythonEditorError?.message,
      selectedNode.id,
      errorFocusRequestId,
    ],
  );
  const editorExtensions = useMemo(() => [...extensions, errorDecorations], [
    extensions,
    errorDecorations,
  ]);
  const codeEditorRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (
      pythonEditorError?.editor === "node" &&
      pythonEditorError.nodeId === selectedNode.id &&
      errorFocusRequestId !== undefined && codeEditorRef.current
    ) {
      focusEditorLocation(codeEditorRef.current, pythonEditorError);
    }
  }, [errorFocusRequestId, pythonEditorError, selectedNode.id]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-900">
      <section className="flex min-h-60 flex-1 flex-col bg-white dark:bg-zinc-900">
        <div className="min-h-0 flex-1 overflow-hidden bg-zinc-50 dark:bg-zinc-950 [&_.cm-editor]:h-full [&_.cm-editor]:text-xs [&_.cm-scroller]:font-mono">
          <div data-shortcut-scope="editor" className="h-full">
            <CodeMirror
              className="inspector-code-editor h-full"
              value={selectedNode.code}
              height="100%"
              extensions={editorExtensions}
              readOnly={codeReadOnly}
              onCreateEditor={(view) => {
                codeEditorRef.current = view;
              }}
              onChange={(value) => onCodeChange(selectedNode.id, value)}
              basicSetup={{
                autocompletion: false,
                closeBrackets: true,
                foldGutter: true,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                lineNumbers: true,
              }}
              theme={themeMode}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function getPreviewState(
  status: NodeRunVisualStatus,
  hasPreview: boolean,
): { label: string; className: string; dotClassName: string } | null {
  if (status === "stale") {
    return {
      label: "Stale",
      className: "text-amber-700 dark:text-amber-300",
      dotClassName: "bg-amber-500",
    };
  }
  if (status === "running" || status === "queued") {
    return {
      label: status === "running" ? "Running" : "Queued",
      className: "text-blue-700 dark:text-blue-300",
      dotClassName: "bg-blue-500",
    };
  }
  if (
    status === "failed" || status === "blocked" ||
    status === "blocked_globals"
  ) {
    return {
      label: "Failed",
      className: "text-red-700 dark:text-red-300",
      dotClassName: "bg-red-500",
    };
  }
  if (status === "completed" || hasPreview) {
    return {
      label: "Fresh",
      className: "text-emerald-700 dark:text-emerald-300",
      dotClassName: "bg-emerald-500",
    };
  }
  return null;
}

function NodeResults({
  snapshot,
  selectedContent,
  selectedNode,
  executionState,
  runStatus,
  runSummary,
  onViewError,
  onOpenCode,
  selectedVariableName,
}: {
  snapshot?: NodeRunResult;
  selectedContent: string;
  selectedNode: NodeInspectorSelection;
  executionState: ExecutionDisplayState | null;
  runStatus: NodeRunVisualStatus;
  runSummary: NodeRunSummary;
  onViewError?: () => void;
  onOpenCode?: () => void;
  selectedVariableName: string;
}) {
  const baseResult = getNodeResult(executionState, selectedNode.id);
  const latestFailure = executionState?.status === "completed" &&
      executionState.freshness === "failed_run"
    ? executionState.latestFailure
    : undefined;
  const latestAttemptResult = latestFailure?.resultsByNode[selectedNode.id] ??
    baseResult;
  const displays = latestAttemptResult?.displays ?? [];
  const selectedDisplay = selectedContent.startsWith("display:")
    ? displays[Number(selectedContent.slice(8))]
    : undefined;
  const stdout = latestAttemptResult?.stdout ?? "";
  const stderr = latestAttemptResult?.stderr ?? "";
  const warnings = latestAttemptResult?.warnings ?? [];
  const selectedVariable =
    selectedNode.variables.find((variable) =>
      variable.name === selectedVariableName
    ) ?? selectedNode.variables[0] ?? null;
  const selectedPreview = selectedVariable
    ? selectedNode.variablePreviews[selectedVariable.name] ??
      snapshot?.variables[selectedVariable.name] ??
      snapshot?.outputs[selectedVariable.name] ?? null
    : null;
  const interactiveTable = selectedVariable && selectedPreview?.table &&
      selectedNode.routedOutputs.includes(selectedVariable.name) &&
      executionState?.status === "completed" &&
      executionState.response.resultStore &&
      (executionState.freshness === "fresh" ||
        executionState.freshness === "failed_run")
    ? {
      identity: executionState.response.resultStore,
      nodeId: selectedNode.id,
      outputName: selectedVariable.name,
    }
    : undefined;
  const traceStep = executionState?.status === "completed"
    ? (latestFailure ?? executionState.response).trace?.find((step) =>
      step.nodeId === selectedNode.id
    ) ?? null
    : null;
  const valuesAreStale = runStatus !== "completed" ||
    (executionState?.status === "completed" &&
      executionState.freshness !== "fresh");

  return (
    <div className="node-results h-full overflow-y-auto px-5 py-3">
      <div className="space-y-4">
        {runSummary.variant === "danger" && (
          <div className="result-banner">
            <NodeRunBanner
              summary={runSummary}
              inputStatus={snapshot
                ? "Previous variable values are preserved."
                : undefined}
              onViewError={onViewError}
              onOpenCode={onOpenCode}
            />
          </div>
        )}

        {(selectedContent.startsWith("display:") ||
          selectedContent === "console" ||
          selectedContent === "error") && (
          <p className="text-xs text-zinc-500">
            Latest execution attempt{latestAttemptResult?.ok === false
              ? " · stopped before completion"
              : ""}
          </p>
        )}
        {selectedDisplay && (
          <FlatPreview preview={selectedDisplay} showName imageExpandable />
        )}

        {selectedContent === "variables" && (
          <div>
            {selectedVariable && selectedPreview
              ? (
                <FlatPreview
                  showName
                  previous={!!snapshot && valuesAreStale}
                  runStatus={runStatus}
                  preview={{ ...selectedPreview, name: selectedVariable.name }}
                  interactiveTable={interactiveTable}
                />
              )
              : (
                <p className="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  {getMissingVariablePreviewMessage(
                    selectedVariable,
                    runStatus,
                  )}
                </p>
              )}
          </div>
        )}

        {selectedContent === "error" && (
          <div>
            {latestAttemptResult?.errorLocation && (
              <p className="mb-3 font-mono text-xs text-zinc-500">
                {selectedNode.functionName} · line{" "}
                {latestAttemptResult.errorLocation.line}
              </p>
            )}
            <TextOutputBlock
              title="Error"
              value={latestAttemptResult?.error ?? "No error details."}
              variant="danger"
            />
          </div>
        )}
        {selectedContent === "console" && (
          <div className="space-y-4">
            <TextOutputBlock title="Stdout" value={stdout} />
            <WarningList warnings={warnings} />
            <TextOutputBlock title="Stderr" value={stderr} variant="danger" />
          </div>
        )}

        {selectedContent === "trace" && traceStep && (
          <NodeTraceResult
            step={traceStep}
            label={selectedNode.displayName}
            nodeLabelsById={selectedNode.nodeLabelsById}
          />
        )}
      </div>
    </div>
  );
}

function getNodeResult(
  executionState: ExecutionDisplayState | null,
  nodeId: string,
): NodeRunResult | null {
  if (
    !executionState || executionState.status === "running" ||
    executionState.status === "request_error"
  ) {
    return null;
  }
  if (
    executionState.status === "completed_node" ||
    executionState.status === "failed_node"
  ) {
    return executionState.result;
  }
  return executionState.response.resultsByNode[nodeId] ?? null;
}

function getMissingVariablePreviewMessage(
  variable: NodeInspectorSelection["variables"][number] | null,
  runStatus: NodeRunVisualStatus,
): string {
  if (!variable) return "Select a variable to inspect its final value.";
  if (variable.source === "missing") {
    return "This routed variable no longer exists in the step code.";
  }
  if (runStatus === "failed") {
    return "No variable values were captured because this step failed.";
  }
  if (runStatus === "blocked" || runStatus === "blocked_globals") {
    return "This step did not run, so no current value is available.";
  }
  if (runStatus === "running" || runStatus === "queued") {
    return "The final value will appear after this step completes.";
  }
  return "Run through this step to capture its final value.";
}

type NodeRunSummary = {
  variant: "neutral" | "success" | "warning" | "danger" | "info";
  title: string;
  detail: string;
};

function NodeRunBanner({
  onLocate,
  summary,
  inputStatus,
  onViewError,
  onOpenCode,
}: {
  onLocate?: () => void;
  summary: NodeRunSummary;
  inputStatus?: string;
  onViewError?: () => void;
  onOpenCode?: () => void;
}) {
  const variant = summary.variant;
  const styles = {
    neutral: "text-zinc-600 dark:text-zinc-400",
    success: "text-emerald-700 dark:text-emerald-400",
    warning:
      "bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200",
    danger: "bg-red-50 text-red-900 dark:bg-red-950/30 dark:text-red-200",
    info: "text-blue-700 dark:text-blue-300",
  }[variant];

  if (variant === "danger") {
    return (
      <div className="run-failure-strip" role="alert">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <p className="shrink-0 font-semibold">{summary.title}</p>
          <div className="min-w-0 flex-1 break-words font-mono text-xs opacity-80">
            {onLocate
              ? (
                <button
                  type="button"
                  className="text-left"
                  title="Go to error source"
                  onClick={onLocate}
                >
                  {summary.detail}
                </button>
              )
              : summary.detail}
          </div>
          {onOpenCode && (
            <button
              type="button"
              className="shrink-0 text-xs font-medium underline decoration-current/40 underline-offset-4"
              onClick={onOpenCode}
            >
              Open Code
            </button>
          )}
          {onViewError && (
            <button
              type="button"
              className="shrink-0 text-xs font-medium underline decoration-current/40 underline-offset-4"
              onClick={onViewError}
            >
              View Document Globals
            </button>
          )}
        </div>
        {inputStatus && (
          <p className="mt-1 text-xs opacity-60">{inputStatus}</p>
        )}
      </div>
    );
  }

  return (
    <div className={`px-3 py-2 text-sm ${styles}`}>
      <div className="flex items-start gap-2">
        {variant === "warning" && (
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0"
            strokeWidth={2.25}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium">{summary.title}</p>
          <p className="mt-0.5 text-xs opacity-80">{summary.detail}</p>
          {inputStatus && (
            <p className="mt-1 text-xs opacity-70">{inputStatus}</p>
          )}
          {onViewError && (
            <button
              type="button"
              className="mt-2 rounded border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-900 hover:bg-red-100 dark:border-red-700 dark:bg-red-900 dark:text-red-100 dark:hover:bg-red-800"
              onClick={onViewError}
            >
              View Document Globals
            </button>
          )}
          {onOpenCode && (
            <button
              type="button"
              className="mt-2 rounded border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-900 hover:bg-red-100 dark:border-red-700 dark:bg-red-900 dark:text-red-100 dark:hover:bg-red-800"
              onClick={onOpenCode}
            >
              Open Code
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function getNodeRunSummary(
  selectedNode: NodeInspectorSelection,
  executionState: ExecutionDisplayState | null,
  runStatus: NodeRunVisualStatus,
): NodeRunSummary {
  if (executionState?.status === "running" || runStatus === "running") {
    return {
      variant: "info",
      title: "Running",
      detail: "This step is executing.",
    };
  }

  if (runStatus === "queued") {
    return {
      variant: "neutral",
      title: "Queued",
      detail: "This step is waiting for upstream work to finish.",
    };
  }

  if (runStatus === "stale") {
    return {
      variant: "warning",
      title: "Stale result",
      detail: "Code, routing, or upstream inputs changed since the last run.",
    };
  }

  if (
    executionState?.status === "completed" &&
    (executionState.freshness === "document_changed" ||
      executionState.freshness === "replaced")
  ) {
    return {
      variant: "warning",
      title: "Stale result",
      detail: executionState.freshness === "replaced"
        ? "A newer run replaced the interactive result store."
        : "The document changed since these values were produced.",
    };
  }

  if (executionState?.status === "request_error") {
    return {
      variant: "danger",
      title: "Could not start run",
      detail: executionState.message,
    };
  }

  if (
    executionState?.status === "completed_node" ||
    executionState?.status === "failed_node"
  ) {
    return executionState.result.ok
      ? {
        variant: "success",
        title: "Step completed",
        detail: "This step ran successfully.",
      }
      : {
        variant: "danger",
        title: "Step failed",
        detail: executionState.result.error ?? "Python execution failed.",
      };
  }

  if (executionState?.status === "completed") {
    if (
      executionState.freshness === "failed_run" &&
      executionState.latestFailure
    ) {
      const latestResult =
        executionState.latestFailure.resultsByNode[selectedNode.id];
      if (
        latestResult && !latestResult.ok ||
        executionState.latestFailure.error?.nodeId === selectedNode.id
      ) {
        return {
          variant: "danger",
          title: "Step failed",
          detail: latestResult?.error ??
            executionState.latestFailure.error?.message ??
            "Python execution failed.",
        };
      }
    }
    const nodeResult = executionState.response.resultsByNode[selectedNode.id];
    if (nodeResult) {
      return nodeResult.ok
        ? {
          variant: "success",
          title: "Step completed",
          detail: "This step ran successfully.",
        }
        : {
          variant: "danger",
          title: "Step failed",
          detail: nodeResult.error ?? "Python execution failed.",
        };
    }

    if (!executionState.response.ok) {
      const error = executionState.response.error;
      const failedNodeId = error?.nodeId;
      if (error?.phase === "document_globals") {
        return {
          variant: "danger",
          title: "Blocked by Document Globals",
          detail: error.missingModule
            ? `The ${error.missingModule} package is unavailable in the active Python runtime.`
            : error.message,
        };
      }
      return {
        variant: "neutral",
        title: "Step did not run",
        detail: failedNodeId
          ? `Upstream step ${
            selectedNode.nodeLabelsById[failedNodeId] ?? "a step"
          } failed before this step could run.`
          : "An upstream step failed before this step could run.",
      };
    }
  }

  if (runStatus === "failed") {
    return {
      variant: "danger",
      title: "Step failed",
      detail: "The last run for this step failed.",
    };
  }

  if (runStatus === "blocked") {
    return {
      variant: "neutral",
      title: "Step did not run",
      detail: "An upstream step failed before this step could run.",
    };
  }

  if (runStatus === "blocked_globals") {
    return {
      variant: "neutral",
      title: "Blocked by Document Globals",
      detail: "Document Globals failed before this step could run.",
    };
  }

  if (runStatus === "completed") {
    return {
      variant: "success",
      title: "Step completed",
      detail: "This step ran successfully.",
    };
  }

  return {
    variant: "neutral",
    title: "No fresh run result",
    detail: "Run through this step to inspect its final variable values.",
  };
}

function DeleteNodeAction({
  selectedNode,
  disabled,
  onDeleteNode,
}: {
  selectedNode: NodeInspectorSelection;
  disabled: boolean;
  onDeleteNode: (nodeId: string) => void;
}) {
  return (
    <section>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={disabled}
        onClick={() => onDeleteNode(selectedNode.id)}
      >
        <Trash2 aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
        Delete node
      </button>
    </section>
  );
}

export function InspectorPanel({
  focused,
  onToggleFocus,
  themeMode,
  selectedNode,
  graph,
  selectedNodeExecutionState,
  selectedNodeRunStatus,
  graphExecutionState,
  isRunActive,
  readOnly,
  onNodeSelect,
  onCodeChange,
  onNodeNameChange,
  onNodeMetadataChange,
  onGlobalsCodeChange,
  onDeleteNode,
  onRunToNode,
  onSelectionClear,
  actionsBlocked = false,
  navigationRequest,
  pythonEditorError,
  onShowDocumentGlobals,
}: InspectorPanelProps) {
  const isSelectedNodeRunning = selectedNodeExecutionState?.status ===
    "running";
  const isNodeNameReadOnly = readOnly || !selectedNode?.editable;
  const isAnyRunBlockingNodeActions = isRunActive || isSelectedNodeRunning;
  const areNodeActionsDisabled = actionsBlocked || isRunActive ||
    isSelectedNodeRunning;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const handledNavigationRequestIdRef = useRef<number | null>(null);
  const [inspectorMode, setMode] = useState<NodeInspectorMode>(() =>
    readPreference("inspector-mode", "results") === "details"
      ? "details"
      : readPreference("inspector-mode", "results") === "code"
      ? "code"
      : "results"
  );
  const setInspectorMode = (mode: NodeInspectorMode) => {
    setMode(mode);
    savePreference("inspector-mode", mode);
  };
  const [graphInspectorMode, setGraphInspectorMode] = useState<
    GraphInspectorMode
  >("overview");
  const [selectedGraphOutputKey, setSelectedGraphOutputKey] = useState("");
  const [selectedContent, setSelectedContent] = useState("variables");
  const [nodeNameDraft, setNodeNameDraft] = useState(
    selectedNode?.displayName ?? "",
  );
  const [nodeNameError, setNodeNameError] = useState<string | null>(null);
  const [selectedVariableName, setSelectedVariableName] = useState(
    selectedNode?.routedOutputs[0] ?? selectedNode?.variables[0]?.name ?? "",
  );

  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0 });
    if (!selectedNode) setSelectedContent("variables");
  }, [selectedNode?.id]);

  useEffect(() => {
    if (
      !navigationRequest ||
      handledNavigationRequestIdRef.current === navigationRequest.requestId
    ) {
      return;
    }

    if (
      navigationRequest.target === "node_results" ||
      navigationRequest.target === "node_code"
    ) {
      if (selectedNode?.id !== navigationRequest.nodeId) {
        return;
      }
      handledNavigationRequestIdRef.current = navigationRequest.requestId;
      setInspectorMode(
        navigationRequest.target === "node_results" ? "results" : "code",
      );
      if (
        navigationRequest.target === "node_results" &&
        navigationRequest.variableName
      ) {
        setSelectedVariableName(navigationRequest.variableName);
        setSelectedContent("variables");
      }
      scrollContainerRef.current?.scrollTo({ top: 0 });
      return;
    }

    if (selectedNode) {
      return;
    }

    handledNavigationRequestIdRef.current = navigationRequest.requestId;
    setGraphInspectorMode(
      navigationRequest.target === "document_globals" ? "overview" : "results",
    );
    const frameId = requestAnimationFrame(() => {
      const target = scrollContainerRef.current?.querySelector(
        `[data-inspector-target="${navigationRequest.target}"]`,
      );
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(frameId);
  }, [navigationRequest, selectedNode]);

  useEffect(() => {
    if (!selectedNode && graphExecutionState?.status === "running") {
      setGraphInspectorMode("results");
    }
  }, [graphExecutionState?.status, selectedNode]);

  useEffect(() => {
    setNodeNameDraft(selectedNode?.displayName ?? "");
    setNodeNameError(null);
  }, [selectedNode?.id, selectedNode?.displayName]);

  useEffect(() => {
    setSelectedVariableName((current) => {
      if (
        selectedNode?.variables.some((variable) => variable.name === current)
      ) {
        return current;
      }
      return selectedNode?.routedOutputs[0] ??
        selectedNode?.variables.find((variable) =>
          selectedNode.variablePreviews[variable.name]?.image
        )?.name ?? selectedNode?.variables.find((variable) =>
          selectedNode.variablePreviews[variable.name]?.table
        )?.name ?? selectedNode?.variables[0]?.name ?? "";
    });
  }, [selectedNode]);

  const graphOptions = graphExecutionState?.status === "completed" &&
      graphExecutionState.response.ok
    ? graphOutputOptions(graphExecutionState.response, graph.nodeLabelsById)
    : [];
  const resolvedGraphKey = resolveGraphOutputSelection(
    selectedGraphOutputKey,
    graphOptions.map((option) => option.key),
  );
  const headerSummary = selectedNode
    ? getNodeRunSummary(
      selectedNode,
      selectedNodeExecutionState,
      selectedNodeRunStatus,
    )
    : null;

  return (
    <JsonPreviewThemeScope
      themeMode={themeMode}
      className="inspector-workspace relative flex h-full min-h-0 w-full flex-col bg-white dark:bg-zinc-900"
    >
      <div className="inspector-heading border-b border-zinc-200 px-5 py-2 dark:border-zinc-800">
        {selectedNode
          ? (
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-xl font-semibold">
                  {selectedNode.displayName}
                </h2>
                <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span
                    role="status"
                    title={headerSummary?.detail}
                    className={headerSummary?.variant === "success"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : ""}
                  >
                    {headerSummary?.title}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  className="inspector-focus"
                  type="button"
                  onClick={onToggleFocus}
                >
                  {focused ? "Show graph" : "Focus inspector"}
                </button>
                <button
                  type="button"
                  title="Run through step (Shift+Enter)"
                  className="inline-flex h-8 items-center gap-1.5 rounded bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
                  disabled={areNodeActionsDisabled}
                  onClick={() => onRunToNode(selectedNode.id)}
                >
                  <Play
                    aria-hidden="true"
                    className="h-4 w-4"
                    strokeWidth={2.25}
                  />
                  {isAnyRunBlockingNodeActions ? "Running…" : "Run"}
                </button>
                <RunMenu
                  disabled={areNodeActionsDisabled}
                  onTrace={() => onRunToNode(selectedNode.id, { trace: true })}
                />
                <button
                  type="button"
                  aria-label="Show graph overview"
                  className="flex h-8 w-8 items-center justify-center rounded border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  onClick={onSelectionClear}
                >
                  <X
                    aria-hidden="true"
                    className="h-4 w-4"
                    strokeWidth={2.25}
                  />
                </button>
              </div>
            </div>
          )
          : (
            <div className="flex min-h-8 items-center justify-between">
              <p className="text-xs font-medium uppercase text-zinc-500 dark:text-zinc-400">
                Graph overview
                {graphExecutionState?.status === "completed" &&
                  graphExecutionState.freshness === "fresh" &&
                  graphExecutionState.response.ok && (
                  <span className="ml-3 normal-case text-emerald-600 dark:text-emerald-400">
                    Fresh
                  </span>
                )}
              </p>
              <button
                className="inspector-focus"
                type="button"
                onClick={onToggleFocus}
              >
                {focused ? "Show graph" : "Focus inspector"}
              </button>
            </div>
          )}
      </div>

      {selectedNode
        ? (
          <>
            <div className="min-h-0 flex-1 overflow-hidden">
              <NodeInspector
                nameEditor={
                  <section>
                    <label className="text-xs text-zinc-500">Step name</label>
                    {" "}
                    <input
                      className={[
                        "w-full truncate rounded border bg-transparent px-0 py-0.5 text-xl font-semibold text-zinc-950 outline-none placeholder:text-zinc-400 focus:bg-white focus:px-2 dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:focus:bg-zinc-800",
                        nodeNameError
                          ? "border-red-300 focus:border-red-400 dark:border-red-800 dark:focus:border-red-700"
                          : "border-transparent focus:border-zinc-300 dark:focus:border-zinc-700",
                      ].join(" ")}
                      value={nodeNameDraft}
                      placeholder={selectedNode.displayName}
                      aria-label="Step name"
                      readOnly={isNodeNameReadOnly}
                      onChange={(event) => {
                        if (isNodeNameReadOnly) {
                          return;
                        }
                        const nextName = event.currentTarget.value;
                        setNodeNameDraft(nextName);
                        const result = onNodeNameChange(
                          selectedNode.id,
                          nextName,
                        );
                        setNodeNameError(result.ok ? null : result.message);
                      }}
                    />
                    {nodeNameError && (
                      <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-400">
                        {nodeNameError}
                      </p>
                    )}
                  </section>
                }
                themeMode={themeMode}
                selectedNode={selectedNode}
                executionState={selectedNodeExecutionState}
                runStatus={selectedNodeRunStatus}
                mode={inspectorMode}
                onModeChange={setInspectorMode}
                readOnly={readOnly}
                actionsDisabled={areNodeActionsDisabled}
                onCodeChange={onCodeChange}
                onNodeMetadataChange={onNodeMetadataChange}
                onNodeSelect={onNodeSelect}
                onRunToNode={onRunToNode}
                onDeleteNode={onDeleteNode}
                onShowDocumentGlobals={onShowDocumentGlobals}
                onOpenCode={() => setInspectorMode("code")}
                pythonEditorError={pythonEditorError}
                errorFocusRequestId={navigationRequest?.target === "node_code"
                  ? navigationRequest.requestId
                  : undefined}
                selectedVariableName={selectedVariableName}
                selectedContent={selectedContent}
                onContentSelect={setSelectedContent}
                onVariableSelect={setSelectedVariableName}
              />
            </div>
          </>
        )
        : (
          <div className="inspector-body min-h-0 flex-1">
            <nav
              className="inspector-nav"
              aria-label="Graph inspector navigation"
            >
              <button
                type="button"
                aria-pressed={graphInspectorMode === "overview"}
                onClick={() => setGraphInspectorMode("overview")}
              >
                Overview
              </button>
              <button
                type="button"
                aria-pressed={graphInspectorMode === "results"}
                onClick={() => setGraphInspectorMode("results")}
              >
                Results
              </button>
              {graphInspectorMode === "results" && (
                <div className="result-nav-children">
                  {graphOptions.map((option) => (
                    <button
                      type="button"
                      key={option.key}
                      aria-pressed={resolvedGraphKey === option.key}
                      className="result-nav-item"
                      title={`${option.name} · ${option.nodeLabel}`}
                      onClick={() => setSelectedGraphOutputKey(option.key)}
                    >
                      <span className="block truncate font-mono">
                        {option.name}
                      </span>
                      {option.kind === "display" && (
                        <Presentation
                          aria-hidden="true"
                          className="h-3 w-3 shrink-0 opacity-60"
                        />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </nav>
            <div
              ref={scrollContainerRef}
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-5 py-3"
            >
              <div className="min-h-0 flex-1">
                <GraphInspector
                  themeMode={themeMode}
                  graph={graph}
                  graphExecutionState={graphExecutionState}
                  mode={graphInspectorMode}
                  readOnly={readOnly}
                  onNodeSelect={onNodeSelect}
                  onGlobalsCodeChange={onGlobalsCodeChange}
                  onModeChange={setGraphInspectorMode}
                  selectedOutputKey={selectedGraphOutputKey}
                  onSelectedOutputKeyChange={setSelectedGraphOutputKey}
                  pythonEditorError={pythonEditorError}
                  errorFocusRequestId={navigationRequest?.target ===
                      "document_globals"
                    ? navigationRequest.requestId
                    : undefined}
                />
              </div>
            </div>
          </div>
        )}
    </JsonPreviewThemeScope>
  );
}
