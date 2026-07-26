import { Graph, layout } from "@dagrejs/dagre";
import type { RuntimeGraph } from "./runtimeTypes.ts";

export type CanvasPosition = {
  x: number;
  y: number;
};

const nodeWidth = 360;
const nodeHeight = 220;
const nodeGap = 80;
const rankGap = 120;
const canvasMargin = 80;

export function createSimpleLayout(
  graph: RuntimeGraph,
): Record<string, CanvasPosition> {
  const layoutGraph = new Graph()
    .setGraph({
      rankdir: "TB",
      nodesep: nodeGap,
      ranksep: rankGap,
      marginx: canvasMargin,
      marginy: canvasMargin,
    })
    .setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) {
    layoutGraph.setNode(node.id, {
      width: nodeWidth,
      height: nodeHeight,
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
    positions[node.id] = {
      x: position.x - nodeWidth / 2,
      y: position.y - nodeHeight / 2,
    };
  }

  return positions;
}
