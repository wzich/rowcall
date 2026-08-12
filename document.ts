import type { Edge, ValidationIssue } from "./types.ts";

export type GraphPosition = {
  x: number;
  y: number;
};

export type DocumentNode = {
  id: string;
  code: string;
  outputs: string[];
  position?: GraphPosition;
  title?: string;
  description?: string;
  runtimeCode?: string;
  functionName?: string;
  parameters?: string[];
  customReturn?: boolean;
  editable?: boolean;
  sourceRange?: PythonSourceRange;
};

export type PythonSourceRange = {
  startLine: number;
  endLine: number;
  decoratorLine?: number;
  bodyStartLine?: number;
  bodyEndLine?: number;
  returnLine?: number;
  returnEndLine?: number;
  indent?: string;
};

export type RowcallDocumentV1 = {
  version: 1;
  nodes: DocumentNode[];
  edges: Edge[];
  globalsCode?: string;
  readOnly?: boolean;
  revision?: string;
};

export type DocumentOperation =
  | { type: "update_globals"; code: string }
  | { type: "update_node_body"; nodeId: string; code: string }
  | { type: "update_node_outputs"; nodeId: string; outputs: string[] }
  | { type: "rename_node_function"; nodeId: string; functionName: string }
  | { type: "add_node"; node: DocumentOperationNode }
  | { type: "delete_node"; nodeId: string }
  | { type: "add_edge"; fromNode: string; toNode: string }
  | { type: "remove_edge"; fromNode: string; toNode: string }
  | { type: "move_node"; nodeId: string; position: GraphPosition }
  | { type: "update_node_title"; nodeId: string; title: string }
  | { type: "update_node_description"; nodeId: string; description: string };

export type DocumentOperationNode = {
  id: string;
  functionName: string;
  code: string;
  outputs: string[];
  position?: GraphPosition;
  title?: string;
  description?: string;
};

export type DecodeDocumentResult =
  | { ok: true; document: RowcallDocumentV1; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

export type DecodeDocumentOperationsRequestResult =
  | {
    ok: true;
    request: {
      baseRevision: string;
      operations: DocumentOperation[];
    };
    issues: [];
  }
  | { ok: false; issues: ValidationIssue[] };

export function decodeDocumentOperationsRequest(
  obj: unknown,
): DecodeDocumentOperationsRequestResult {
  const issues: ValidationIssue[] = [];
  const record = asRecord(obj);

  if (!record) {
    issues.push({
      kind: "invalid_json",
      message: "Document operations request must be an object.",
    });
    return { ok: false, issues };
  }

  const baseRevision = record["baseRevision"];
  const operationsValue = record["operations"];

  if (typeof baseRevision !== "string") {
    issues.push({
      kind: baseRevision === undefined ? "missing_field" : "wrong_type",
      message: "`baseRevision` must be a string.",
      field: "baseRevision",
      path: "baseRevision",
    });
  }

  if (!Array.isArray(operationsValue)) {
    issues.push({
      kind: operationsValue === undefined ? "missing_field" : "wrong_type",
      message: "`operations` must be an array.",
      field: "operations",
      path: "operations",
    });
  }

  const operations = Array.isArray(operationsValue)
    ? operationsValue.map((operation, index) =>
      decodeDocumentOperation(operation, `operations[${index}]`, issues)
    ).filter((operation): operation is DocumentOperation => operation !== null)
    : [];

  if (
    issues.length > 0 || typeof baseRevision !== "string" ||
    !Array.isArray(operationsValue)
  ) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    request: {
      baseRevision,
      operations,
    },
    issues: [],
  };
}

function decodeDocumentOperation(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): DocumentOperation | null {
  const record = asRecord(value);
  if (!record) {
    issues.push({
      kind: "wrong_type",
      message: "Document operation must be an object.",
      path,
    });
    return null;
  }

  const type = record["type"];
  if (typeof type !== "string") {
    issues.push({
      kind: type === undefined ? "missing_field" : "wrong_type",
      message: "Document operation `type` must be a string.",
      field: "type",
      path: `${path}.type`,
    });
    return null;
  }

  switch (type) {
    case "update_globals": {
      const code = requiredString(record, "code", `${path}.code`, issues);
      return code === null ? null : { type, code };
    }
    case "update_node_body": {
      const nodeId = requiredString(record, "nodeId", `${path}.nodeId`, issues);
      const code = requiredString(record, "code", `${path}.code`, issues);
      return nodeId === null || code === null ? null : { type, nodeId, code };
    }
    case "update_node_outputs": {
      const nodeId = requiredString(record, "nodeId", `${path}.nodeId`, issues);
      const outputs = requiredStringArray(
        record,
        "outputs",
        `${path}.outputs`,
        issues,
      );
      return nodeId === null || outputs === null
        ? null
        : { type, nodeId, outputs };
    }
    case "rename_node_function": {
      const nodeId = requiredString(record, "nodeId", `${path}.nodeId`, issues);
      const functionName = requiredString(
        record,
        "functionName",
        `${path}.functionName`,
        issues,
      );
      return nodeId === null || functionName === null
        ? null
        : { type, nodeId, functionName };
    }
    case "add_node": {
      const node = decodeDocumentOperationNode(
        record["node"],
        `${path}.node`,
        issues,
      );
      return node === null ? null : { type, node };
    }
    case "delete_node": {
      const nodeId = requiredString(record, "nodeId", `${path}.nodeId`, issues);
      return nodeId === null ? null : { type, nodeId };
    }
    case "add_edge":
    case "remove_edge": {
      const fromNode = requiredString(
        record,
        "fromNode",
        `${path}.fromNode`,
        issues,
      );
      const toNode = requiredString(record, "toNode", `${path}.toNode`, issues);
      return fromNode === null || toNode === null
        ? null
        : { type, fromNode, toNode };
    }
    case "move_node": {
      const nodeId = requiredString(record, "nodeId", `${path}.nodeId`, issues);
      const position = decodeGraphPosition(
        record["position"],
        `${path}.position`,
        issues,
      );
      return nodeId === null || position === null
        ? null
        : { type, nodeId, position };
    }
    case "update_node_title": {
      const nodeId = requiredString(record, "nodeId", `${path}.nodeId`, issues);
      const title = requiredString(record, "title", `${path}.title`, issues);
      return nodeId === null || title === null ? null : { type, nodeId, title };
    }
    case "update_node_description": {
      const nodeId = requiredString(record, "nodeId", `${path}.nodeId`, issues);
      const description = requiredString(
        record,
        "description",
        `${path}.description`,
        issues,
      );
      return nodeId === null || description === null
        ? null
        : { type, nodeId, description };
    }
    default:
      issues.push({
        kind: "unsupported_python",
        message: `Unsupported document operation type '${type}'.`,
        field: "type",
        path: `${path}.type`,
      });
      return null;
  }
}

function decodeDocumentOperationNode(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): DocumentOperationNode | null {
  const record = asRecord(value);
  if (!record) {
    issues.push({
      kind: value === undefined ? "missing_field" : "wrong_type",
      message: "`node` must be an object.",
      field: "node",
      path,
    });
    return null;
  }

  const id = requiredString(record, "id", `${path}.id`, issues);
  const functionName = requiredString(
    record,
    "functionName",
    `${path}.functionName`,
    issues,
  );
  const code = requiredString(record, "code", `${path}.code`, issues);
  const outputs = requiredStringArray(
    record,
    "outputs",
    `${path}.outputs`,
    issues,
  );
  const positionValue = record["position"];
  const position = positionValue === undefined
    ? undefined
    : decodeGraphPosition(positionValue, `${path}.position`, issues);
  const title = optionalString(record, "title", `${path}.title`, issues);
  const description = optionalString(
    record,
    "description",
    `${path}.description`,
    issues,
  );

  if (
    id === null || functionName === null || code === null || outputs === null ||
    position === null || title === null || description === null
  ) {
    return null;
  }

  return {
    id,
    functionName,
    code,
    outputs,
    ...(position ? { position } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function decodeGraphPosition(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): GraphPosition | null {
  const record = asRecord(value);
  if (!record) {
    issues.push({
      kind: value === undefined ? "missing_field" : "wrong_type",
      message: "`position` must be an object.",
      field: "position",
      path,
    });
    return null;
  }

  const x = record["x"];
  const y = record["y"];
  if (typeof x !== "number") {
    issues.push({
      kind: x === undefined ? "missing_field" : "wrong_type",
      message: "`position.x` must be a number.",
      field: "x",
      path: `${path}.x`,
    });
  }
  if (typeof y !== "number") {
    issues.push({
      kind: y === undefined ? "missing_field" : "wrong_type",
      message: "`position.y` must be a number.",
      field: "y",
      path: `${path}.y`,
    });
  }

  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  path: string,
  issues: ValidationIssue[],
): string | null {
  const value = record[field];
  if (typeof value !== "string") {
    issues.push({
      kind: value === undefined ? "missing_field" : "wrong_type",
      message: `\`${field}\` must be a string.`,
      field,
      path,
    });
    return null;
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  path: string,
  issues: ValidationIssue[],
): string | undefined | null {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push({
      kind: "wrong_type",
      message: `\`${field}\` must be a string.`,
      field,
      path,
    });
    return null;
  }
  return value;
}

function requiredStringArray(
  record: Record<string, unknown>,
  field: string,
  path: string,
  issues: ValidationIssue[],
): string[] | null {
  const value = record[field];
  if (!Array.isArray(value)) {
    issues.push({
      kind: value === undefined ? "missing_field" : "wrong_type",
      message: `\`${field}\` must be an array of strings.`,
      field,
      path,
    });
    return null;
  }

  const strings = value.filter((item): item is string =>
    typeof item === "string"
  );
  if (strings.length !== value.length) {
    issues.push({
      kind: "wrong_type",
      message: `\`${field}\` must be an array of strings.`,
      field,
      path,
    });
    return null;
  }

  return strings;
}

export function decodeRowcallDocument(obj: unknown): DecodeDocumentResult {
  const issues: ValidationIssue[] = [];
  const record = asRecord(obj);

  if (!record) {
    issues.push({
      kind: "invalid_json",
      message: "Rowcall document must be an object.",
    });
    return { ok: false, issues };
  }

  const version = record["version"];
  if (version !== 1) {
    issues.push({
      kind: "wrong_type",
      message: "Rowcall document version must be 1.",
      field: "version",
      path: "version",
    });
  }

  const nodesValue = getRequiredField(record, "nodes", issues);
  const edgesValue = getRequiredField(record, "edges", issues);
  const globalsCode = record["globalsCode"];
  const readOnly = record["readOnly"];
  const revision = record["revision"];

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

  if (globalsCode !== undefined && typeof globalsCode !== "string") {
    issues.push({
      kind: "wrong_type",
      message: "`globalsCode` must be a string",
      field: "globalsCode",
      path: "globalsCode",
    });
  }

  if (readOnly !== undefined && typeof readOnly !== "boolean") {
    issues.push({
      kind: "wrong_type",
      message: "`readOnly` must be a boolean",
      field: "readOnly",
      path: "readOnly",
    });
  }

  if (revision !== undefined && typeof revision !== "string") {
    issues.push({
      kind: "wrong_type",
      message: "`revision` must be a string",
      field: "revision",
      path: "revision",
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

  return {
    ok: true,
    document: {
      version: 1,
      nodes,
      edges,
      ...(typeof globalsCode === "string" ? { globalsCode } : {}),
      ...(typeof readOnly === "boolean" ? { readOnly } : {}),
      ...(typeof revision === "string" ? { revision } : {}),
    },
    issues: [],
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
    message: `Rowcall document is missing key \`${field}\``,
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
  const title = record["title"];
  const description = record["description"];
  const runtimeCode = record["runtimeCode"];
  const functionName = record["functionName"];
  const parameters = record["parameters"];
  const customReturn = record["customReturn"];
  const editable = record["editable"];
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

  if (title !== undefined && typeof title !== "string") {
    issues.push({
      kind: "wrong_type",
      message: "Node title must be a string",
      field: "title",
      path: `nodes[${index}].title`,
    });
    ok = false;
  }

  if (description !== undefined && typeof description !== "string") {
    issues.push({
      kind: "wrong_type",
      message: "Node description must be a string",
      field: "description",
      path: `nodes[${index}].description`,
    });
    ok = false;
  }

  if (runtimeCode !== undefined && typeof runtimeCode !== "string") {
    issues.push({
      kind: "wrong_type",
      message: "Node runtimeCode must be a string",
      field: "runtimeCode",
      path: `nodes[${index}].runtimeCode`,
    });
    ok = false;
  }

  if (functionName !== undefined && typeof functionName !== "string") {
    issues.push({
      kind: "wrong_type",
      message: "Node functionName must be a string",
      field: "functionName",
      path: `nodes[${index}].functionName`,
    });
    ok = false;
  }

  if (parameters !== undefined) {
    if (
      !Array.isArray(parameters) ||
      !parameters.every((parameter) => typeof parameter === "string")
    ) {
      issues.push({
        kind: "wrong_type",
        message: "Node parameters must be an array of strings",
        field: "parameters",
        path: `nodes[${index}].parameters`,
      });
      ok = false;
    }
  }

  if (customReturn !== undefined && typeof customReturn !== "boolean") {
    issues.push({
      kind: "wrong_type",
      message: "Node customReturn must be a boolean",
      field: "customReturn",
      path: `nodes[${index}].customReturn`,
    });
    ok = false;
  }

  if (editable !== undefined && typeof editable !== "boolean") {
    issues.push({
      kind: "wrong_type",
      message: "Node editable must be a boolean",
      field: "editable",
      path: `nodes[${index}].editable`,
    });
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
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof runtimeCode === "string" ? { runtimeCode } : {}),
    ...(typeof functionName === "string" ? { functionName } : {}),
    ...(Array.isArray(parameters)
      ? { parameters: parameters as string[] }
      : {}),
    ...(typeof customReturn === "boolean" ? { customReturn } : {}),
    ...(typeof editable === "boolean" ? { editable } : {}),
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
