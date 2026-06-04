import type { RuntimeGraph } from "./runtimeTypes.ts";

export type CanvasPosition = {
  x: number;
  y: number;
};

const columnGap = 520;
const rowGap = 300;
const startX = 80;
const startY = 80;

export function createSimpleLayout(
  graph: RuntimeGraph,
): Record<string, CanvasPosition> {
  const depthByNode = new Map<string, number>();
  const parentsByNode = new Map<string, string[]>();

  for (const node of graph.nodes) {
    depthByNode.set(node.id, 0);
    parentsByNode.set(node.id, []);
  }

  for (const edge of graph.edges) {
    if (!parentsByNode.has(edge.toNode)) continue;
    parentsByNode.get(edge.toNode)!.push(edge.fromNode);
  }

  // TODO: Replace this minimal layout with a real DAG layout once graphs get
  // large enough that hand-spaced columns stop being useful.
  for (let pass = 0; pass < graph.nodes.length; pass += 1) {
    for (const node of graph.nodes) {
      const parentDepths = (parentsByNode.get(node.id) ?? [])
        .map((parentId) => depthByNode.get(parentId) ?? 0);
      if (parentDepths.length === 0) continue;
      depthByNode.set(node.id, Math.max(...parentDepths) + 1);
    }
  }

  const nodesByDepth = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const depth = depthByNode.get(node.id) ?? 0;
    const nodes = nodesByDepth.get(depth) ?? [];
    nodes.push(node.id);
    nodesByDepth.set(depth, nodes);
  }

  const positions: Record<string, CanvasPosition> = {};
  for (const [depth, nodeIds] of nodesByDepth) {
    nodeIds.forEach((nodeId, row) => {
      positions[nodeId] = {
        x: startX + row * columnGap,
        y: startY + depth * rowGap,
      };
    });
  }

  return positions;
}
