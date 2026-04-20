import type { Graph } from "./types.ts";
import { assertNodeExists, getNodeById, getSinkNodes } from "./graph.ts";
import {
  buildRunPlan,
  buildRunPlanForTargets,
  printNodeRunResult,
  runGraph,
  runPythonNode,
  runToNode,
} from "./executor.ts";
import { parseArgs } from "@std/cli/parse-args";
import { loadValidatedGraph } from "./utils.ts";

const parsedArgs = parseArgs(Deno.args, { "--": true });
const positionals = [
  ...parsedArgs._.map(String),
  ...(parsedArgs["--"] ?? []).map(String),
];

const [command, ...rest] = positionals;

switch (command) {
  case "hello": {
    console.log(`Hello... ${rest.join(" ")}`);
    break;
  }

  case "show": {
    // Step 1: Parse arguments
    if (rest.length < 1) {
      throw new Error("Must provide file path after `show`");
    }
    const path = rest[0];
    console.log(`Showing: ${path}`);
    const graph = await loadValidatedGraph(path);
    showGraph(graph);
    break;
  }

  case "plan": {
    if (rest.length < 2) {
      throw new Error(
        "Missing arguments for plan (need path to graph and node id)",
      );
    }
    const path = rest[0];
    const targetNodeId = rest[1];
    const graph = await loadValidatedGraph(path);
    assertNodeExists(graph, targetNodeId);
    console.info(`Run plan for ${targetNodeId}`);
    console.log(buildRunPlan(graph, targetNodeId));
    break;
  }

  case "plan-graph": {
    if (rest.length < 1) {
      throw new Error("Missing path to graph");
    }

    const path = rest[0];
    const graph = await loadValidatedGraph(path);
    const sinks = getSinkNodes(graph);
    console.info(`Run plan for graph at ${path}`);
    console.log(buildRunPlanForTargets(graph, [...sinks]));

    break;
  }

  case "run-node": {
    const path = getRequiredGraphPath(rest, "run-node");
    const nodeId = getRequiredStringFlag(parsedArgs["node"], "--node");
    const inputs = await resolveInputs(
      parsedArgs["inputs"],
      parsedArgs["inputs-file"],
    );
    const graph = await loadValidatedGraph(path);
    assertNodeExists(graph, nodeId);
    const node = getNodeById(graph, nodeId);
    console.log(`Running node ${node.id} with inputs:`);
    console.log(inputs);
    console.log();
    const result = await runPythonNode(node, inputs);
    if (!result.ok) {
      console.error("run-node failed");
      console.error(result.error);
      break;
    }
    printNodeRunResult(result);

    break;
  }

  case "run-to-node": {
    const path = getRequiredGraphPath(rest, "run-to-node");
    const nodeId = getRequiredStringFlag(parsedArgs["node"], "--node");
    const inputs = await resolveInputs(
      parsedArgs["inputs"],
      parsedArgs["inputs-file"],
    );
    const trace = parsedArgs["trace"] === true;
    const graph = await loadValidatedGraph(path);
    assertNodeExists(graph, nodeId);

    const results = await runToNode(
      graph,
      nodeId,
      inputs,
      trace,
    );

    if (!results.ok) {
      console.error("run-to-node failed");
      console.error(results.error);
      break;
    }

    console.log(`\nNode [${nodeId}] output:`);
    printNodeRunResult(results.resultsByNode[nodeId]!);

    break;
  }

  case "run-graph": {
    const path = getRequiredGraphPath(rest, "run-graph");
    const inputs = await resolveInputs(
      parsedArgs["inputs"],
      parsedArgs["inputs-file"],
    );
    const trace = parsedArgs["trace"] === true;
    const graph = await loadValidatedGraph(path);

    const sinks = getSinkNodes(graph);
    const results = await runGraph(
      graph,
      inputs,
      trace,
    );

    if (!results.ok) {
      console.error("run-graph failed");
      console.error(results.error);
      break;
    }

    for (const sink of sinks) {
      console.log(`\nNode [${sink}] output:`);
      printNodeRunResult(results.resultsByNode[sink]!);
    }

    break;
  }

  default:
    throw new Error(`Unknown command: ${command}`);
}

export function showGraph(graph: Graph) {
  console.log(`Nodes: ${graph.nodes.map((node) => node.id).join(", ")}`);
  console.log(
    `Edges: ${
      graph.edges.map((edge) => `${edge.fromNode} -> ${edge.toNode}`).join(", ")
    }`,
  );
}

function getRequiredGraphPath(rest: string[], command: string): string {
  const path = rest[0];
  if (!path) {
    throw new Error(`Missing graph path for ${command}`);
  }
  return path;
}

function getRequiredStringFlag(
  value: string | boolean | number | undefined,
  flagName: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required ${flagName} flag`);
  }
  return value;
}

function parseInputsArg(
  raw: string | boolean | number | undefined,
): Record<string, unknown> {
  if (raw === undefined) {
    return {};
  }

  if (typeof raw !== "string") {
    throw new Error("--inputs must be a JSON object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for --inputs: ${message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--inputs must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

function getOptionalStringFlag(
  value: string | boolean | number | undefined,
  flagName: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid value for ${flagName}`);
  }
  return value;
}

async function resolveInputs(
  rawInputs: string | boolean | number | undefined,
  rawInputsFile: string | boolean | number | undefined,
): Promise<Record<string, unknown>> {
  const hasInlineInputs = rawInputs !== undefined;
  const inputFilePath = getOptionalStringFlag(rawInputsFile, "--inputs-file");

  if (hasInlineInputs && inputFilePath) {
    throw new Error("Use only one of --inputs and --inputs-file");
  }

  if (inputFilePath) {
    const fileContents = await Deno.readTextFile(inputFilePath);
    return parseInputsArg(fileContents);
  }

  return parseInputsArg(rawInputs);
}
