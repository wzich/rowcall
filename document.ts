import type { Edge, Graph, Node, ValidationIssue } from "./types.ts";

export type GraphPosition = {
  x: number;
  y: number;
};

export type DocumentNode = Node & {
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

export type NodebookDocumentV1 = {
  version: 1;
  nodes: DocumentNode[];
  edges: Edge[];
  globalsCode?: string;
  readOnly?: boolean;
  revision?: string;
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

export function toRuntimeGraph(document: NodebookDocumentV1): Graph {
  const inputsByNodeId = getDirectInputNamesByNodeId(document);

  return {
    nodes: document.nodes.map((
      { id, code, outputs, runtimeCode, functionName, customReturn },
    ) => {
      const parameters = inputsByNodeId.get(id) ?? [];
      const shouldBuildRuntimeCode = Boolean(functionName) && !customReturn;

      return {
        id,
        code: shouldBuildRuntimeCode
          ? buildRuntimeCode({
            globalsCode: document.globalsCode ?? "",
            code,
            functionName,
            parameters,
            outputs,
            customReturn,
          })
          : runtimeCode ?? code,
        codeKind: shouldBuildRuntimeCode || typeof runtimeCode === "string"
          ? "runtime"
          : "body",
        outputs,
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

function buildRuntimeCode(
  {
    globalsCode,
    code,
    functionName,
    parameters,
    outputs,
    customReturn,
  }: {
    globalsCode: string;
    code: string;
    functionName?: string;
    parameters?: string[];
    outputs: string[];
    customReturn?: boolean;
  },
): string {
  if (!functionName || !parameters || customReturn) {
    return code;
  }

  const functionSource = [
    `def ${functionName}(${parameters.join(", ")}):`,
    ...indentFunctionBody(code).map((line) => `    ${line}`),
    ...buildReturnBody(outputs).map((line) => `    ${line}`),
  ].join("\n");

  const runtimeSource = [
    functionSource,
    `__nodebook_result = ${functionName}(**{`,
    ...parameters.map((parameter) =>
      `    ${JSON.stringify(parameter)}: globals()[${
        JSON.stringify(parameter)
      }],`
    ),
    "})",
    "if not isinstance(__nodebook_result, dict):",
    "    raise TypeError('Node function must return a dict of declared outputs')",
    `__nodebook_outputs = ${JSON.stringify(outputs)}`,
    "__nodebook_missing_outputs = [",
    "    name for name in __nodebook_outputs",
    "    if name not in __nodebook_result",
    "]",
    "if __nodebook_missing_outputs:",
    "    raise NameError(",
    "        'Node function did not return declared outputs: '",
    "        + ', '.join(__nodebook_missing_outputs)",
    "    )",
    "for __nodebook_output_name in __nodebook_outputs:",
    "    globals()[__nodebook_output_name] = __nodebook_result[__nodebook_output_name]",
  ].join("\n");

  return [globalsCode.trim(), runtimeSource].filter(Boolean).join("\n\n");
}

function indentFunctionBody(code: string): string[] {
  return code.trim().length === 0 ? ["pass"] : code.split(/\r?\n/);
}

function buildReturnBody(outputs: string[]): string[] {
  if (outputs.length === 0) {
    return ["return {}"];
  }

  return [
    "return {",
    ...outputs.map((output) => `    ${JSON.stringify(output)}: ${output},`),
    "}",
  ];
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
