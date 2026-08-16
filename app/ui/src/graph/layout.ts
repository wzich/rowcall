import { Graph, layout } from "@dagrejs/dagre";
import type { RuntimeGraph, RuntimeNode } from "./runtimeTypes.ts";

export type CanvasPosition = {
  x: number;
  y: number;
};

export type NodeDimensions = {
  width: number;
  height: number;
};

export type NodeDimensionsById = Record<
  string,
  NodeDimensions | undefined
>;

const defaultNodeWidth = 360;
const minimumNodeHeight = 112;
const nodeHeaderAndVariableListHeight = 82;
const variableRowHeight = 36;
const descriptionHeight = 48;
const nodeGap = 56;
const rankGap = 120;
const canvasMargin = 80;

export function createSimpleLayout(
  graph: RuntimeGraph,
  measuredDimensions: NodeDimensionsById = {},
): Record<string, CanvasPosition> {
  const layoutGraph = new Graph()
    .setGraph({
      rankdir: "LR",
      nodesep: nodeGap,
      ranksep: rankGap,
      marginx: canvasMargin,
      marginy: canvasMargin,
    })
    .setDefaultEdgeLabel(() => ({}));

  const dimensionsByNodeId: NodeDimensionsById = {};

  for (const node of graph.nodes) {
    const dimensions = normalizeDimensions(
      measuredDimensions[node.id] ?? estimateNodeDimensions(node),
    );
    dimensionsByNodeId[node.id] = dimensions;
    layoutGraph.setNode(node.id, {
      width: dimensions.width,
      height: dimensions.height,
    });
  }

  for (const edge of graph.edges) {
    if (
      layoutGraph.hasNode(edge.fromNode) &&
      layoutGraph.hasNode(edge.toNode)
    ) {
      layoutGraph.setEdge(edge.fromNode, edge.toNode);
    }
  }

  layout(layoutGraph);

  const positions: Record<string, CanvasPosition> = {};
  for (const node of graph.nodes) {
    const position = layoutGraph.node(node.id);
    const dimensions = dimensionsByNodeId[node.id] ??
      estimateNodeDimensions(node);
    positions[node.id] = {
      x: position.x - dimensions.width / 2,
      y: position.y - dimensions.height / 2,
    };
  }

  return positions;
}

function estimateNodeDimensions(node: RuntimeNode): NodeDimensions {
  const visibleVariableCount = new Set([
    ...(node.parameters ?? []),
    ...node.outputs,
  ]).size;
  const variableListHeight = visibleVariableCount > 0
    ? visibleVariableCount * variableRowHeight
    : 30;

  return {
    width: defaultNodeWidth,
    height: Math.max(
      minimumNodeHeight,
      nodeHeaderAndVariableListHeight + variableListHeight +
        (node.description?.trim() ? descriptionHeight : 0),
    ),
  };
}

function normalizeDimensions(dimensions: NodeDimensions): NodeDimensions {
  return {
    width: Number.isFinite(dimensions.width) && dimensions.width > 0
      ? dimensions.width
      : defaultNodeWidth,
    height: Number.isFinite(dimensions.height) && dimensions.height > 0
      ? dimensions.height
      : minimumNodeHeight,
  };
}
