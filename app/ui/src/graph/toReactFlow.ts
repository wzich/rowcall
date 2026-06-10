import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import type { OutputEvent, TablePreview } from "../../../../types.ts";
import { createSimpleLayout } from "./layout.ts";
import type { RuntimeGraph } from "./runtimeTypes.ts";

export type PythonNodeData = {
  label: string;
  description?: string;
  functionName?: string;
  nodeId: string;
  outputs: string[];
  inputs: NodePortPreview[];
  outputPreviews: Record<string, string>;
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
  source: "input" | "assigned" | "missing";
};
export type NodePortPreview = {
  name: string;
  type?: string;
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
        label: getNodeLabel(node),
        description: node.description,
        functionName: node.functionName,
        nodeId: node.id,
        outputs: node.outputs,
        inputs: getNodeInputs(graph, node.id),
        outputPreviews: {},
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

function getNodeLabel(node: RuntimeGraph["nodes"][number]): string {
  const title = node.title?.trim();
  return title || node.functionName || node.id;
}

function getNodeInputs(graph: RuntimeGraph, nodeId: string): NodePortPreview[] {
  const upstreamIds = graph.edges
    .filter((edge) => edge.toNode === nodeId)
    .map((edge) => edge.fromNode);
  const upstreamNodes = upstreamIds.flatMap((upstreamId) => {
    const node = graph.nodes.find((item) => item.id === upstreamId);
    return node ? [node] : [];
  });
  const seen = new Set<string>();

  return upstreamNodes.flatMap((node) =>
    node.outputs.flatMap((output) => {
      if (seen.has(output)) {
        return [];
      }
      seen.add(output);
      return [{ name: output }];
    })
  );
}
