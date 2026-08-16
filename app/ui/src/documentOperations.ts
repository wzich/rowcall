import type { DocumentOperation } from "./api/documents.ts";
import type { RowcallDocumentV1 } from "./graph/documentTypes.ts";

export function coalesceDocumentOperations(
  operations: DocumentOperation[],
): DocumentOperation[] {
  const result: DocumentOperation[] = [];
  let replaceableIndexes = buildReplaceableOperationIndexes(result);
  let structuralIndexes = buildStructuralOperationIndexes(result);

  for (const operation of operations) {
    if (operation.type === "delete_node") {
      const touchedOperations = result.filter((queuedOperation) =>
        operationTouchesNode(queuedOperation, operation.nodeId)
      );
      const hasQueuedAdd = touchedOperations.some((queuedOperation) =>
        queuedOperation.type === "add_node"
      );
      const hasQueuedDelete = touchedOperations.some((queuedOperation) =>
        queuedOperation.type === "delete_node"
      );
      result.splice(
        0,
        result.length,
        ...result.filter((queuedOperation) =>
          !operationTouchesNode(queuedOperation, operation.nodeId)
        ),
      );
      replaceableIndexes = buildReplaceableOperationIndexes(result);
      structuralIndexes = buildStructuralOperationIndexes(result);
      if (!hasQueuedAdd || hasQueuedDelete) {
        result.push(operation);
      }
      continue;
    }

    const key = getReplaceableOperationKey(operation);
    if (!key) {
      const structuralKey = getStructuralOperationKey(operation);
      if (structuralKey) {
        const inverseKey = getInverseEdgeOperationKey(operation);
        if (inverseKey) {
          const inverseIndex = structuralIndexes.get(inverseKey);
          if (inverseIndex !== undefined) {
            result.splice(inverseIndex, 1);
            replaceableIndexes = buildReplaceableOperationIndexes(result);
            structuralIndexes = buildStructuralOperationIndexes(result);
            continue;
          }
        }

        const existingIndex = structuralIndexes.get(structuralKey);
        if (existingIndex !== undefined) {
          result[existingIndex] = operation;
          continue;
        }
        structuralIndexes.set(structuralKey, result.length);
      }
      result.push(operation);
      continue;
    }

    const existingIndex = replaceableIndexes.get(key);
    if (existingIndex === undefined) {
      replaceableIndexes.set(key, result.length);
      result.push(operation);
      continue;
    }

    result[existingIndex] = operation;
  }

  return result;
}

export function hasCustomManagedDownstream(
  document: RowcallDocumentV1,
  nodeId: string,
): boolean {
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]));
  return document.edges.some((edge) =>
    edge.fromNode === nodeId && nodesById.get(edge.toNode)?.editable === false
  );
}

export function deriveRoutedOutputs(
  document: RowcallDocumentV1,
  nodeId: string,
): string[] {
  const node = document.nodes.find((item) => item.id === nodeId);
  if (!node) return [];

  const routedOutputs: string[] = [];
  const seen = new Set<string>();
  for (const edge of document.edges) {
    if (edge.fromNode !== nodeId || seen.has(edge.fromOutput)) continue;
    seen.add(edge.fromOutput);
    routedOutputs.push(edge.fromOutput);
  }

  const routedSet = new Set(routedOutputs);
  return [
    ...node.outputs.filter((output) => routedSet.has(output)),
    ...routedOutputs.filter((output) => !node.outputs.includes(output)),
  ];
}

function getStructuralOperationKey(
  operation: DocumentOperation,
): string | null {
  switch (operation.type) {
    case "add_node":
      return `add_node:${operation.node.id}`;
    case "add_edge":
    case "remove_edge":
      return `${operation.type}:${edgeKey(operation)}`;
    case "delete_node":
    case "update_globals":
    case "update_node_body":
    case "update_node_outputs":
    case "rename_node_function":
    case "move_node":
    case "update_node_title":
    case "update_node_description":
      return null;
  }
}

function getInverseEdgeOperationKey(
  operation: DocumentOperation,
): string | null {
  switch (operation.type) {
    case "add_edge":
      return `remove_edge:${edgeKey(operation)}`;
    case "remove_edge":
      return `add_edge:${edgeKey(operation)}`;
    case "add_node":
    case "delete_node":
    case "update_globals":
    case "update_node_body":
    case "update_node_outputs":
    case "rename_node_function":
    case "move_node":
    case "update_node_title":
    case "update_node_description":
      return null;
  }
}

function edgeKey(
  edge: {
    fromNode: string;
    fromOutput: string;
    toNode: string;
    toInput: string;
  },
): string {
  return `${edge.fromNode}.${edge.fromOutput}->${edge.toNode}.${edge.toInput}`;
}

function buildReplaceableOperationIndexes(
  operations: DocumentOperation[],
): Map<string, number> {
  const indexes = new Map<string, number>();
  operations.forEach((operation, index) => {
    const key = getReplaceableOperationKey(operation);
    if (key) {
      indexes.set(key, index);
    }
  });
  return indexes;
}

function buildStructuralOperationIndexes(
  operations: DocumentOperation[],
): Map<string, number> {
  const indexes = new Map<string, number>();
  operations.forEach((operation, index) => {
    const key = getStructuralOperationKey(operation);
    if (key) {
      indexes.set(key, index);
    }
  });
  return indexes;
}

function getReplaceableOperationKey(
  operation: DocumentOperation,
): string | null {
  switch (operation.type) {
    case "update_globals":
      return "update_globals";
    case "update_node_body":
    case "update_node_outputs":
    case "rename_node_function":
    case "move_node":
    case "update_node_title":
    case "update_node_description":
      return `${operation.type}:${operation.nodeId}`;
    case "add_node":
    case "delete_node":
    case "add_edge":
    case "remove_edge":
      return null;
  }
}

function operationTouchesNode(
  operation: DocumentOperation,
  nodeId: string,
): boolean {
  switch (operation.type) {
    case "update_globals":
      return false;
    case "add_node":
      return operation.node.id === nodeId;
    case "add_edge":
    case "remove_edge":
      return operation.fromNode === nodeId || operation.toNode === nodeId;
    case "update_node_body":
    case "update_node_outputs":
    case "rename_node_function":
    case "delete_node":
    case "move_node":
    case "update_node_title":
    case "update_node_description":
      return operation.nodeId === nodeId;
  }
}
