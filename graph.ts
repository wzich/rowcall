import type {
  DecodeGraphResult,
  Edge,
  Graph,
  GraphValidationResult,
  Node,
  ValidationIssue,
} from "./types.ts";

export function decodeGraph(obj: unknown): DecodeGraphResult {
  const validationIssues: ValidationIssue[] = [];
  const record = asRecord(obj);

  if (!record) {
    validationIssues.push({
      kind: "invalid_json",
      message: "Graph must be an object.",
    });
    return { ok: false, issues: validationIssues };
  }

  const nodesValue = getRequiredField(record, "nodes", validationIssues);
  const edgesValue = getRequiredField(record, "edges", validationIssues);

  const nodes = Array.isArray(nodesValue)
    ? nodesValue.map((node, index) => decodeNode(node, index, validationIssues))
      .filter((node): node is Node => node !== null)
    : undefined;

  if (nodesValue !== undefined && !Array.isArray(nodesValue)) {
    validationIssues.push({
      kind: "wrong_type",
      message: "`nodes` must be an array",
      field: "nodes",
      path: "nodes",
    });
  }

  const edges = Array.isArray(edgesValue)
    ? edgesValue.map((edge, index) => decodeEdge(edge, index, validationIssues))
      .filter((edge): edge is Edge => edge !== null)
    : undefined;

  if (edgesValue !== undefined && !Array.isArray(edgesValue)) {
    validationIssues.push({
      kind: "wrong_type",
      message: "`edges` must be an array",
      field: "edges",
      path: "edges",
    });
  }

  if (
    validationIssues.length > 0 ||
    nodes === undefined ||
    edges === undefined
  ) {
    return { ok: false, issues: validationIssues };
  }

  return { ok: true, graph: { nodes, edges }, issues: [] };
}

export function validateGraph(graph: Graph): GraphValidationResult {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set<string>();

  graph.nodes.forEach((node, index) => {
    if (nodeIds.has(node.id)) {
      issues.push({
        kind: "duplicate_node_id",
        message: `Node ID '${node.id}' is not unique`,
        nodeId: node.id,
        path: `nodes[${index}].id`,
      });
      return;
    }

    nodeIds.add(node.id);
  });

  graph.edges.forEach((edge, index) => {
    if (!nodeIds.has(edge.fromNode)) {
      issues.push({
        kind: "missing_node_reference",
        message: `Edge references nonexistent node ${edge.fromNode}`,
        edgeIndex: index,
        field: "fromNode",
        path: `edges[${index}].fromNode`,
      });
    }

    if (!nodeIds.has(edge.toNode)) {
      issues.push({
        kind: "missing_node_reference",
        message: `Edge references nonexistent node ${edge.toNode}`,
        edgeIndex: index,
        field: "toNode",
        path: `edges[${index}].toNode`,
      });
    }
  });

  if (hasCycle(graph)) {
    issues.push({
      kind: "cycle",
      message: "Graph has a cycle",
    });
  }

  if (hasConflictingOutputs(graph)) {
    issues.push({
      kind: "conflicting_outputs",
      message: "Graph has conflicting outputs",
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, issues: [] };
}

export function buildDownstreamAdjacency(graph: Graph): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();

  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }

  for (const edge of graph.edges) {
    adjacency.get(edge.fromNode)!.push(edge.toNode);
  }

  return adjacency;
}

export function buildUpstreamAdjacency(graph: Graph): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();

  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }

  for (const edge of graph.edges) {
    adjacency.get(edge.toNode)!.push(edge.fromNode);
  }

  return adjacency;
}

function hasCycle(graph: Graph): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const neighborsByNode = buildDownstreamAdjacency(graph);

  function visit(nodeId: string): boolean {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;

    visiting.add(nodeId);

    for (const neighbor of neighborsByNode.get(nodeId) ?? []) {
      if (visit(neighbor)) return true;
    }

    visiting.delete(nodeId);
    visited.add(nodeId);

    return false;
  }

  for (const node of graph.nodes) {
    if (visit(node.id)) return true;
  }

  return false;
}

function hasConflictingOutputs(graph: Graph): boolean {
  const parentMap = buildUpstreamAdjacency(graph);
  for (const node of graph.nodes) {
    const parents = parentMap.get(node.id) ?? [];
    const parentOutputs: string[] = [];
    for (const parentId of parents) {
      const parent = getNodeById(graph, parentId);
      parentOutputs.push(...parent.outputs);
    }
    if (new Set(parentOutputs).size !== parentOutputs.length) return true;
  }

  return false;
}

export function getNodeById(graph: Graph, id: string): Node {
  const match = graph.nodes.find((node) => node.id === id);
  if (!match) {
    throw new Error(`Failed to find node with ID ${id}`);
  }
  return match;
}

export function assertNodeExists(graph: Graph, id: string): void {
  getNodeById(graph, id);
}

export function collectRequiredNodeIds(
  graph: Graph,
  targetNodeId: string,
): Set<string> {
  const required = new Set<string>();
  const upstream = buildUpstreamAdjacency(graph);

  function visit(nodeId: string) {
    if (required.has(nodeId)) return;
    required.add(nodeId);

    for (const parentId of upstream.get(nodeId) ?? []) {
      visit(parentId);
    }
  }

  visit(targetNodeId);
  return required;
}

export function getSourceNodes(graph: Graph): Set<string> {
  const sources = new Set<string>();
  const upstream = buildUpstreamAdjacency(graph);

  for (const node of upstream) {
    if (node[1].length === 0) sources.add(node[0]);
  }

  return sources;
}

export function getSinkNodes(graph: Graph): Set<string> {
  const sinks = new Set<string>();
  const downstream = buildDownstreamAdjacency(graph);

  for (const node of downstream) {
    if (node[1].length === 0) sinks.add(node[0]);
  }

  return sinks;
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
    message: `Graph object is missing key \`${field}\``,
    field,
    path: field,
  });

  return undefined;
}

function decodeNode(
  value: unknown,
  index: number,
  issues: ValidationIssue[],
): Node | null {
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
  const codeKind = record["codeKind"];
  const outputs = record["outputs"];

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

  if (
    codeKind !== undefined && codeKind !== "body" && codeKind !== "runtime"
  ) {
    issues.push({
      kind: "wrong_type",
      message: "Node codeKind must be 'body' or 'runtime'",
      field: "codeKind",
      path: `nodes[${index}].codeKind`,
    });
    ok = false;
  }

  if (!ok) {
    return null;
  }

  return {
    id: id as string,
    code: code as string,
    ...(codeKind === "body" || codeKind === "runtime" ? { codeKind } : {}),
    outputs: outputs as string[],
  };
}

function decodeEdge(
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
