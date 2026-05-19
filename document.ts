import type { Edge, Graph, Node, ValidationIssue } from "./types.ts";

export type GraphPosition = {
  x: number;
  y: number;
};

export type DocumentNode = Node & {
  position?: GraphPosition;
};

export type NodebookDocumentV1 = {
  version: 1;
  nodes: DocumentNode[];
  edges: Edge[];
};

export type DecodeDocumentResult =
  | { ok: true; document: NodebookDocumentV1; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

export function decodeNodebookDocument(obj: unknown): DecodeDocumentResult {
  const issues: ValidationIssue[] = [];
  const record = asRecord(obj);

  if (!record) {
    issues.push({
      kind: "invalid_json",
      message: "Nodebook document must be an object.",
    });
    return { ok: false, issues };
  }

  const version = record["version"];
  if (version !== 1) {
    issues.push({
      kind: "wrong_type",
      message: "Nodebook document version must be 1.",
      field: "version",
      path: "version",
    });
  }

  const nodesValue = getRequiredField(record, "nodes", issues);
  const edgesValue = getRequiredField(record, "edges", issues);

  const nodes = Array.isArray(nodesValue)
    ? nodesValue.map((node, index) => decodeDocumentNode(node, index, issues))
      .filter((node): node is DocumentNode => node !== null)
    : undefined;

  if (nodesValue !== undefined && !Array.isArray(nodesValue)) {
    issues.push({
      kind: "wrong_type",
      message: "`nodes` must be an array",
      field: "nodes",
      path: "nodes",
    });
  }

  const edges = Array.isArray(edgesValue)
    ? edgesValue.map((edge, index) => decodeDocumentEdge(edge, index, issues))
      .filter((edge): edge is Edge => edge !== null)
    : undefined;

  if (edgesValue !== undefined && !Array.isArray(edgesValue)) {
    issues.push({
      kind: "wrong_type",
      message: "`edges` must be an array",
      field: "edges",
      path: "edges",
    });
  }

  if (nodes !== undefined) {
    const nodeIds = new Set<string>();
    nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        issues.push({
          kind: "duplicate_node_id",
          message: `Node ID '${node.id}' is not unique`,
          nodeId: node.id,
          path: `nodes[${index}].id`,
        });
      }
      nodeIds.add(node.id);
    });
  }

  if (issues.length > 0 || nodes === undefined || edges === undefined) {
    return { ok: false, issues };
  }

  return { ok: true, document: { version: 1, nodes, edges }, issues: [] };
}

export function toRuntimeGraph(document: NodebookDocumentV1): Graph {
  return {
    nodes: document.nodes.map(({ id, code, outputs }) => ({
      id,
      code,
      outputs,
    })),
    edges: document.edges,
  };
}

export function createEmptyNodebookDocument(): NodebookDocumentV1 {
  return {
    version: 1,
    nodes: [{
      id: "node_1",
      code: "",
      outputs: [],
      position: { x: 0, y: 0 },
    }],
    edges: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getRequiredField(
  record: Record<string, unknown>,
  field: string,
  issues: ValidationIssue[],
): unknown {
  if (Object.hasOwn(record, field)) {
    return record[field];
  }

  issues.push({
    kind: "missing_field",
    message: `Nodebook document is missing key \`${field}\``,
    field,
    path: field,
  });

  return undefined;
}

function decodeDocumentNode(
  value: unknown,
  index: number,
  issues: ValidationIssue[],
): DocumentNode | null {
  const record = asRecord(value);

  if (!record) {
    issues.push({
      kind: "wrong_type",
      message: "Node must be an object",
      path: `nodes[${index}]`,
    });
    return null;
  }

  const id = record["id"];
  const code = record["code"];
  const outputs = record["outputs"];
  const position = record["position"];
  let ok = true;

  if (typeof id !== "string") {
    issues.push({
      kind: "wrong_type",
      message: "Node ID must be a string",
      field: "id",
      path: `nodes[${index}].id`,
    });
    ok = false;
  }

  if (typeof code !== "string") {
    issues.push({
      kind: "wrong_type",
      message: "Node code must be a string",
      field: "code",
      path: `nodes[${index}].code`,
    });
    ok = false;
  }

  if (!Array.isArray(outputs)) {
    issues.push({
      kind: "wrong_type",
      message: "Node outputs must be an array of strings",
      field: "outputs",
      path: `nodes[${index}].outputs`,
    });
    ok = false;
  } else if (!outputs.every((output) => typeof output === "string")) {
    issues.push({
      kind: "wrong_type",
      message: "Node outputs must all be strings",
      field: "outputs",
      path: `nodes[${index}].outputs`,
    });
    ok = false;
  }

  const decodedPosition = decodePosition(position, index, issues);
  if (position !== undefined && decodedPosition === null) {
    ok = false;
  }

  if (!ok) {
    return null;
  }

  return {
    id: id as string,
    code: code as string,
    outputs: outputs as string[],
    ...(decodedPosition ? { position: decodedPosition } : {}),
  };
}

function decodePosition(
  value: unknown,
  nodeIndex: number,
  issues: ValidationIssue[],
): GraphPosition | null {
  if (value === undefined) {
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    issues.push({
      kind: "wrong_type",
      message: "Node position must be an object with numeric x and y fields",
      field: "position",
      path: `nodes[${nodeIndex}].position`,
    });
    return null;
  }

  if (typeof record["x"] !== "number" || typeof record["y"] !== "number") {
    issues.push({
      kind: "wrong_type",
      message: "Node position x and y must be numbers",
      field: "position",
      path: `nodes[${nodeIndex}].position`,
    });
    return null;
  }

  return { x: record["x"], y: record["y"] };
}

function decodeDocumentEdge(
  value: unknown,
  index: number,
  issues: ValidationIssue[],
): Edge | null {
  const record = asRecord(value);

  if (!record) {
    issues.push({
      kind: "wrong_type",
      message: "Edge must be an object",
      path: `edges[${index}]`,
    });
    return null;
  }

  const fromNode = record["fromNode"];
  const toNode = record["toNode"];
  let ok = true;

  if (typeof fromNode !== "string") {
    issues.push({
      kind: "wrong_type",
      message: "Edge fromNode must be a string",
      field: "fromNode",
      edgeIndex: index,
      path: `edges[${index}].fromNode`,
    });
    ok = false;
  }

  if (typeof toNode !== "string") {
    issues.push({
      kind: "wrong_type",
      message: "Edge toNode must be a string",
      field: "toNode",
      edgeIndex: index,
      path: `edges[${index}].toNode`,
    });
    ok = false;
  }

  if (!ok) {
    return null;
  }

  return { fromNode: fromNode as string, toNode: toNode as string };
}
