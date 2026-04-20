import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import { createSimpleLayout } from "./layout.ts";
import type { RuntimeGraph } from "./runtimeTypes.ts";

export type PythonNodeData = {
  label: string;
  code: string;
  outputs: string[];
};

export type PythonFlowNode = FlowNode<PythonNodeData, "pythonNode">;
export type PythonFlowEdge = FlowEdge;

export type ReactFlowGraph = {
  nodes: PythonFlowNode[];
  edges: PythonFlowEdge[];
};

export function toReactFlowGraph(graph: RuntimeGraph): ReactFlowGraph {
  const positions = createSimpleLayout(graph);

  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: "pythonNode",
      position: positions[node.id] ?? { x: 0, y: 0 },
      data: {
        label: node.id,
        code: node.code,
        outputs: node.outputs,
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
