import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import type { OutputEvent, TablePreview } from "../../../../types.ts";
import { createSimpleLayout } from "./layout.ts";
import type { RuntimeGraph } from "./runtimeTypes.ts";

export type PythonNodeData = {
  label: string;
  code: string;
  outputs: string[];
  outputOptions: PythonNodeOutputOption[];
  editable: boolean;
  runStatus: NodeRunVisualStatus;
  preview?: NodeCanvasPreview;
  onAddChild?: (nodeId: string) => void;
  onCodeChange?: (nodeId: string, code: string) => void;
  onDelete?: (nodeId: string) => void;
  onOutputsChange?: (nodeId: string, outputs: string[]) => void;
  onRunToNode?: (nodeId: string) => void;
  onSaveDocument?: () => void;
  outputsReadOnly?: boolean;
  runToNodeDisabled?: boolean;
};

export type PythonFlowNode = FlowNode<PythonNodeData, "pythonNode">;
export type PythonFlowEdge = FlowEdge;
export type PythonNodeOutputOption = {
  name: string;
  source: "input" | "assigned" | "manual";
};
export type NodeCanvasPreview = {
  ok: boolean;
  outputs: Array<{
    name: string;
    type: string;
    table?: TablePreview;
  }>;
  outputEvents: OutputEvent[];
  stdout: string;
  stderr: string;
  error: string | null;
};
export type NodeRunVisualStatus =
  | "idle"
  | "stale"
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type ReactFlowGraph = {
  nodes: PythonFlowNode[];
  edges: PythonFlowEdge[];
};

export function toReactFlowGraph(
  graph: RuntimeGraph,
  nodeRunStatuses: Record<string, NodeRunVisualStatus> = {},
): ReactFlowGraph {
  const positions = graph.nodes.every((node) => node.position)
    ? {}
    : createSimpleLayout(graph);

  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: "pythonNode",
      // TODO: Add a "Clean up layout" canvas action that reapplies the
      // generated layout and stores the resulting positions in the document.
      position: node.position ?? positions[node.id] ?? { x: 0, y: 0 },
      data: {
        label: node.functionName ?? node.id,
        code: node.displayCode ?? node.code,
        outputs: node.outputs,
        outputOptions: [],
        editable: node.editable ?? true,
        runStatus: nodeRunStatuses[node.id] ?? "idle",
      },
    })),
    edges: graph.edges.map((edge) => ({
      id: `${edge.fromNode}->${edge.toNode}`,
      source: edge.fromNode,
      target: edge.toNode,
      type: "smoothstep",
    })),
  };
}
