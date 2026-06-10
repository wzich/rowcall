import {
  type DocumentNode,
  type GraphPosition,
  type NodebookDocumentV1,
  type PythonSourceRange,
} from "./document.ts";
import type { ValidationIssue } from "./types.ts";

type PythonLoaderSuccess = {
  ok: true;
  document: NodebookDocumentV1;
};

type PythonLoaderFailure = {
  ok: false;
  issues: ValidationIssue[];
};

type PythonLoaderResult = PythonLoaderSuccess | PythonLoaderFailure;

export type LoadPythonDocumentResult =
  | { ok: true; document: NodebookDocumentV1; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

export type SavePythonDocumentResult =
  | { ok: true; document: NodebookDocumentV1; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

export async function loadPythonDocument(
  path: string,
): Promise<LoadPythonDocumentResult> {
  const command = new Deno.Command(await resolvePythonCommand(), {
    args: ["python_document_loader.py", path],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);

  if (!output.success) {
    return {
      ok: false,
      issues: [{
        kind: "invalid_python",
        message: stderr.trim() || "Python document loader failed",
      }],
    };
  }

  let result: PythonLoaderResult;
  try {
    result = JSON.parse(stdout) as PythonLoaderResult;
  } catch {
    return {
      ok: false,
      issues: [{
        kind: "invalid_python",
        message: "Python document loader returned invalid JSON",
      }],
    };
  }

  if (!result.ok) {
    return { ok: false, issues: result.issues };
  }

  const documentWithSidecar = await applySidecarMetadata(path, result.document);
  return { ok: true, document: documentWithSidecar, issues: [] };
}

export function sidecarPathForPythonDocument(path: string): string {
  return path.endsWith(".py")
    ? `${path.slice(0, -3)}.nodebook.json`
    : `${path}.nodebook.json`;
}

export async function savePythonDocument(
  path: string,
  document: NodebookDocumentV1,
): Promise<SavePythonDocumentResult> {
  const loaded = await loadPythonDocument(path);
  if (!loaded.ok) {
    return loaded;
  }

  if (!document.revision || document.revision !== loaded.document.revision) {
    return {
      ok: false,
      issues: [{
        kind: "stale_document",
        message:
          "The Python document changed on disk after it was loaded. Reload before saving.",
      }],
    };
  }

  const issues = validateEditableSave(loaded.document, document);
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  await writePythonDocument(path, loaded.document, document);
  await writeSidecar(path, document);

  return await loadPythonDocument(path);
}

type SidecarNodeMetadata = {
  position?: GraphPosition;
  title?: string;
  description?: string;
};

async function applySidecarMetadata(
  path: string,
  document: NodebookDocumentV1,
): Promise<NodebookDocumentV1> {
  const sidecarPath = sidecarPathForPythonDocument(path);
  const metadataByNodeId = await loadSidecarNodeMetadata(sidecarPath);
  if (metadataByNodeId.size === 0) {
    return document;
  }

  return {
    ...document,
    nodes: document.nodes.map((node) => {
      const metadata = metadataByNodeId.get(node.id);
      return metadata ? { ...node, ...metadata } : node;
    }),
  };
}

async function loadSidecarNodeMetadata(
  path: string,
): Promise<Map<string, SidecarNodeMetadata>> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Map();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map();
  }

  const record = asRecord(parsed);
  const nodes = Array.isArray(record?.["nodes"]) ? record["nodes"] : [];
  if (!Array.isArray(nodes)) {
    return new Map();
  }

  return new Map(
    nodes.flatMap((node) => {
      const nodeRecord = asRecord(node);
      if (!nodeRecord) {
        return [];
      }

      const nodeId = nodeRecord["id"];
      if (typeof nodeId !== "string") {
        return [];
      }

      const positionRecord = asRecord(nodeRecord["position"]);
      const metadata: SidecarNodeMetadata = {};
      if (
        typeof positionRecord?.["x"] === "number" &&
        typeof positionRecord?.["y"] === "number"
      ) {
        metadata.position = { x: positionRecord["x"], y: positionRecord["y"] };
      }
      if (typeof nodeRecord["title"] === "string") {
        metadata.title = nodeRecord["title"];
      }
      if (typeof nodeRecord["description"] === "string") {
        metadata.description = nodeRecord["description"];
      }

      if (Object.keys(metadata).length === 0) {
        return [];
      }

      return [[
        nodeId,
        metadata,
      ]];
    }),
  );
}

function validateEditableSave(
  loaded: NodebookDocumentV1,
  next: NodebookDocumentV1,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const loadedNodesById = new Map(loaded.nodes.map((node) => [node.id, node]));
  const nextNodesById = new Map(next.nodes.map((node) => [node.id, node]));
  const addedNodeIds = new Set(
    next.nodes
      .filter((node) => !loadedNodesById.has(node.id))
      .map((node) => node.id),
  );
  const deletedNodeIds = new Set(
    loaded.nodes
      .filter((node) => !nextNodesById.has(node.id))
      .map((node) => node.id),
  );
  const nextNodeIds = next.nodes.map((node) => node.id);
  const retainedNodeIds = nextNodeIds.filter((id) => loadedNodesById.has(id));
  const loadedRetainedNodeIds = loaded.nodes
    .map((node) => node.id)
    .filter((id) => nextNodesById.has(id));

  if (!areStringArraysEqual(retainedNodeIds, loadedRetainedNodeIds)) {
    issues.push({
      kind: "unsupported_python",
      message: "Reordering existing Python nodes is not supported yet.",
    });
  }

  validateUniqueNodeFields(next, issues);
  validateEdgeChanges(loaded, next, addedNodeIds, deletedNodeIds, issues);

  for (const [nodeId, loadedNode] of loadedNodesById) {
    const nextNode = nextNodesById.get(nodeId);
    if (!nextNode) continue;

    if (!areStringArraysEqual(loadedNode.outputs, nextNode.outputs)) {
      if (loadedNode.customReturn) {
        issues.push({
          kind: "unsupported_python",
          message:
            `Custom-return node ${nodeId} cannot edit outputs in the canvas yet.`,
          nodeId,
        });
      } else {
        validateOutputNames(nextNode, issues);
      }
    }

    if (
      loadedNode.functionName !== nextNode.functionName ||
      !areStringArraysEqual(
        loadedNode.parameters ?? [],
        nextNode.parameters ?? [],
      )
    ) {
      issues.push({
        kind: "unsupported_python",
        message:
          `Editing function names or parameters is not supported yet for node ${nodeId}.`,
        nodeId,
      });
    }

    if (loadedNode.customReturn && loadedNode.code !== nextNode.code) {
      issues.push({
        kind: "unsupported_python",
        message:
          `Custom-return node ${nodeId} cannot be edited in the canvas yet.`,
        nodeId,
      });
    }
  }

  for (const node of next.nodes) {
    if (!addedNodeIds.has(node.id)) continue;

    validateAddedNode(node, issues);
  }

  return issues;
}

function validateUniqueNodeFields(
  document: NodebookDocumentV1,
  issues: ValidationIssue[],
): void {
  const nodeIds = new Set<string>();
  const functionNames = new Set<string>();

  for (const node of document.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        kind: "duplicate_node_id",
        message: `Node ID '${node.id}' is not unique`,
        nodeId: node.id,
      });
    }
    nodeIds.add(node.id);

    if (!node.functionName) {
      continue;
    }
    if (functionNames.has(node.functionName)) {
      issues.push({
        kind: "duplicate_function_name",
        message: `Node function '${node.functionName}' is not unique`,
        nodeId: node.id,
      });
    }
    functionNames.add(node.functionName);
  }
}

function validateAddedNode(
  node: DocumentNode,
  issues: ValidationIssue[],
): void {
  if (!node.id.startsWith("n_")) {
    issues.push({
      kind: "unsupported_python",
      message: `New Python node ${node.id} must use an n_ ID prefix.`,
      nodeId: node.id,
    });
  }

  if (!node.functionName || !isValidPythonIdentifier(node.functionName)) {
    issues.push({
      kind: "unsupported_python",
      message:
        `New Python node ${node.id} must have a valid Python function name.`,
      nodeId: node.id,
    });
  }

  if ((node.parameters ?? []).length > 0) {
    issues.push({
      kind: "unsupported_python",
      message:
        `New Python node ${node.id} cannot define parameters in this editing pass.`,
      nodeId: node.id,
    });
  }

  validateOutputNames(node, issues);

  if (node.customReturn) {
    issues.push({
      kind: "unsupported_python",
      message: `New Python node ${node.id} cannot use a custom return yet.`,
      nodeId: node.id,
    });
  }
}

function validateOutputNames(
  node: DocumentNode,
  issues: ValidationIssue[],
): void {
  const seenOutputs = new Set<string>();
  for (const output of node.outputs) {
    if (!isValidPythonIdentifier(output)) {
      issues.push({
        kind: "unsupported_python",
        message:
          `Output '${output}' on node ${node.id} must be a valid Python variable name.`,
        nodeId: node.id,
      });
    }

    if (seenOutputs.has(output)) {
      issues.push({
        kind: "unsupported_python",
        message:
          `Output '${output}' is declared more than once on node ${node.id}.`,
        nodeId: node.id,
      });
    }
    seenOutputs.add(output);
  }
}

function validateEdgeChanges(
  loaded: NodebookDocumentV1,
  next: NodebookDocumentV1,
  addedNodeIds: Set<string>,
  deletedNodeIds: Set<string>,
  issues: ValidationIssue[],
): void {
  const nextNodeIds = new Set(next.nodes.map((node) => node.id));
  const loadedEdgeIds = new Set(loaded.edges.map(edgeKey));
  const nextEdgeIds = new Set(next.edges.map(edgeKey));

  for (const edge of next.edges) {
    if (!nextNodeIds.has(edge.fromNode) || !nextNodeIds.has(edge.toNode)) {
      issues.push({
        kind: "missing_node_reference",
        message:
          `Edge ${edge.fromNode}->${edge.toNode} references a missing node.`,
      });
    }
  }

  for (const edge of next.edges) {
    const key = edgeKey(edge);
    if (
      next.edges.filter((candidate) => edgeKey(candidate) === key).length > 1
    ) {
      issues.push({
        kind: "unsupported_python",
        message: `Duplicate edge ${key} is not supported.`,
      });
    }
  }

  for (const edge of loaded.edges) {
    if (nextEdgeIds.has(edgeKey(edge))) continue;
    if (deletedNodeIds.has(edge.fromNode) || deletedNodeIds.has(edge.toNode)) {
      continue;
    }

    issues.push({
      kind: "unsupported_python",
      message:
        `Removing edge ${edge.fromNode}->${edge.toNode} is not supported in this pass.`,
    });
  }

  for (const edge of next.edges) {
    if (loadedEdgeIds.has(edgeKey(edge))) continue;
    if (addedNodeIds.has(edge.toNode)) continue;

    issues.push({
      kind: "unsupported_python",
      message:
        `Adding edge ${edge.fromNode}->${edge.toNode} is only supported for newly added child nodes.`,
    });
  }
}

async function writePythonDocument(
  path: string,
  loaded: NodebookDocumentV1,
  next: NodebookDocumentV1,
): Promise<void> {
  const structureChanged = hasStructureChanged(loaded, next);
  if (!structureChanged) {
    await writePythonNodeBodies(path, loaded, next);
    return;
  }

  const original = await Deno.readTextFile(path);
  const sourceLines = original.split(/\r?\n/);
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const loadedNodesById = new Map(loaded.nodes.map((node) => [node.id, node]));
  const nextNodesById = new Map(next.nodes.map((node) => [node.id, node]));
  const addedNodes = next.nodes.filter((node) => !loadedNodesById.has(node.id));
  const deletedNodes = loaded.nodes.filter((node) =>
    !nextNodesById.has(node.id)
  );

  applyStructureSourceEdits(sourceLines, loaded, next, deletedNodes);
  const withoutGraphBlock = stripGeneratedGraphBlock(sourceLines);

  const appendedBlocks = [
    ...addedNodes.map((node) => renderNewNodeBlock(node)),
    renderGraphBlock(next, newline),
  ].filter((block) => block.length > 0);

  const text = appendBlocks(
    withoutGraphBlock.join(newline),
    appendedBlocks,
    newline,
  );
  await Deno.writeTextFile(path, text);
}

async function writePythonNodeBodies(
  path: string,
  loaded: NodebookDocumentV1,
  next: NodebookDocumentV1,
): Promise<void> {
  const original = await Deno.readTextFile(path);
  const sourceLines = original.split(/\r?\n/);
  const newline = original.includes("\r\n") ? "\r\n" : "\n";

  applyBodyReplacements(sourceLines, loaded, next);
  await Deno.writeTextFile(path, sourceLines.join(newline));
}

function applyBodyReplacements(
  sourceLines: string[],
  loaded: NodebookDocumentV1,
  next: NodebookDocumentV1,
): void {
  for (const edit of bodyReplacementEdits(sourceLines, loaded, next)) {
    applySourceEdit(sourceLines, edit);
  }
}

function applyStructureSourceEdits(
  sourceLines: string[],
  loaded: NodebookDocumentV1,
  next: NodebookDocumentV1,
  deletedNodes: DocumentNode[],
): void {
  const deletionEdits = deletedNodes.map((node) => ({
    ...sourceRangeForNode(sourceLines, node),
    replacementLines: [],
  }));
  const edits = [
    ...bodyReplacementEdits(sourceLines, loaded, next),
    ...deletionEdits,
  ].sort((a, b) => b.startLine - a.startLine);

  for (const edit of edits) {
    applySourceEdit(sourceLines, edit);
  }
}

type SourceEdit = {
  startLine: number;
  endLine: number;
  replacementLines: string[];
};

function bodyReplacementEdits(
  sourceLines: string[],
  loaded: NodebookDocumentV1,
  next: NodebookDocumentV1,
): SourceEdit[] {
  const nextNodesById = new Map(
    next.nodes.map((node) => [node.id, node]),
  );
  const nextNodeIds = new Set(next.nodes.map((node) => node.id));
  const ranges = findEditableBodyRanges(
    sourceLines,
    loaded.nodes.filter((node) => nextNodeIds.has(node.id)),
  );
  const edits: SourceEdit[] = [];

  for (const range of ranges) {
    const node = nextNodesById.get(range.nodeId);
    if (!node) continue;
    const indentedBody = [
      ...indentNodeBody(node.code, range.indent),
      renderReturnLine(node.outputs, range.indent),
    ];
    edits.push({
      startLine: range.startLine,
      endLine: range.returnLine,
      replacementLines: indentedBody,
    });

    edits.push({
      startLine: range.decoratorLine,
      endLine: range.decoratorLine,
      replacementLines: [renderDecoratorLine(node)],
    });
  }

  return edits.sort((a, b) => b.startLine - a.startLine);
}

function applySourceEdit(lines: string[], edit: SourceEdit): void {
  const deleteCount = Math.max(0, edit.endLine - edit.startLine + 1);
  lines.splice(edit.startLine - 1, deleteCount, ...edit.replacementLines);
}

type BodyRange = {
  nodeId: string;
  decoratorLine: number;
  startLine: number;
  endLine: number;
  returnLine: number;
  indent: string;
};

function findEditableBodyRanges(
  lines: string[],
  nodes: DocumentNode[],
): BodyRange[] {
  const ranges: BodyRange[] = [];

  for (const node of nodes) {
    if (node.customReturn || !node.functionName) continue;

    if (hasEditableSourceRange(node.sourceRange)) {
      ranges.push({
        nodeId: node.id,
        decoratorLine: node.sourceRange.decoratorLine ??
          node.sourceRange.startLine,
        startLine: node.sourceRange.bodyStartLine,
        endLine: node.sourceRange.bodyEndLine,
        returnLine: node.sourceRange.returnEndLine ??
          node.sourceRange.returnLine ?? node.sourceRange.bodyEndLine + 1,
        indent: node.sourceRange.indent ?? "    ",
      });
      continue;
    }

    const decoratorLineIndex = lines.findIndex((line) =>
      line.includes("@node") &&
      (line.includes(`id="${node.id}"`) || line.includes(`id='${node.id}'`))
    );
    if (decoratorLineIndex < 0) {
      throw new Error(`Could not find decorator for node ${node.id}`);
    }

    const functionLineIndex = lines.findIndex((line, index) =>
      index > decoratorLineIndex &&
      line.trimStart().startsWith(`def ${node.functionName}(`)
    );
    if (functionLineIndex < 0) {
      throw new Error(`Could not find function for node ${node.id}`);
    }

    const returnLineIndex = lines.findIndex((line, index) =>
      index > functionLineIndex &&
      line.trimStart().startsWith("return {")
    );
    if (returnLineIndex < 0) {
      throw new Error(`Could not find generated return for node ${node.id}`);
    }

    const bodyStartLine = functionLineIndex + 2;
    const bodyEndLine = returnLineIndex;
    const indent = lines[returnLineIndex].match(/^\s*/)?.[0] ?? "    ";
    ranges.push({
      nodeId: node.id,
      decoratorLine: decoratorLineIndex + 1,
      startLine: bodyStartLine,
      endLine: bodyEndLine,
      returnLine: returnLineIndex + 1,
      indent,
    });
  }

  return ranges;
}

function sourceRangeForNode(
  lines: string[],
  node: DocumentNode,
): { startLine: number; endLine: number } {
  if (node.sourceRange) {
    return {
      startLine: node.sourceRange.startLine,
      endLine: node.sourceRange.endLine,
    };
  }

  if (!node.functionName) {
    throw new Error(`Could not find source range for node ${node.id}`);
  }

  const decoratorLineIndex = lines.findIndex((line) =>
    line.includes("@node") &&
    (line.includes(`id="${node.id}"`) || line.includes(`id='${node.id}'`))
  );
  if (decoratorLineIndex < 0) {
    throw new Error(`Could not find decorator for node ${node.id}`);
  }

  const functionLineIndex = lines.findIndex((line, index) =>
    index > decoratorLineIndex &&
    line.trimStart().startsWith(`def ${node.functionName}(`)
  );
  if (functionLineIndex < 0) {
    throw new Error(`Could not find function for node ${node.id}`);
  }

  const nextTopLevelLineIndex = lines.findIndex((line, index) =>
    index > functionLineIndex && line.trim().length > 0 &&
    !line.startsWith(" ") && !line.startsWith("\t")
  );

  return {
    startLine: decoratorLineIndex + 1,
    endLine: nextTopLevelLineIndex < 0 ? lines.length : nextTopLevelLineIndex,
  };
}

function stripGeneratedGraphBlock(lines: string[]): string[] {
  return lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed === "# NodeBook graph") {
      return false;
    }
    return !/^[A-Za-z_][A-Za-z0-9_]*\.depends_on\(/.test(trimmed);
  });
}

function renderNewNodeBlock(node: DocumentNode): string {
  const functionName = node.functionName;
  if (!functionName) {
    throw new Error(`New node ${node.id} is missing a functionName`);
  }

  const bodyLines = indentNodeBody(node.code, "    ");
  return [
    renderDecoratorLine(node),
    `def ${functionName}():`,
    ...bodyLines,
    renderReturnLine(node.outputs, "    "),
  ].join("\n");
}

function renderDecoratorLine(node: DocumentNode): string {
  return `@node(id=${JSON.stringify(node.id)}, outputs=${
    renderStringList(node.outputs)
  })`;
}

function renderReturnLine(outputs: string[], indent: string): string {
  if (outputs.length === 0) {
    return `${indent}return {}`;
  }

  const entries = outputs.map((output) =>
    `${JSON.stringify(output)}: ${output}`
  );
  return `${indent}return {${entries.join(", ")}}`;
}

function renderStringList(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function renderGraphBlock(
  document: NodebookDocumentV1,
  newline: string,
): string {
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]));
  const edgeLines = document.edges.flatMap((edge) => {
    const upstream = nodesById.get(edge.fromNode);
    const downstream = nodesById.get(edge.toNode);
    if (!upstream?.functionName || !downstream?.functionName) {
      return [];
    }

    return [`${downstream.functionName}.depends_on(${upstream.functionName})`];
  });

  if (edgeLines.length === 0) {
    return "# NodeBook graph";
  }

  return ["# NodeBook graph", ...edgeLines].join(newline);
}

function appendBlocks(text: string, blocks: string[], newline: string): string {
  const trimmedText = text.replace(/[ \t]*(\r?\n)*$/, "");
  const suffix = blocks.join(`${newline}${newline}`);

  if (trimmedText.length === 0) {
    return `${suffix}${newline}`;
  }

  return `${trimmedText}${newline}${newline}${suffix}${newline}`;
}

function indentNodeBody(body: string, indent: string): string[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const content = lines.length === 1 && lines[0].trim().length === 0
    ? ["pass"]
    : lines;

  return content.map((line) => line.length === 0 ? "" : `${indent}${line}`);
}

function hasEditableSourceRange(
  range: PythonSourceRange | undefined,
): range is PythonSourceRange & {
  bodyStartLine: number;
  bodyEndLine: number;
} {
  return typeof range?.bodyStartLine === "number" &&
    typeof range.bodyEndLine === "number";
}

function hasStructureChanged(
  loaded: NodebookDocumentV1,
  next: NodebookDocumentV1,
): boolean {
  return !areStringArraysEqual(
    loaded.nodes.map((node) => node.id),
    next.nodes.map((node) => node.id),
  ) || JSON.stringify(loaded.edges) !== JSON.stringify(next.edges);
}

function edgeKey(edge: { fromNode: string; toNode: string }): string {
  return `${edge.fromNode}->${edge.toNode}`;
}

function isValidPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !PYTHON_KEYWORDS.has(value);
}

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

async function writeSidecar(
  path: string,
  document: NodebookDocumentV1,
): Promise<void> {
  const sidecar = {
    version: 1,
    nodes: document.nodes.flatMap((node) => {
      const metadata = {
        id: node.id,
        ...(node.position ? { position: node.position } : {}),
        ...(node.title?.trim() ? { title: node.title.trim() } : {}),
        ...(node.description?.trim()
          ? { description: node.description.trim() }
          : {}),
      };

      return Object.keys(metadata).length > 1 ? [metadata] : [];
    }),
  };
  await Deno.writeTextFile(
    sidecarPathForPythonDocument(path),
    `${JSON.stringify(sidecar, null, 2)}\n`,
  );
}

function areStringArraysEqual(first: string[], second: string[]): boolean {
  if (first.length !== second.length) {
    return false;
  }

  return first.every((value, index) => value === second[index]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

async function resolvePythonCommand(): Promise<string> {
  for (const command of ["python3", "python"]) {
    const probe = new Deno.Command(command, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    const output = await probe.output().catch(() => null);
    if (output?.success) {
      return command;
    }
  }

  return "python3";
}
