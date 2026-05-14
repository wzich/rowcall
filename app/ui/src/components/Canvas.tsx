import {
  Background,
  Controls,
  type NodeMouseHandler,
  type NodeTypes,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { useMemo } from "react";
import type { RuntimeGraph } from "../graph/runtimeTypes.ts";
import {
  type NodeRunVisualStatus,
  toReactFlowGraph,
} from "../graph/toReactFlow.ts";
import { PythonNode } from "./PythonNode.tsx";

const nodeTypes = {
  pythonNode: PythonNode,
} satisfies NodeTypes;

type CanvasProps = {
  graph: RuntimeGraph;
  selectedNodeId: string | null;
  nodeRunStatuses: Record<string, NodeRunVisualStatus>;
  onNodeSelect: (nodeId: string) => void;
  onSelectionClear: () => void;
};

export function Canvas({
  graph,
  selectedNodeId,
  nodeRunStatuses,
  onNodeSelect,
  onSelectionClear,
}: CanvasProps) {
  const initialGraph = useMemo(() => toReactFlowGraph(graph), [graph]);
  // TODO: Replace local React Flow state with document-backed editor state once
  // graph authoring and persistence become part of the canvas milestone.
  const [nodes, _setNodes, onNodesChange] = useNodesState(initialGraph.nodes);
  const [edges, _setEdges, onEdgesChange] = useEdgesState(initialGraph.edges);
  const renderedNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          runStatus: nodeRunStatuses[node.id] ?? "idle",
        },
        selected: node.id === selectedNodeId,
      })),
    [nodes, nodeRunStatuses, selectedNodeId],
  );
  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    onNodeSelect(node.id);
  };

  return (
    <ReactFlow
      nodes={renderedNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      onPaneClick={onSelectionClear}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#d4d4d8" gap={18} />
      <Controls />
    </ReactFlow>
  );
}
