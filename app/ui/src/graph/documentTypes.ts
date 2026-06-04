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
  return {
    nodes: document.nodes.map((
      {
        id,
        code,
        runtimeCode,
        functionName,
        parameters,
        customReturn,
        editable,
        outputs,
        position,
      },
    ) => ({
      id,
      code: runtimeCode ?? code,
      runtimeCode,
      functionName,
      parameters,
      customReturn,
      editable,
      outputs,
      displayCode: code,
      ...(position ? { position } : {}),
    })),
    edges: document.edges,
  };
}
