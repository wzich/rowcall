import type { NodebookDocumentV1 } from "./documentTypes.ts";

export type DirectOutputConflict = {
  outputName: string;
  upstreamNodeIds: string[];
};

export function getDirectOutputConflictsForConnection(
  document: NodebookDocumentV1,
  fromNode: string,
  toNode: string,
): DirectOutputConflict[] {
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]));
  if (!nodesById.has(fromNode) || !nodesById.has(toNode)) {
    return [];
  }

  const upstreamNodeIds = document.edges
    .filter((edge) => edge.toNode === toNode)
    .map((edge) => edge.fromNode);
  if (!upstreamNodeIds.includes(fromNode)) {
    upstreamNodeIds.push(fromNode);
  }

  const ownersByOutput = new Map<string, string[]>();
  for (const upstreamNodeId of upstreamNodeIds) {
    const upstreamNode = nodesById.get(upstreamNodeId);
    if (!upstreamNode) continue;

    for (const outputName of upstreamNode.outputs) {
      const owners = ownersByOutput.get(outputName) ?? [];
      owners.push(upstreamNodeId);
      ownersByOutput.set(outputName, owners);
    }
  }

  return Array.from(ownersByOutput, ([outputName, owners]) => ({
    outputName,
    upstreamNodeIds: owners,
  })).filter((conflict) => conflict.upstreamNodeIds.length > 1);
}
