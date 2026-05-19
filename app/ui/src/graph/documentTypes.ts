import type { RuntimeGraph, RuntimeNode } from "./runtimeTypes.ts";

export type NodebookDocumentV1 = {
  version: 1;
  nodes: RuntimeNode[];
  edges: RuntimeGraph["edges"];
};

export function toRuntimeGraph(document: NodebookDocumentV1): RuntimeGraph {
  return {
    nodes: document.nodes.map(({ id, code, outputs, position }) => ({
      id,
      code,
      outputs,
      ...(position ? { position } : {}),
    })),
    edges: document.edges,
  };
}
