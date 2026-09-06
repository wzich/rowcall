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
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { AlertTriangle, Maximize2, Play, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { NodeNameChangeResult, ThemeMode } from "../App.tsx";
import type { PythonEditorErrorTarget } from "../documentSaveError.ts";
import { formatPythonType } from "../graph/pythonTypeLabels.ts";
import type { NodeRunVisualStatus } from "../graph/toReactFlow.ts";
import { JsonPreview, JsonPreviewThemeScope } from "./JsonPreview.tsx";
import { ResultTable } from "./ResultTable.tsx";
import { resolveGraphOutputSelection } from "./graphOutputSelection.ts";

type ExecutionTraceStep = NonNullable<ExecutionResponse["trace"]>[number];

const inspectorMinWidth = 520;
const inspectorMaxWidth = 900;
const minCanvasWidth = 360;

function clampInspectorWidth(width: number) {
  if (typeof window === "undefined") {
    return Math.min(inspectorMaxWidth, Math.max(inspectorMinWidth, width));
  }

  const viewportMaxWidth = Math.max(
    inspectorMinWidth,
    window.innerWidth - minCanvasWidth,
  );
  return Math.min(
    inspectorMaxWidth,
    viewportMaxWidth,
    Math.max(inspectorMinWidth, width),
  );
}

function getDefaultInspectorWidth() {
  if (typeof window === "undefined") {
    return 640;
  }

  return clampInspectorWidth(Math.min(640, window.innerWidth * 0.48));
}

export type NodeInspectorBadge = "Source" | "Sink" | "Isolated";

export type NodeInspectorSelection = {
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
  upstreamDependencies: string[];
  downstreamDependencies: string[];
  nodeLabelsById: Record<string, string>;
  badges: NodeInspectorBadge[];
};

type NodeInspectorMode = "code" | "results";
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
  themeMode: ThemeMode;
  selectedNode: NodeInspectorSelection | null;
  graph: GraphInspectorModel;
  selectedNodeExecutionState: ExecutionDisplayState | null;
  selectedNodeRunStatus: NodeRunVisualStatus;
  graphExecutionState: GraphExecutionDisplayState | null;
  isRunActive: boolean;
  traceEnabled: boolean;
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
  onTraceEnabledChange: (value: boolean) => void;
  onDeleteNode?: (nodeId: string) => void;
  onRunToNode: (nodeId: string) => void;
  onSelectionClear: () => void;
  actionsBlocked?: boolean;
  navigationRequest?: InspectorNavigationRequest | null;
  pythonEditorError?: PythonEditorErrorTarget;
  onShowDocumentGlobals?: () => void;
};

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
                  className="border-b border-r border-zinc-200 px-2 py-1.5 font-medium last:border-r-0 dark:border-zinc-700"
                >
                  <div className="max-w-44 truncate text-zinc-800 dark:text-zinc-100">
                    {column.name}
                  </div>
                  {column.dtype && (
                    <div className="max-w-44 truncate font-mono text-[10px] font-normal text-zinc-500 dark:text-zinc-400">
                      {column.dtype}
                    </div>
                  )}
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
          Showing {table.rows.length} of {table.rowCount} rows and{" "}
          {table.columns.length} of {table.columnCount} columns.
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
        <p className="border-t border-zinc-200 bg-zinc-50 px-2 py-1.5 font-mono text-[10px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
          {image.width} × {image.height} px · {formatImageSize(image.sizeBytes)}
        </p>
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
            <p className="mt-0.5 font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
              {image.width} × {image.height} px ·{" "}
              {formatImageSize(image.sizeBytes)}
            </p>
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

function formatImageSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  return `${(sizeBytes / 1024).toFixed(1)} KiB`;
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

function FlatPreview({
  preview,
  metadataSuffix,
  interactiveTable,
  imageExpandable = false,
}: {
  preview: ValuePreview;
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
    <div className="pt-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">
        <span title={preview.type}>{typeLabel}</span>
        {preview.table && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {preview.table.rowCount} rows × {preview.table.columnCount}{" "}
              columns
            </span>
          </>
        )}
        {preview.image && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {preview.image.width} × {preview.image.height} px
            </span>
          </>
        )}
        {metadataSuffix && (
          <>
            <span aria-hidden="true">·</span>
            {metadataSuffix}
          </>
        )}
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
          "mt-3 min-h-52 flex-1 overflow-hidden rounded border dark:border-zinc-700 [&_.cm-content]:pb-6 [&_.cm-editor]:h-full [&_.cm-editor]:text-sm [&_.cm-scroller]:font-mono",
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
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
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
            <GraphOutputTabs
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

function GraphOutputTabs({
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
  const options = useMemo<GraphOutputOption[]>(
    () => {
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
    },
    [nodeLabelsById, response],
  );
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const option of options) {
      counts.set(option.name, (counts.get(option.name) ?? 0) + 1);
    }
    return new Set(
      [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([name]) => name),
    );
  }, [options]);
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
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">
          Graph results
        </h3>
        {freshness === "fresh" && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Fresh
          </span>
        )}
      </div>
      <div className="mt-3 flex gap-4 overflow-x-auto border-b border-zinc-200 pb-2 [scrollbar-gutter:stable] dark:border-zinc-700">
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            className={[
              "shrink-0 border-b-2 px-0.5 pb-2 font-mono text-xs",
              option.key === selected.key
                ? "border-blue-600 font-semibold text-zinc-950 dark:border-blue-400 dark:text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
            ].join(" ")}
            onClick={() => onSelectedKeyChange(option.key)}
          >
            {duplicateNames.has(option.name)
              ? `${option.nodeLabel} · ${option.name}`
              : option.name}
          </button>
        ))}
      </div>
      <div className="py-3">
        <FlatPreview
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
  themeMode,
  selectedNode,
  executionState,
  runStatus,
  mode,
  readOnly,
  actionsDisabled,
  onCodeChange,
  onNodeMetadataChange,
  onNodeSelect,
  onRunToNode,
  traceEnabled,
  onTraceEnabledChange,
  onDeleteNode,
  onShowDocumentGlobals,
  onOpenCode,
  pythonEditorError,
  errorFocusRequestId,
  selectedVariableName,
  onVariableSelect,
}: {
  themeMode: ThemeMode;
  selectedNode: NodeInspectorSelection;
  executionState: ExecutionDisplayState | null;
  runStatus: NodeRunVisualStatus;
  mode: NodeInspectorMode;
  readOnly: boolean;
  actionsDisabled: boolean;
  onCodeChange: (nodeId: string, code: string) => void;
  onNodeMetadataChange: (
    nodeId: string,
    metadata: { description?: string },
  ) => void;
  onNodeSelect: (nodeId: string) => void;
  onRunToNode: (nodeId: string) => void;
  traceEnabled: boolean;
  onTraceEnabledChange: (value: boolean) => void;
  onDeleteNode?: (nodeId: string) => void;
  onShowDocumentGlobals?: () => void;
  onOpenCode: () => void;
  pythonEditorError?: PythonEditorErrorTarget;
  errorFocusRequestId?: number;
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
  if (mode === "results") {
    return (
      <NodeResults
        selectedNode={selectedNode}
        executionState={executionState}
        runStatus={runStatus}
        runSummary={runSummary}
        onViewError={isBlockedByDocumentGlobals
          ? onShowDocumentGlobals
          : undefined}
        onOpenCode={runStatus === "failed" ? onOpenCode : undefined}
        traceEnabled={traceEnabled}
        onTraceEnabledChange={onTraceEnabledChange}
        selectedVariableName={selectedVariableName}
        onVariableSelect={onVariableSelect}
      />
    );
  }

  return (
    <NodeCode
      themeMode={themeMode}
      selectedNode={selectedNode}
      metadataReadOnly={metadataReadOnly}
      codeReadOnly={codeReadOnly}
      actionsDisabled={actionsDisabled}
      extensions={extensions}
      onCodeChange={onCodeChange}
      onNodeMetadataChange={onNodeMetadataChange}
      onDeleteNode={onDeleteNode}
      pythonEditorError={pythonEditorError}
      errorFocusRequestId={errorFocusRequestId}
    />
  );
}

function NodeCode({
  themeMode,
  selectedNode,
  metadataReadOnly,
  codeReadOnly,
  actionsDisabled,
  extensions,
  onCodeChange,
  onNodeMetadataChange,
  onDeleteNode,
  pythonEditorError,
  errorFocusRequestId,
}: {
  themeMode: ThemeMode;
  selectedNode: NodeInspectorSelection;
  metadataReadOnly: boolean;
  codeReadOnly: boolean;
  actionsDisabled: boolean;
  extensions: Array<
    ReturnType<typeof python> | ReturnType<typeof keymap.of>
  >;
  onCodeChange: (nodeId: string, code: string) => void;
  onNodeMetadataChange: (
    nodeId: string,
    metadata: { description?: string },
  ) => void;
  onDeleteNode?: (nodeId: string) => void;
  pythonEditorError?: PythonEditorErrorTarget;
  errorFocusRequestId?: number;
}) {
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
      <section className="flex min-h-60 flex-1 flex-col border-b border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-800">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-zinc-500 dark:text-zinc-400">
            Code
          </h3>
          <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
            Shift ↵ run
          </span>
          {pythonEditorError?.editor === "node" &&
            pythonEditorError.nodeId === selectedNode.id && (
            <span className="ml-auto font-mono text-[10px] font-medium text-red-700 dark:text-red-300">
              Line {pythonEditorError.line}, column {pythonEditorError.column}:
              {"  "}{pythonEditorError.message}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden bg-zinc-50 dark:bg-zinc-950 [&_.cm-editor]:h-full [&_.cm-editor]:text-xs [&_.cm-scroller]:font-mono">
          <div data-shortcut-scope="editor" className="h-full">
            <CodeMirror
              className="inspector-code-editor h-full"
              value={selectedNode.code}
              height="100%"
              extensions={extensions}
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
      <div className="shrink-0 space-y-5 px-5 py-5">
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
  selectedNode,
  executionState,
  runStatus,
  runSummary,
  onViewError,
  onOpenCode,
  traceEnabled,
  onTraceEnabledChange,
  selectedVariableName,
  onVariableSelect,
}: {
  selectedNode: NodeInspectorSelection;
  executionState: ExecutionDisplayState | null;
  runStatus: NodeRunVisualStatus;
  runSummary: NodeRunSummary;
  onViewError?: () => void;
  onOpenCode?: () => void;
  traceEnabled: boolean;
  onTraceEnabledChange: (value: boolean) => void;
  selectedVariableName: string;
  onVariableSelect: (name: string) => void;
}) {
  const baseResult = getNodeResult(executionState, selectedNode.id);
  const latestFailure = executionState?.status === "completed" &&
      executionState.freshness === "failed_run"
    ? executionState.latestFailure
    : undefined;
  const latestAttemptResult = latestFailure?.resultsByNode[selectedNode.id] ??
    baseResult;
  const displays = latestAttemptResult?.displays ?? [];
  const stdout = latestAttemptResult?.stdout ?? "";
  const stderr = latestAttemptResult?.stderr ?? "";
  const warnings = latestAttemptResult?.warnings ?? [];
  const selectedVariable =
    selectedNode.variables.find((variable) =>
      variable.name === selectedVariableName
    ) ?? selectedNode.variables[0] ?? null;
  const selectedPreview = selectedVariable
    ? selectedNode.variablePreviews[selectedVariable.name] ?? null
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
  const valuesAreStale = runStatus === "stale" ||
    (executionState?.status === "completed" &&
      executionState.freshness !== "fresh");

  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      <div className="space-y-4">
        <NodeRunBanner
          summary={runSummary}
          onViewError={onViewError}
          onOpenCode={onOpenCode}
        />
        {executionState?.status === "completed" &&
          executionState.freshness === "failed_run" && (
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="text-sm font-medium">Showing previous values</p>
            <p className="mt-1 text-xs">
              The latest attempt failed. No partial variable values were kept.
            </p>
          </div>
        )}

        <DisplayResults displays={displays} />

        <VariableResults
          variables={selectedNode.variables}
          routedOutputs={selectedNode.routedOutputs}
          previews={selectedNode.variablePreviews}
          selectedName={selectedVariable?.name ?? ""}
          runStatus={runStatus}
          valuesAreStale={valuesAreStale}
          onSelect={onVariableSelect}
        >
          {selectedVariable && selectedPreview
            ? (
              <FlatPreview
                preview={{ ...selectedPreview, name: selectedVariable.name }}
                metadataSuffix={selectedNode.routedOutputs.includes(
                    selectedVariable.name,
                  )
                  ? <span>routed output</span>
                  : <span>bounded preview</span>}
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
        </VariableResults>

        <div className="space-y-4">
          <TextOutputBlock title="Stdout" value={stdout} />
          <WarningList warnings={warnings} />
          <TextOutputBlock title="Stderr" value={stderr} variant="danger" />
        </div>

        {traceStep && (
          <NodeTraceResult
            step={traceStep}
            label={selectedNode.displayName}
            nodeLabelsById={selectedNode.nodeLabelsById}
          />
        )}
        <TraceToggle
          traceEnabled={traceEnabled}
          onTraceEnabledChange={onTraceEnabledChange}
        />
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

function VariableResults({
  variables,
  routedOutputs,
  previews,
  selectedName,
  runStatus,
  valuesAreStale,
  onSelect,
  children,
}: {
  variables: NodeInspectorSelection["variables"];
  routedOutputs: string[];
  previews: Record<string, ValuePreview>;
  selectedName: string;
  runStatus: NodeRunVisualStatus;
  valuesAreStale: boolean;
  onSelect: (name: string) => void;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">
        Variables
      </h3>
      {variables.length === 0
        ? (
          <p className="mt-2 rounded border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            This step has no variables to inspect.
          </p>
        )
        : (
          <div className="mt-2 overflow-hidden rounded border border-zinc-200 dark:border-zinc-700">
            <div className="grid min-h-64 grid-cols-[minmax(140px,0.36fr)_minmax(0,1fr)]">
              <div className="border-r border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
                {variables.map((variable) => {
                  const preview = previews[variable.name];
                  const state = getVariablePreviewState(
                    variable.source,
                    runStatus,
                    Boolean(preview),
                    valuesAreStale,
                  );
                  const selected = variable.name === selectedName;
                  return (
                    <button
                      key={variable.name}
                      type="button"
                      title={`${variable.name}: ${state.label}`}
                      className={[
                        "flex w-full items-center gap-2 border-b border-zinc-200 px-3 py-2 text-left font-mono text-xs last:border-b-0 dark:border-zinc-700",
                        selected
                          ? "bg-white font-semibold text-zinc-950 dark:bg-zinc-800 dark:text-zinc-100"
                          : "text-zinc-600 hover:bg-white dark:text-zinc-300 dark:hover:bg-zinc-800/70",
                      ].join(" ")}
                      onClick={() => onSelect(variable.name)}
                    >
                      <span
                        aria-hidden="true"
                        className={`h-2 w-2 shrink-0 rounded-full ${state.dotClassName}`}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {variable.name}
                      </span>
                      {routedOutputs.includes(variable.name) && (
                        <span className="rounded bg-blue-100 px-1 py-0.5 font-sans text-[9px] font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                          output
                        </span>
                      )}
                      <span className="sr-only">{state.label}</span>
                    </button>
                  );
                })}
              </div>
              <div
                className={valuesAreStale
                  ? "min-w-0 p-4 opacity-65"
                  : "min-w-0 p-4"}
              >
                {children}
              </div>
            </div>
          </div>
        )}
    </section>
  );
}

function getVariablePreviewState(
  source: NodeInspectorSelection["variables"][number]["source"],
  runStatus: NodeRunVisualStatus,
  hasPreview: boolean,
  valuesAreStale: boolean,
): { label: string; dotClassName: string } {
  if (source === "missing") {
    return { label: "Missing from code", dotClassName: "bg-red-500" };
  }
  if (runStatus === "running" || runStatus === "queued") {
    return {
      label: runStatus === "running" ? "Running" : "Queued",
      dotClassName: "bg-blue-500",
    };
  }
  if (valuesAreStale) {
    return { label: "Stale", dotClassName: "bg-amber-500" };
  }
  if (hasPreview) {
    return { label: "Fresh", dotClassName: "bg-emerald-500" };
  }
  return { label: "Unavailable", dotClassName: "bg-zinc-300" };
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
  summary,
  inputStatus,
  onViewError,
  onOpenCode,
}: {
  summary: NodeRunSummary;
  inputStatus?: string;
  onViewError?: () => void;
  onOpenCode?: () => void;
}) {
  const variant = summary.variant;
  const styles = {
    neutral: "border-zinc-200 bg-white text-zinc-700",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-red-200 bg-red-50 text-red-900",
    info: "border-blue-200 bg-blue-50 text-blue-900",
  }[variant];

  return (
    <div className={`rounded border px-3 py-2 text-sm ${styles}`}>
      <div className="flex items-start gap-2">
        {(variant === "warning" || variant === "danger") && (
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
    <section className="border-t border-zinc-200 pt-4">
      <button
        type="button"
        className="inline-flex w-full items-center justify-center gap-2 rounded border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-300"
        disabled={disabled}
        onClick={() => onDeleteNode(selectedNode.id)}
      >
        <Trash2 aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
        Delete node
      </button>
    </section>
  );
}

function GraphInspectorTabs({
  mode,
  onModeChange,
}: {
  mode: GraphInspectorMode;
  onModeChange: (mode: GraphInspectorMode) => void;
}) {
  const tabs: Array<{ id: GraphInspectorMode; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "results", label: "Results" },
  ];

  return (
    <div className="flex h-11 shrink-0 items-end gap-6 border-b border-zinc-200 px-5 dark:border-zinc-800">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`border-b-2 pb-2.5 text-sm font-medium ${
            tab.id === mode
              ? "border-blue-600 text-zinc-950 dark:border-blue-400 dark:text-zinc-100"
              : "border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          }`}
          onClick={() => onModeChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function NodeInspectorTabs({
  mode,
  runStatus,
  onModeChange,
}: {
  mode: NodeInspectorMode;
  runStatus: NodeRunVisualStatus;
  onModeChange: (mode: NodeInspectorMode) => void;
}) {
  const state = getPreviewState(runStatus, runStatus === "completed");
  const tabs: Array<{ id: NodeInspectorMode; label: string }> = [
    { id: "code", label: "Code" },
    { id: "results", label: "Results" },
  ];

  return (
    <div className="flex h-11 shrink-0 items-end gap-6 border-b border-zinc-200 px-5 dark:border-zinc-800">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`border-b-2 pb-2.5 text-sm font-medium ${
            tab.id === mode
              ? "border-blue-600 text-zinc-950 dark:border-blue-400 dark:text-zinc-100"
              : "border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          }`}
          onClick={() => onModeChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
      <div className="flex-1" />
      {state && state.label !== "Fresh" && (
        <span
          className={`mb-3 inline-flex items-center gap-1.5 text-[11px] font-medium ${state.className}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${state.dotClassName}`} />
          {state.label}
        </span>
      )}
    </div>
  );
}

export function InspectorPanel({
  themeMode,
  selectedNode,
  graph,
  selectedNodeExecutionState,
  selectedNodeRunStatus,
  graphExecutionState,
  isRunActive,
  traceEnabled,
  readOnly,
  onNodeSelect,
  onCodeChange,
  onNodeNameChange,
  onNodeMetadataChange,
  onGlobalsCodeChange,
  onTraceEnabledChange,
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
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(0);
  const [inspectorWidth, setInspectorWidth] = useState(
    getDefaultInspectorWidth,
  );
  const [isResizing, setIsResizing] = useState(false);
  const [inspectorMode, setInspectorMode] = useState<NodeInspectorMode>(
    "code",
  );
  const [graphInspectorMode, setGraphInspectorMode] = useState<
    GraphInspectorMode
  >("overview");
  const [selectedGraphOutputKey, setSelectedGraphOutputKey] = useState("");
  const [nodeNameDraft, setNodeNameDraft] = useState(
    selectedNode?.displayName ?? "",
  );
  const [nodeNameError, setNodeNameError] = useState<string | null>(null);
  const [selectedVariableName, setSelectedVariableName] = useState(
    selectedNode?.variables[0]?.name ?? "",
  );

  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0 });
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
      return selectedNode?.variables.find((variable) =>
        selectedNode.variablePreviews[variable.name]?.image
      )?.name ?? selectedNode?.variables.find((variable) =>
        selectedNode.variablePreviews[variable.name]?.table
      )?.name ?? selectedNode?.variables[0]?.name ?? "";
    });
  }, [selectedNode]);

  useEffect(() => {
    const handleWindowResize = () => {
      setInspectorWidth((currentWidth) => clampInspectorWidth(currentWidth));
    };

    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dragDelta = dragStartXRef.current - event.clientX;
      setInspectorWidth(
        clampInspectorWidth(dragStartWidthRef.current + dragDelta),
      );
    };
    const stopResizing = () => setIsResizing(false);

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [isResizing]);

  return (
    <JsonPreviewThemeScope
      themeMode={themeMode}
      className="relative flex h-full shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      style={{ width: inspectorWidth }}
    >
      <button
        type="button"
        aria-label="Resize inspector"
        aria-orientation="vertical"
        className="absolute inset-y-0 left-0 z-10 w-2 -translate-x-1 cursor-col-resize touch-none border-l border-transparent transition-colors hover:border-zinc-400 focus:border-zinc-500 focus:outline-none dark:hover:border-zinc-500 dark:focus:border-zinc-400"
        onPointerDown={(event) => {
          event.preventDefault();
          dragStartXRef.current = event.clientX;
          dragStartWidthRef.current = inspectorWidth;
          setIsResizing(true);
        }}
      />
      <div className="border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
        {selectedNode
          ? (
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <input
                  className={[
                    "w-full truncate rounded border bg-transparent px-0 py-0.5 text-xl font-semibold text-zinc-950 outline-none placeholder:text-zinc-400 focus:bg-white focus:px-2 dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:focus:bg-zinc-800",
                    nodeNameError
                      ? "border-red-300 focus:border-red-400 dark:border-red-800 dark:focus:border-red-700"
                      : "border-transparent focus:border-zinc-300 dark:focus:border-zinc-700",
                  ].join(" ")}
                  value={nodeNameDraft}
                  placeholder={selectedNode.displayName}
                  readOnly={isNodeNameReadOnly || inspectorMode !== "code"}
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
                <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span
                    className="truncate font-mono text-zinc-400 dark:text-zinc-500"
                    title={selectedNode.functionName ?? ""}
                  >
                    {selectedNode.functionName ?? "custom Python"}
                  </span>
                  <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-zinc-400" />
                  <span className="shrink-0">Python</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
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
            <div className="flex min-h-8 items-center">
              <p className="text-xs font-medium uppercase text-zinc-500 dark:text-zinc-400">
                Graph overview
              </p>
            </div>
          )}
      </div>

      {selectedNode
        ? (
          <>
            <NodeInspectorTabs
              mode={inspectorMode}
              runStatus={selectedNodeRunStatus}
              onModeChange={setInspectorMode}
            />
            <div className="min-h-0 flex-1 overflow-auto">
              <NodeInspector
                themeMode={themeMode}
                selectedNode={selectedNode}
                executionState={selectedNodeExecutionState}
                runStatus={selectedNodeRunStatus}
                mode={inspectorMode}
                readOnly={readOnly}
                actionsDisabled={areNodeActionsDisabled}
                onCodeChange={onCodeChange}
                onNodeMetadataChange={onNodeMetadataChange}
                onNodeSelect={onNodeSelect}
                onRunToNode={onRunToNode}
                traceEnabled={traceEnabled}
                onTraceEnabledChange={onTraceEnabledChange}
                onDeleteNode={onDeleteNode}
                onShowDocumentGlobals={onShowDocumentGlobals}
                onOpenCode={() => setInspectorMode("code")}
                pythonEditorError={pythonEditorError}
                errorFocusRequestId={navigationRequest?.target === "node_code"
                  ? navigationRequest.requestId
                  : undefined}
                selectedVariableName={selectedVariableName}
                onVariableSelect={setSelectedVariableName}
              />
            </div>
          </>
        )
        : (
          <>
            <GraphInspectorTabs
              mode={graphInspectorMode}
              onModeChange={setGraphInspectorMode}
            />
            <div
              ref={scrollContainerRef}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4"
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
              {graphInspectorMode === "results" && (
                <div className="mt-4">
                  <TraceToggle
                    traceEnabled={traceEnabled}
                    onTraceEnabledChange={onTraceEnabledChange}
                  />
                </div>
              )}
            </div>
          </>
        )}
    </JsonPreviewThemeScope>
  );
}
