import {
  Background,
  Controls,
  type EdgeChange,
  type NodeChange,
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
import { LayoutDashboard, Plus } from "lucide-react";
import {
  type KeyboardEvent,
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { GraphPosition } from "../graph/runtimeTypes.ts";
import type { RuntimeGraph } from "../graph/runtimeTypes.ts";
import {
  type NodeCanvasPreview,
  type NodeRunVisualStatus,
  type PythonFlowNode,
  type PythonNodeOutputOption,
  toReactFlowGraph,
} from "../graph/toReactFlow.ts";
import { PythonNode } from "./PythonNode.tsx";

const nodeTypes = {
  pythonNode: PythonNode,
} satisfies NodeTypes;

const minCanvasZoom = 0.05;
const maxCanvasZoom = 2;

const interactiveShortcutTargetSelector = [
  "button",
  "input",
  "select",
  "textarea",
  "[contenteditable]",
  "[role='textbox']",
  ".cm-editor",
].join(",");

type CanvasProps = {
  graph: RuntimeGraph;
  selectedNodeId: string | null;
  nodeRunStatuses: Record<string, NodeRunVisualStatus>;
  nodePreviews: Record<string, NodeCanvasPreview>;
  nodeOutputOptions: Record<string, PythonNodeOutputOption[]>;
  onAddNode?: (position: GraphPosition) => void;
  onAutoLayout?: () => void;
  onAddChildNode?: (nodeId: string) => void;
  onCodeChange?: (nodeId: string, code: string) => void;
  onConnectNodes?: (fromNode: string, toNode: string) => void;
  onDeleteEdges?: (edgeIds: string[]) => void;
  onDeleteNode?: (nodeId: string) => void;
  onNodePositionChange: (nodeId: string, position: GraphPosition) => void;
  onNodeSelect: (nodeId: string) => void;
  onOutputsChange?: (nodeId: string, outputs: string[]) => void;
  onRunToNode?: (nodeId: string) => void;
  onSaveDocument?: () => void;
  outputsReadOnly?: boolean;
  runToNodeDisabled?: boolean;
  onSelectionClear: () => void;
};

export function Canvas({
  graph,
  selectedNodeId,
  nodeRunStatuses,
  nodePreviews,
  nodeOutputOptions,
  onAddNode,
  onAutoLayout,
  onAddChildNode,
  onCodeChange,
  onConnectNodes,
  onDeleteEdges,
  onDeleteNode,
  onNodePositionChange,
  onNodeSelect,
  onOutputsChange,
  onRunToNode,
  onSaveDocument,
  outputsReadOnly = false,
  runToNodeDisabled = false,
  onSelectionClear,
}: CanvasProps) {
  const flowGraph = useMemo(() => toReactFlowGraph(graph), [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState(flowGraph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowGraph.edges);
  const shortcutScopeRef = useRef<HTMLDivElement>(null);
  const addNodeAtCanvasCenterRef = useRef<() => void>(() => {});

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
          outputOptions: nodeOutputOptions[node.id] ?? [],
          onAddChild: onAddChildNode,
          onCodeChange: node.data.editable ? onCodeChange : undefined,
          onDelete: onDeleteNode,
          onOutputsChange,
          onRunToNode,
          onSaveDocument,
          outputsReadOnly,
          runToNodeDisabled,
        },
        selected: node.id === selectedNodeId,
      })),
    [
      nodes,
      nodeRunStatuses,
      nodePreviews,
      nodeOutputOptions,
      onAddChildNode,
      onCodeChange,
      onDeleteNode,
      selectedNodeId,
      onOutputsChange,
      onRunToNode,
      onSaveDocument,
      outputsReadOnly,
      runToNodeDisabled,
    ],
  );
  const handleNodeClick: NodeMouseHandler = (event, node) => {
    if (!isInteractiveShortcutTarget(event.target)) {
      shortcutScopeRef.current?.focus();
    }
    onNodeSelect(node.id);
  };
  const handlePaneClick = useCallback(() => {
    shortcutScopeRef.current?.focus();
    onSelectionClear();
  }, [onSelectionClear]);
  const handleNodesChange = useCallback<OnNodesChange<PythonFlowNode>>((
    changes,
  ) => {
    const removedNodeIds = getRemovedNodeIds(changes);
    if (removedNodeIds.length === 0 || !onDeleteNode) {
      onNodesChange(changes);
      return;
    }

    const nonRemoveChanges = changes.filter((change) =>
      change.type !== "remove"
    );
    if (nonRemoveChanges.length > 0) {
      onNodesChange(nonRemoveChanges);
    }
    for (const nodeId of removedNodeIds) {
      onDeleteNode(nodeId);
    }
  }, [onDeleteNode, onNodesChange]);
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
  useEffect(() => {
    addNodeAtCanvasCenterRef.current = () => {
      onAddNode?.({ x: 0, y: 0 });
    };
  }, [onAddNode]);
  const handleCanvasKeyDown = useCallback((
    event: KeyboardEvent<HTMLDivElement>,
  ) => {
    if (!isCanvasShortcutEvent(event)) {
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSaveDocument?.();
      return;
    }

    if (
      event.shiftKey && event.key === "Enter" && selectedNodeId &&
      onRunToNode && !runToNodeDisabled
    ) {
      event.preventDefault();
      void onRunToNode(selectedNodeId);
      return;
    }

    if (
      event.key.toLowerCase() === "a" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      if (!onAddChildNode && !onAddNode) {
        return;
      }

      event.preventDefault();
      if (selectedNodeId && onAddChildNode) {
        onAddChildNode(selectedNodeId);
      } else {
        addNodeAtCanvasCenterRef.current();
      }
    }
  }, [
    onAddChildNode,
    onAddNode,
    onRunToNode,
    onSaveDocument,
    selectedNodeId,
    runToNodeDisabled,
  ]);

  return (
    <div
      data-shortcut-scope="canvas"
      ref={shortcutScopeRef}
      tabIndex={0}
      className="h-full outline-none"
      onKeyDown={handleCanvasKeyDown}
    >
      <ReactFlow
        nodes={renderedNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeClick={handleNodeClick}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={handlePaneClick}
        autoPanOnNodeDrag={false}
        minZoom={minCanvasZoom}
        maxZoom={maxCanvasZoom}
        proOptions={{ hideAttribution: true }}
      >
        <CanvasShortcutBridge
          addNodeAtCanvasCenterRef={addNodeAtCanvasCenterRef}
          onAddNode={onAddNode}
        />
        <InitialFitView nodeCount={renderedNodes.length} />
        <Background color="#d4d4d8" gap={18} />
        <Controls />
        {(onAddNode || onAutoLayout) && (
          <CanvasToolsPanel
            onAddNode={onAddNode}
            onAutoLayout={onAutoLayout}
          />
        )}
      </ReactFlow>
    </div>
  );
}

function isCanvasShortcutEvent(event: KeyboardEvent<HTMLDivElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element)) {
    return true;
  }

  const shortcutScope = target.closest("[data-shortcut-scope]");
  if (shortcutScope !== event.currentTarget) {
    return false;
  }

  return !target.closest(interactiveShortcutTargetSelector);
}

function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof Element &&
    Boolean(target.closest(interactiveShortcutTargetSelector));
}

function getRemovedNodeIds(changes: NodeChange<PythonFlowNode>[]): string[] {
  const removedNodeIds = new Set<string>();
  for (const change of changes) {
    if (change.type === "remove") {
      removedNodeIds.add(change.id);
    }
  }

  return [...removedNodeIds];
}

function CanvasShortcutBridge({
  addNodeAtCanvasCenterRef,
  onAddNode,
}: {
  addNodeAtCanvasCenterRef: MutableRefObject<() => void>;
  onAddNode?: (position: GraphPosition) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    addNodeAtCanvasCenterRef.current = () => {
      if (!onAddNode) {
        return;
      }

      const canvasBounds = document
        .querySelector(".react-flow")
        ?.getBoundingClientRect();
      const x = canvasBounds
        ? canvasBounds.left + canvasBounds.width / 2
        : window.innerWidth / 2;
      const y = canvasBounds
        ? canvasBounds.top + canvasBounds.height / 2
        : window.innerHeight / 2;

      onAddNode(screenToFlowPosition({ x, y }));
    };
  }, [addNodeAtCanvasCenterRef, onAddNode, screenToFlowPosition]);

  return null;
}

function InitialFitView({ nodeCount }: { nodeCount: number }) {
  const { fitView } = useReactFlow();
  const hasFitViewRef = useRef(false);

  useEffect(() => {
    if (hasFitViewRef.current || nodeCount === 0) {
      return;
    }

    hasFitViewRef.current = true;
    const frameId = requestAnimationFrame(() => {
      fitView({ padding: 0.25 });
    });

    return () => cancelAnimationFrame(frameId);
  }, [fitView, nodeCount]);

  return null;
}

function CanvasToolsPanel({
  onAddNode,
  onAutoLayout,
}: {
  onAddNode?: (position: GraphPosition) => void;
  onAutoLayout?: () => void;
}) {
  const { fitView, screenToFlowPosition } = useReactFlow();

  return (
    <Panel position="top-left">
      <div className="flex items-center gap-2">
        {onAddNode && (
          <button
            type="button"
            aria-label="Add node"
            title="Add node"
            className="flex h-9 w-9 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-700 shadow-sm hover:bg-zinc-100"
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
            <Plus aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
          </button>
        )}
        {onAutoLayout && (
          <button
            type="button"
            aria-label="Auto-layout graph"
            title="Auto-layout graph"
            className="flex h-9 w-9 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-700 shadow-sm hover:bg-zinc-100"
            onClick={() => {
              onAutoLayout();
              requestAnimationFrame(() => fitView({ padding: 0.25 }));
            }}
          >
            <LayoutDashboard
              aria-hidden="true"
              className="h-4 w-4"
              strokeWidth={2.25}
            />
          </button>
        )}
      </div>
    </Panel>
  );
}
