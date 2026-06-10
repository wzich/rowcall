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
        title,
        description,
        parameters,
        customReturn,
        editable,
        outputs,
        position,
      },
    ) => ({
      id,
      code: runtimeCode ??
        buildRuntimeCode({
          globalsCode: document.globalsCode ?? "",
          code,
          functionName,
          parameters,
          outputs,
          customReturn,
        }),
      runtimeCode,
      functionName,
      title,
      description,
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
      `    ${JSON.stringify(parameter)}: globals()[${JSON.stringify(parameter)}],`
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
