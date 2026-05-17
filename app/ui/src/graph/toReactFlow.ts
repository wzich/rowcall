import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import { createSimpleLayout } from "./layout.ts";
import type { RuntimeGraph } from "./runtimeTypes.ts";

export type PythonNodeData = {
  label: string;
  code: string;
  outputs: string[];
  runStatus: NodeRunVisualStatus;
  onAddChild?: (nodeId: string) => void;
  onCodeChange?: (nodeId: string, code: string) => void;
  onDelete?: (nodeId: string) => void;
};

export type PythonFlowNode = FlowNode<PythonNodeData, "pythonNode">;
export type PythonFlowEdge = FlowEdge;
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
  const positions = createSimpleLayout(graph);

  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: "pythonNode",
      // TODO: Add a "Clean up layout" canvas action that reapplies the
      // generated layout and stores the resulting positions in the document.
      position: node.position ?? positions[node.id] ?? { x: 0, y: 0 },
      data: {
        label: node.id,
        code: node.code,
        outputs: node.outputs,
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
