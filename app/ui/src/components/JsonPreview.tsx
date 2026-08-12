import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { Check, Copy } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ComponentProps } from "react";
import { JsonView } from "react-json-view-lite";
import type { ValuePreview } from "../../../../types.ts";
import type { ThemeMode } from "../App.tsx";
import { formatPythonType } from "../graph/pythonTypeLabels.ts";
import {
  copyJsonText,
  formatJsonValue,
  isJsonContainer,
  persistJsonPreviewMode,
  readJsonPreviewMode,
  shouldExpandJsonNode,
} from "./jsonPreviewState.ts";
import type { JsonPreviewMode } from "./jsonPreviewState.ts";

const JsonPreviewThemeContext = createContext<ThemeMode>("light");
const jsonLanguage = json();

const jsonTreeStyles = {
  container: "rowcall-json-tree",
  basicChildStyle: "rowcall-json-tree-item",
  childFieldsContainer: "rowcall-json-tree-children",
  label: "rowcall-json-tree-label",
  clickableLabel: "rowcall-json-tree-label rowcall-json-tree-clickable-label",
  nullValue: "rowcall-json-tree-null",
  undefinedValue: "rowcall-json-tree-null",
  numberValue: "rowcall-json-tree-number",
  stringValue: "rowcall-json-tree-string",
  booleanValue: "rowcall-json-tree-boolean",
  otherValue: "rowcall-json-tree-other",
  punctuation: "rowcall-json-tree-punctuation",
  expandIcon: "rowcall-json-tree-expander rowcall-json-tree-expander-collapsed",
  collapseIcon:
    "rowcall-json-tree-expander rowcall-json-tree-expander-expanded",
  collapsedContent: "rowcall-json-tree-collapsed-content",
  quotesForFieldNames: true,
  stringifyStringValues: true,
  ariaLables: {
    collapseJson: "Collapse JSON value",
    expandJson: "Expand JSON value",
  },
};

export function JsonPreviewThemeScope({
  themeMode,
  children,
  ...asideProps
}: { themeMode: ThemeMode } & ComponentProps<"aside">) {
  return (
    <JsonPreviewThemeContext.Provider value={themeMode}>
      <aside {...asideProps}>{children}</aside>
    </JsonPreviewThemeContext.Provider>
  );
}

type JsonPreviewVariant = "full" | "compact";

export function JsonPreview({
  preview,
  variant = "full",
}: {
  preview: ValuePreview;
  variant?: JsonPreviewVariant;
}) {
  if (!isJsonContainer(preview.jsonValue)) {
    return (
      <pre
        className={[
          "whitespace-pre-wrap break-words font-mono text-xs leading-5 text-zinc-800 dark:text-zinc-200",
          variant === "compact" ? "p-4" : "mt-2 max-h-40 overflow-auto",
        ].join(" ")}
        aria-label="Python representation"
      >
        {preview.repr}
      </pre>
    );
  }

  return (
    <StructuredJsonPreview
      value={preview.jsonValue}
      name={preview.name}
      type={preview.type}
      variant={variant}
    />
  );
}

function StructuredJsonPreview({
  value,
  name,
  type,
  variant,
}: {
  value: Record<string, unknown> | unknown[];
  name: string;
  type: string;
  variant: JsonPreviewVariant;
}) {
  const themeMode = useContext(JsonPreviewThemeContext);
  const [mode, setMode] = useState<JsonPreviewMode>(readJsonPreviewMode);
  const [copyState, setCopyState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rawJson = formatJsonValue(value);
  const shouldExpandNode = useCallback(
    (level: number, nodeValue: unknown) =>
      shouldExpandJsonNode(level, nodeValue, value),
    [value],
  );
  const summary = Array.isArray(value)
    ? `${value.length} ${value.length === 1 ? "item" : "items"}`
    : `${Object.keys(value).length} ${
      Object.keys(value).length === 1 ? "key" : "keys"
    }`;
  const compactSummary = `${summary} · ${formatPythonType(type)}`;

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const selectMode = (nextMode: JsonPreviewMode) => {
    setMode(nextMode);
    persistJsonPreviewMode(nextMode);
  };

  const copyValue = async () => {
    if (copyResetTimerRef.current !== null) {
      clearTimeout(copyResetTimerRef.current);
    }
    try {
      await copyJsonText(rawJson);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    copyResetTimerRef.current = setTimeout(() => setCopyState("idle"), 1800);
  };

  return (
    <div className={variant === "full" ? "mt-2" : ""}>
      <div
        className={[
          "flex flex-wrap items-center justify-between gap-2",
          variant === "compact"
            ? "border-b border-zinc-200 px-4 py-2 dark:border-zinc-800"
            : "mb-2",
        ].join(" ")}
      >
        <div className="flex items-center gap-2">
          {variant === "compact" && (
            <span className="whitespace-nowrap text-[11px] text-zinc-400 dark:text-zinc-500">
              {compactSummary}
            </span>
          )}
          <div
            role="group"
            aria-label="JSON view mode"
            className="inline-flex rounded border border-zinc-200 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-900"
          >
            {(["tree", "raw"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                className={[
                  "rounded px-2 py-1 text-[11px] font-medium capitalize",
                  mode === option
                    ? "bg-zinc-100 text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
                ].join(" ")}
                onClick={() => selectMode(option)}
              >
                {option}
              </button>
            ))}
          </div>
          {variant === "full" && (
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
              {summary}
            </span>
          )}
        </div>
        <button
          type="button"
          className={[
            "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium",
            copyState === "failed"
              ? "text-red-700 dark:text-red-300"
              : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200",
          ].join(" ")}
          aria-label={`Copy ${name} as JSON`}
          onClick={copyValue}
        >
          {copyState === "copied"
            ? <Check aria-hidden="true" className="h-3.5 w-3.5" />
            : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
            ? "Copy failed"
            : variant === "compact"
            ? "Copy"
            : "Copy JSON"}
        </button>
      </div>

      {mode === "tree"
        ? (
          <div
            className={[
              variant === "full"
                ? "max-h-80 overflow-auto rounded border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-950"
                : "px-4 py-3",
            ].join(" ")}
          >
            <JsonView
              data={value}
              aria-label={`${name} JSON tree`}
              clickToExpandNode
              shouldExpandNode={shouldExpandNode}
              style={jsonTreeStyles}
            />
          </div>
        )
        : (
          <div
            className={[
              "bg-white dark:bg-zinc-950 [&_.cm-editor]:text-xs [&_.cm-scroller]:font-mono",
              variant === "full"
                ? "max-h-80 overflow-auto rounded border border-zinc-200 dark:border-zinc-700"
                : "",
            ].join(" ")}
          >
            <CodeMirror
              value={rawJson}
              extensions={[jsonLanguage, EditorView.lineWrapping]}
              readOnly
              editable={false}
              basicSetup={{
                autocompletion: false,
                closeBrackets: false,
                foldGutter: true,
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
                lineNumbers: true,
              }}
              theme={themeMode}
            />
          </div>
        )}
    </div>
  );
}
