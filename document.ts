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
  | {
    type: "add_edge";
    fromNode: string;
    fromOutput: string;
    toNode: string;
    toInput: string;
  }
  | {
    type: "remove_edge";
    fromNode: string;
    fromOutput: string;
    toNode: string;
    toInput: string;
  }
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
      const fromOutput = requiredString(
        record,
        "fromOutput",
        `${path}.fromOutput`,
        issues,
      );
      const toNode = requiredString(record, "toNode", `${path}.toNode`, issues);
      const toInput = requiredString(
        record,
        "toInput",
        `${path}.toInput`,
        issues,
      );
      return fromNode === null || fromOutput === null || toNode === null ||
          toInput === null
        ? null
        : { type, fromNode, fromOutput, toNode, toInput };
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
