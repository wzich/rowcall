import type { RuntimeGraph, RuntimeNode } from "./runtimeTypes.ts";

export type RowcallDocumentV1 = {
  version: 1;
  nodes: RuntimeNode[];
  edges: RuntimeGraph["edges"];
  globalsCode?: string;
  readOnly?: boolean;
  revision?: string;
};

export function toRuntimeGraph(document: RowcallDocumentV1): RuntimeGraph {
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
  document: RowcallDocumentV1,
): Map<string, string[]> {
  const inputsByNodeId = new Map<string, string[]>(
    document.nodes.map((node) => [node.id, []]),
  );

  for (const edge of document.edges) {
    const inputs = inputsByNodeId.get(edge.toNode);
    if (!inputs || inputs.includes(edge.toInput)) continue;
    inputs.push(edge.toInput);
  }

  return inputsByNodeId;
}
