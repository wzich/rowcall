import {
  Background,
  Controls,
  type EdgeChange,
  type NodeMouseHandler,
  type NodeTypes,
  type OnConnect,
  type OnNodeDrag,
  type OnNodesChange,
  Panel,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo } from "react";
import type { GraphPosition } from "../graph/runtimeTypes.ts";
import type { RuntimeGraph } from "../graph/runtimeTypes.ts";
import {
  type NodeCanvasPreview,
  type NodeRunVisualStatus,
  type PythonFlowNode,
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
  nodePreviews: Record<string, NodeCanvasPreview>;
  onAddNode?: (position: GraphPosition) => void;
  onAddChildNode?: (nodeId: string) => void;
  onCodeChange?: (nodeId: string, code: string) => void;
  onConnectNodes?: (fromNode: string, toNode: string) => void;
  onDeleteEdges?: (edgeIds: string[]) => void;
  onDeleteNode?: (nodeId: string) => void;
  onNodePositionChange: (nodeId: string, position: GraphPosition) => void;
  onNodeSelect: (nodeId: string) => void;
  onSelectionClear: () => void;
};

export function Canvas({
  graph,
  selectedNodeId,
  nodeRunStatuses,
  nodePreviews,
  onAddNode,
  onAddChildNode,
  onCodeChange,
  onConnectNodes,
  onDeleteEdges,
  onDeleteNode,
  onNodePositionChange,
  onNodeSelect,
  onSelectionClear,
}: CanvasProps) {
  const flowGraph = useMemo(() => toReactFlowGraph(graph), [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState(flowGraph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowGraph.edges);

  useEffect(() => {
    setNodes(flowGraph.nodes);
  }, [flowGraph.nodes, setNodes]);

  useEffect(() => {
    setEdges(flowGraph.edges);
  }, [flowGraph.edges, setEdges]);

  const renderedNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          runStatus: nodeRunStatuses[node.id] ?? "idle",
          preview: nodePreviews[node.id],
          onAddChild: onAddChildNode,
          onCodeChange: node.data.editable ? onCodeChange : undefined,
          onDelete: onDeleteNode,
        },
        selected: node.id === selectedNodeId,
      })),
    [
      nodes,
      nodeRunStatuses,
      nodePreviews,
      onAddChildNode,
      onCodeChange,
      onDeleteNode,
      selectedNodeId,
    ],
  );
  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    onNodeSelect(node.id);
  };
  const handleNodesChange = useCallback<OnNodesChange<PythonFlowNode>>((
    changes,
  ) => {
    onNodesChange(changes);
  }, [onNodesChange]);
  const handleNodeDragStop = useCallback<OnNodeDrag<PythonFlowNode>>((
    _event,
    node,
  ) => {
    onNodePositionChange(node.id, node.position);
  }, [onNodePositionChange]);
  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    onEdgesChange(changes);
    const removedEdgeIds = changes
      .filter((change) => change.type === "remove")
      .map((change) => change.id);

    if (removedEdgeIds.length > 0) {
      onDeleteEdges?.(removedEdgeIds);
    }
  }, [onDeleteEdges, onEdgesChange]);
  const handleConnect = useCallback<OnConnect>((connection) => {
    if (!connection.source || !connection.target) {
      return;
    }

    onConnectNodes?.(connection.source, connection.target);
  }, [onConnectNodes]);

  return (
    <ReactFlow
      nodes={renderedNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={handleNodesChange}
      onEdgesChange={handleEdgesChange}
      onConnect={handleConnect}
      onNodeClick={handleNodeClick}
      onNodeDragStop={handleNodeDragStop}
      onPaneClick={onSelectionClear}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#d4d4d8" gap={18} />
      <Controls />
      {onAddNode && <CanvasAddPanel onAddNode={onAddNode} />}
    </ReactFlow>
  );
}

function CanvasAddPanel({
  onAddNode,
}: {
  onAddNode: (position: GraphPosition) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();

  return (
    <Panel position="top-left">
      <button
        type="button"
        aria-label="Add node"
        title="Add node"
        className="flex h-9 w-9 items-center justify-center rounded border border-zinc-300 bg-white text-xl font-semibold text-zinc-700 shadow-sm hover:bg-zinc-100"
        onClick={() => {
          const canvasBounds = document
            .querySelector(".react-flow")
            ?.getBoundingClientRect();
          const x = canvasBounds
            ? canvasBounds.left + canvasBounds.width / 2
            : window.innerWidth / 2;
          const y = canvasBounds
            ? canvasBounds.top + canvasBounds.height / 2
            : window.innerHeight / 2;

          onAddNode(
            screenToFlowPosition({
              x,
              y,
            }),
          );
        }}
      >
        +
      </button>
    </Panel>
  );
}
