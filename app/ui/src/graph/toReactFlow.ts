import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import type { TablePreview } from "../../../../types.ts";
import { createSimpleLayout } from "./layout.ts";
import { prettifyFunctionName } from "./nodeNames.ts";
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
  onCodeChange?: (nodeId: string, code: string) => void;
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
  displays: Array<{ name: string; type: string }>;
  stdout: string;
  stderr: string;
  error: string | null;
};
export type NodeRunVisualStatus =
  | "idle"
  | "stale"
  | "queued"
  | "running"
  | "blocked"
  | "blocked_globals"
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
      id: getEdgeId(edge),
      source: edge.fromNode,
      sourceHandle: edge.fromOutput,
      target: edge.toNode,
      targetHandle: "node-input",
      type: "default",
      animated: true,
      className: "python-flow-edge",
      interactionWidth: 18,
      style: { strokeDasharray: "6 8", strokeWidth: 1.75 },
    })),
  };
}

function getNodeLabel(node: RuntimeGraph["nodes"][number]): string {
  return prettifyFunctionName(node.functionName);
}

function getNodeInputs(graph: RuntimeGraph, nodeId: string): NodePortPreview[] {
  const seen = new Set<string>();
  return graph.edges
    .filter((edge) => edge.toNode === nodeId)
    .flatMap((edge) => {
      if (seen.has(edge.toInput)) return [];
      seen.add(edge.toInput);
      return [{ name: edge.toInput }];
    });
}

export function getEdgeId(
  edge: RuntimeGraph["edges"][number],
): string {
  return `${edge.fromNode}.${edge.fromOutput}->${edge.toNode}.${edge.toInput}`;
}
