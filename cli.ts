import { parseArgs } from "@std/cli/parse-args";
import { type NodebookDocumentV1, toRuntimeGraph } from "./document.ts";
import { printNodeRunResult, runGraph, runToNode } from "./executor.ts";
import { validateGraph } from "./graph.ts";
import { loadPythonDocument } from "./python_document.ts";
import { configurePythonCommand } from "./runtime_config.ts";
import type { ExecutionResponse, Graph, ValidationIssue } from "./types.ts";

type CliCommand = "validate" | "run";

type CliOptions = {
  command: CliCommand;
  documentPath: string;
  json: boolean;
  trace: boolean;
  target?: string;
  pythonCommand?: string;
};

type LoadedDocument =
  | {
    ok: true;
    document: NodebookDocumentV1;
    graph: Graph;
    documentPath: string;
  }
  | {
    ok: false;
    documentPath: string;
    issues: ValidationIssue[];
  };

type TargetResolution =
  | {
    ok: true;
    requested: string;
    nodeId: string;
    matchKind: "node_id" | "function_name";
  }
  | {
    ok: false;
    requested: string;
    message: string;
  };

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

if (import.meta.main) {
  await main(Deno.args);
}

async function main(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usageText());
    Deno.exit(0);
  }

  let parsed: CliOptions;
  try {
    parsed = parseCliOptions(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeUsageError(message, args.includes("--json"));
    Deno.exit(2);
  }

  configurePythonCommand(parsed.pythonCommand);

  if (parsed.command === "validate") {
    const ok = await handleValidate(parsed);
    Deno.exit(ok ? 0 : 1);
  }

  const ok = await handleRun(parsed);
  Deno.exit(ok ? 0 : 1);
}

function parseCliOptions(args: string[]): CliOptions {
  const parsed = parseArgs(args, {
    boolean: ["json", "trace"],
    string: ["to", "python"],
    unknown: (arg) => {
      if (arg.startsWith("-")) {
        throw new CliUsageError(`Unknown option: ${arg}`);
      }
      return true;
    },
  });

  const positionals = parsed._.map(String);
  const command = positionals[0];
  if (command !== "validate" && command !== "run") {
    throw new CliUsageError(
      command
        ? `Unknown command: ${command}`
        : "Missing command. Use `validate` or `run`.",
    );
  }

  const documentPath = positionals[1];
  if (!documentPath) {
    throw new CliUsageError(`Missing document path for ${command}.`);
  }
  if (positionals.length > 2) {
    throw new CliUsageError(
      `Unexpected extra argument: ${positionals.slice(2).join(" ")}`,
    );
  }
  if (!documentPath.endsWith(".py")) {
    throw new CliUsageError("Nodebook document path must end with .py.");
  }

  const target = getOptionalStringFlag(parsed.to, "--to");
  const pythonCommand = getOptionalStringFlag(parsed.python, "--python");

  if (command === "validate" && target) {
    throw new CliUsageError("`validate` does not accept --to.");
  }
  if (command === "validate" && parsed.trace === true) {
    throw new CliUsageError("`validate` does not accept --trace.");
  }

  return {
    command,
    documentPath,
    json: parsed.json === true,
    trace: parsed.trace === true,
    ...(target ? { target } : {}),
    ...(pythonCommand ? { pythonCommand } : {}),
  };
}

function getOptionalStringFlag(
  value: string | boolean | number | undefined,
  flagName: string,
): string | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new CliUsageError(`Invalid value for ${flagName}.`);
  }
  return value;
}

async function handleValidate(options: CliOptions): Promise<boolean> {
  const loaded = await loadDocumentForCli(options.documentPath);

  if (options.json) {
    writeJson({
      ok: loaded.ok,
      command: "validate",
      documentPath: loaded.documentPath,
      ...(loaded.ok
        ? {
          summary: {
            nodeCount: loaded.document.nodes.length,
            edgeCount: loaded.document.edges.length,
          },
        }
        : { issues: loaded.issues }),
    });
    return loaded.ok;
  }

  if (!loaded.ok) {
    console.error(`Validation failed: ${loaded.documentPath}`);
    writeIssues(loaded.issues);
    return false;
  }

  console.log(`OK ${loaded.documentPath}`);
  console.log(
    `${loaded.document.nodes.length} nodes, ${loaded.document.edges.length} edges`,
  );
  return true;
}

async function handleRun(options: CliOptions): Promise<boolean> {
  const loaded = await loadDocumentForCli(options.documentPath);
  if (!loaded.ok) {
    if (options.json) {
      writeJson({
        ok: false,
        command: "run",
        documentPath: loaded.documentPath,
        issues: loaded.issues,
      });
    } else {
      console.error(`Validation failed: ${loaded.documentPath}`);
      writeIssues(loaded.issues);
    }
    return false;
  }

  const target = options.target
    ? resolveTargetNode(loaded.document, options.target)
    : undefined;
  if (target && !target.ok) {
    if (options.json) {
      writeJson({
        ok: false,
        command: "run",
        documentPath: loaded.documentPath,
        target: {
          requested: target.requested,
        },
        error: {
          kind: "target_resolution_error",
          message: target.message,
        },
      });
    } else {
      console.error(target.message);
    }
    return false;
  }

  const response = target
    ? await runToNode(loaded.graph, target.nodeId, {}, options.trace)
    : await runGraph(loaded.graph, {}, options.trace);

  if (options.json) {
    writeJson({
      ok: response.ok,
      command: "run",
      documentPath: loaded.documentPath,
      ...(target
        ? {
          target: {
            requested: target.requested,
            nodeId: target.nodeId,
            matchKind: target.matchKind,
          },
        }
        : {}),
      response,
    });
    return response.ok;
  }

  writeRunSummary(response, loaded.document, target);
  return response.ok;
}

async function loadDocumentForCli(path: string): Promise<LoadedDocument> {
  const documentPath = await resolveDisplayPath(path);
  const loaded = await loadPythonDocument(path);
  if (!loaded.ok) {
    return { ok: false, documentPath, issues: loaded.issues };
  }

  const graph = toRuntimeGraph(loaded.document);
  const validated = validateGraph(graph);
  if (!validated.ok) {
    return { ok: false, documentPath, issues: validated.issues };
  }

  return {
    ok: true,
    document: loaded.document,
    graph,
    documentPath,
  };
}

async function resolveDisplayPath(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path;
  }
}

function resolveTargetNode(
  document: NodebookDocumentV1,
  requested: string,
): TargetResolution {
  const matches = document.nodes.flatMap((node) => {
    const nodeMatches: Array<{
      nodeId: string;
      matchKind: "node_id" | "function_name";
    }> = [];
    if (node.id === requested) {
      nodeMatches.push({ nodeId: node.id, matchKind: "node_id" });
    }
    if (node.functionName === requested) {
      nodeMatches.push({ nodeId: node.id, matchKind: "function_name" });
    }
    return nodeMatches;
  });

  if (matches.length === 0) {
    return {
      ok: false,
      requested,
      message: `Could not find a node with ID or function name '${requested}'.`,
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      requested,
      message:
        `Target '${requested}' is ambiguous. Use an exact node ID or function name.`,
    };
  }

  return {
    ok: true,
    requested,
    nodeId: matches[0].nodeId,
    matchKind: matches[0].matchKind,
  };
}

function writeRunSummary(
  response: ExecutionResponse,
  document: NodebookDocumentV1,
  target: Extract<TargetResolution, { ok: true }> | undefined,
): void {
  const labelByNodeId = new Map(
    document.nodes.map((node) => [node.id, node.functionName ?? node.id]),
  );
  const runLabel = target
    ? `run ${
      target.matchKind === "function_name" ? target.requested : target.nodeId
    }`
    : "run graph";

  console.log(`${response.ok ? "OK" : "FAILED"} ${runLabel}`);
  if (response.executedNodeIds.length > 0) {
    console.log(
      `Executed: ${
        response.executedNodeIds.map((nodeId) =>
          labelByNodeId.get(nodeId) ?? nodeId
        ).join(" -> ")
      }`,
    );
  }

  if (response.error) {
    console.error(`${response.error.kind}: ${response.error.message}`);
  }

  const finalNodeIds = response.finalNodeIds.length > 0
    ? response.finalNodeIds
    : response.executedNodeIds.slice(-1);
  for (const nodeId of finalNodeIds) {
    const result = response.resultsByNode[nodeId];
    if (!result) continue;
    console.log(`\nNode [${labelByNodeId.get(nodeId) ?? nodeId}] output:`);
    printNodeRunResult(result);
  }
}

function writeIssues(issues: ValidationIssue[]): void {
  for (const issue of issues) {
    const location = issue.path ? ` (${issue.path})` : "";
    console.error(`- ${issue.kind}${location}: ${issue.message}`);
  }
}

function writeUsageError(message: string, json: boolean): void {
  if (json) {
    writeJson({
      ok: false,
      command: null,
      error: {
        kind: "usage_error",
        message,
      },
    });
    return;
  }

  console.error(message);
  if (message !== usageText()) {
    console.error("");
    console.error(usageText());
  }
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usageText(): string {
  return [
    "Usage:",
    "  nodebook validate <document.py> [--json] [--python <python>]",
    "  nodebook run <document.py> [--to <node-id-or-function-name>] [--json] [--trace] [--python <python>]",
  ].join("\n");
}
