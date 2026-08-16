import {
  Background,
  Controls,
  type EdgeChange,
  type NodeChange,
  type NodeMouseHandler,
  type NodeTypes,
  type OnConnect,
  type OnConnectEnd,
  type OnConnectStart,
  type OnNodeDrag,
  type OnNodesChange,
  Panel,
  PanOnScrollMode,
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
import type { ThemeMode } from "../App.tsx";
import {
  type NodeCanvasPreview,
  type NodeRunVisualStatus,
  type PythonFlowNode,
  type PythonNodeOutputOption,
  toReactFlowGraph,
} from "../graph/toReactFlow.ts";
import { getCanvasDeletionIntent } from "./canvasDeletion.ts";
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
  themeMode: ThemeMode;
  graph: RuntimeGraph;
  selectedNodeId: string | null;
  focusNodeRequest?: { nodeId: string; requestId: number } | null;
  nodeRunStatuses: Record<string, NodeRunVisualStatus>;
  nodePreviews: Record<string, NodeCanvasPreview>;
  nodeInputPreviews: Record<string, Array<{ name: string; type?: string }>>;
  nodeOutputOptions: Record<string, PythonNodeOutputOption[]>;
  onAddNode?: (position: GraphPosition) => void;
  onAutoLayout?: () => void;
  onAddChildNode?: (nodeId: string) => void;
  onCodeChange?: (nodeId: string, code: string) => void;
  onConnectNodes?: (
    fromNode: string,
    fromOutput: string,
    toNode: string,
  ) => void;
  onDeleteEdges?: (edgeIds: string[]) => string[];
  onDeleteNode?: (nodeId: string) => void;
  onNodePositionChange?: (nodeId: string, position: GraphPosition) => void;
  onNodeSelect: (nodeId: string) => void;
  onOutputsChange?: (nodeId: string, outputs: string[]) => void;
  onRunToNode?: (nodeId: string) => void;
  onSaveDocument?: () => void;
  outputsReadOnly?: boolean;
  runToNodeDisabled?: boolean;
  onSelectionClear: () => void;
};

export function Canvas({
  themeMode,
  graph,
  selectedNodeId,
  focusNodeRequest,
  nodeRunStatuses,
  nodePreviews,
  nodeInputPreviews,
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
  const pendingConnectionRef = useRef<
    {
      fromNode: string;
      fromOutput: string;
    } | null
  >(null);

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
          inputs: nodeInputPreviews[node.id] ?? node.data.inputs,
          outputPreviews: getOutputTypePreviews(nodePreviews[node.id]),
          outputOptions: nodeOutputOptions[node.id] ?? [],
          onCodeChange: node.data.editable ? onCodeChange : undefined,
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
      nodeInputPreviews,
      nodeOutputOptions,
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
  const handleEdgeClick = useCallback(() => {
    shortcutScopeRef.current?.focus();
    onSelectionClear();
  }, [onSelectionClear]);
  const handlePaneClick = useCallback(() => {
    shortcutScopeRef.current?.focus();
    onSelectionClear();
  }, [onSelectionClear]);
  const handleNodesChange = useCallback<OnNodesChange<PythonFlowNode>>((
    changes,
  ) => {
    const removedNodeIds = getRemovedNodeIds(changes);
    if (removedNodeIds.length === 0) {
      onNodesChange(changes);
      return;
    }

    const nonRemoveChanges = changes.filter((change) =>
      change.type !== "remove"
    );
    if (nonRemoveChanges.length > 0) {
      onNodesChange(nonRemoveChanges);
    }
    if (!onDeleteNode) {
      return;
    }
    for (const nodeId of removedNodeIds) {
      onDeleteNode(nodeId);
    }
  }, [onDeleteNode, onNodesChange]);
  const handleNodeDragStop = useCallback<OnNodeDrag<PythonFlowNode>>((
    _event,
    node,
  ) => {
    onNodePositionChange?.(node.id, node.position);
  }, [onNodePositionChange]);
  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removedEdgeIds = changes
      .filter((change) => change.type === "remove")
      .map((change) => change.id);
    const acceptedRemovedEdgeIds = removedEdgeIds.length > 0
      ? onDeleteEdges?.(removedEdgeIds) ?? []
      : [];
    const acceptedRemovedEdgeIdSet = new Set(acceptedRemovedEdgeIds);
    const acceptedChanges = changes.filter((change) =>
      change.type !== "remove" || acceptedRemovedEdgeIdSet.has(change.id)
    );

    if (acceptedChanges.length > 0) {
      onEdgesChange(acceptedChanges);
    }
  }, [onDeleteEdges, onEdgesChange]);
  const handleConnect = useCallback<OnConnect>((connection) => {
    if (!connection.source || !connection.sourceHandle || !connection.target) {
      return;
    }

    onConnectNodes?.(
      connection.source,
      connection.sourceHandle,
      connection.target,
    );
    pendingConnectionRef.current = null;
  }, [onConnectNodes]);
  const handleConnectStart = useCallback<OnConnectStart>((_event, params) => {
    pendingConnectionRef.current = params.handleType === "source" &&
        params.nodeId && params.handleId
      ? { fromNode: params.nodeId, fromOutput: params.handleId }
      : null;
  }, []);
  const handleConnectEnd = useCallback<OnConnectEnd>((event) => {
    const pending = pendingConnectionRef.current;
    pendingConnectionRef.current = null;
    if (!pending || !onConnectNodes) return;
    const point = getConnectionEndPoint(event);
    if (!point) return;
    const target = document.elementFromPoint(point.x, point.y)?.closest(
      "[data-node-id]",
    );
    const toNode = target?.getAttribute("data-node-id");
    if (!toNode || toNode === pending.fromNode) return;
    onConnectNodes(pending.fromNode, pending.fromOutput, toNode);
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

    if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      const deletionIntent = getCanvasDeletionIntent({
        key: event.key,
        repeat: event.repeat,
        selectedNodeId,
        selectedEdgeIds: edges
          .filter((edge) => edge.selected)
          .map((edge) => edge.id),
      });
      if (deletionIntent) {
        event.preventDefault();
        if (deletionIntent.type === "edges") {
          onDeleteEdges?.(deletionIntent.edgeIds);
        } else {
          onDeleteNode?.(deletionIntent.nodeId);
        }
        return;
      }
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
    onDeleteEdges,
    onDeleteNode,
    onRunToNode,
    onSaveDocument,
    edges,
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
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        onEdgeClick={handleEdgeClick}
        onNodeClick={handleNodeClick}
        onNodeDragStop={handleNodeDragStop}
        nodesDraggable={Boolean(onNodePositionChange)}
        onPaneClick={handlePaneClick}
        deleteKeyCode={null}
        autoPanOnNodeDrag={false}
        zoomOnScroll={false}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        panOnScrollSpeed={1}
        zoomOnPinch
        minZoom={minCanvasZoom}
        maxZoom={maxCanvasZoom}
        connectionRadius={24}
        proOptions={{ hideAttribution: true }}
      >
        <CanvasShortcutBridge
          addNodeAtCanvasCenterRef={addNodeAtCanvasCenterRef}
          onAddNode={onAddNode}
        />
        <InitialFitView nodeCount={renderedNodes.length} />
        <FocusNode request={focusNodeRequest} />
        <Background
          color={themeMode === "dark" ? "#3f3f46" : "#d4d4d8"}
          gap={18}
        />
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

function getConnectionEndPoint(
  event: MouseEvent | TouchEvent,
): { x: number; y: number } | null {
  if ("changedTouches" in event) {
    const touch = event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return { x: event.clientX, y: event.clientY };
}

function FocusNode({
  request,
}: {
  request?: { nodeId: string; requestId: number } | null;
}) {
  const { getNode, getZoom, setCenter } = useReactFlow();

  useEffect(() => {
    if (!request) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      const node = getNode(request.nodeId);
      if (!node) {
        return;
      }

      const width = node.measured?.width ?? node.width ?? 360;
      const height = node.measured?.height ?? node.height ?? 180;
      void setCenter(
        node.position.x + width / 2,
        node.position.y + height / 2,
        { duration: 250, zoom: getZoom() },
      );
    });

    return () => cancelAnimationFrame(frameId);
  }, [getNode, getZoom, request, setCenter]);

  return null;
}

function getOutputTypePreviews(
  preview: NodeCanvasPreview | undefined,
): Record<string, string> {
  if (!preview?.ok) {
    return {};
  }

  return Object.fromEntries(
    preview.outputs.map((output) => [output.name, output.type]),
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
            className="flex h-9 w-9 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-700 shadow-sm hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
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
            className="flex h-9 w-9 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-700 shadow-sm hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
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
