import type { RuntimeGraph, RuntimeNode } from "./runtimeTypes.ts";

export type NodebookDocumentV1 = {
  version: 1;
  nodes: RuntimeNode[];
  edges: RuntimeGraph["edges"];
  globalsCode?: string;
  readOnly?: boolean;
  revision?: string;
};

export function toRuntimeGraph(document: NodebookDocumentV1): RuntimeGraph {
  const inputsByNodeId = getDirectInputNamesByNodeId(document);

  return {
    nodes: document.nodes.map((
      {
        id,
        code,
        runtimeCode,
        functionName,
        description,
        customReturn,
        editable,
        outputs,
        position,
      },
    ) => {
      const parameters = inputsByNodeId.get(id) ?? [];

      return {
        id,
        code: runtimeCode ?? code,
        runtimeCode,
        functionName,
        description,
        parameters,
        customReturn,
        editable,
        outputs,
        displayCode: code,
        ...(position ? { position } : {}),
      };
    }),
    edges: document.edges,
  };
}

function getDirectInputNamesByNodeId(
  document: NodebookDocumentV1,
): Map<string, string[]> {
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]));
  const inputsByNodeId = new Map<string, string[]>(
    document.nodes.map((node) => [node.id, []]),
  );

  for (const edge of document.edges) {
    const upstream = nodesById.get(edge.fromNode);
    const inputs = inputsByNodeId.get(edge.toNode);
    if (!upstream || !inputs) continue;

    for (const output of upstream.outputs) {
      inputs.push(output);
    }
  }

  return inputsByNodeId;
}
