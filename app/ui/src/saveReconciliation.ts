import type { RowcallDocumentV1 } from "./graph/documentTypes.ts";

type RemovedDeclaredValue = {
  kind: "output";
  name: string;
  nodeLabel: string;
};

export function formatSaveReconciliationNotice(
  before: RowcallDocumentV1,
  after: RowcallDocumentV1,
): string | null {
  const afterNodesById = new Map(after.nodes.map((node) => [node.id, node]));
  const removed: RemovedDeclaredValue[] = [];

  for (const previousNode of before.nodes) {
    const savedNode = afterNodesById.get(previousNode.id);
    if (!savedNode) continue;
    const nodeLabel = previousNode.functionName ?? previousNode.id;

    for (const name of previousNode.outputs) {
      if (!savedNode.outputs.includes(name)) {
        removed.push({ kind: "output", name, nodeLabel });
      }
    }
  }

  if (removed.length === 0) return null;

  const declarations = removed.map(({ kind, name, nodeLabel }) =>
    `${kind} "${name}" from ${nodeLabel}`
  );
  const noun = removed.length === 1 ? "declaration" : "declarations";
  return `Removed stale ${noun} while saving: ${formatList(declarations)}.`;
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}
