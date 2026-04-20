import { python } from "@codemirror/lang-python";
import CodeMirror from "@uiw/react-codemirror";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { useMemo } from "react";
import type { PythonFlowNode } from "../graph/toReactFlow.ts";

export function PythonNode({ data, selected }: NodeProps<PythonFlowNode>) {
  const extensions = useMemo(() => [python()], []);
  const outputs = data.outputs.length > 0 ? data.outputs.join(", ") : "none";

  return (
    <article
      className={[
        "w-[360px] rounded-lg border bg-white shadow-sm",
        selected ? "border-zinc-900" : "border-zinc-300",
      ].join(" ")}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="h-3 w-3 border-2 border-white bg-zinc-500"
      />
      <div className="cursor-grab border-b border-zinc-200 px-3 py-2 active:cursor-grabbing">
        <div className="flex items-center justify-between gap-3">
          <h2 className="truncate text-sm font-semibold text-zinc-950">
            {data.label}
          </h2>
          <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
            Python
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-zinc-500">
          outputs: {outputs}
        </p>
      </div>
      <div className="nodrag nopan p-2 [&_.cm-editor]:max-h-[180px] [&_.cm-editor]:rounded-md [&_.cm-editor]:text-xs [&_.cm-scroller]:font-mono">
        {/* TODO: Switch this to editable mode when graph editing becomes part of the canvas milestone. */}
        <CodeMirror
          value={data.code}
          extensions={extensions}
          readOnly
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
      <Handle
        type="source"
        position={Position.Bottom}
        className="h-3 w-3 border-2 border-white bg-zinc-500"
      />
    </article>
  );
}
