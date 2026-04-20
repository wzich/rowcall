import type {
  ExecutionResponse,
  ExecutionStepTrace,
  Graph,
  Node,
  NodeRunResult,
  RunPlan,
  RunPlanStep,
} from "./types.ts";

import {
  buildDownstreamAdjacency,
  buildUpstreamAdjacency,
  collectRequiredNodeIds,
  getNodeById,
  getSinkNodes,
} from "./graph.ts";

export function buildRunPlan(graph: Graph, targetNodeId: string): RunPlan {
  return buildRunPlanForTargets(graph, [targetNodeId]);
}

export async function runPythonNode(
  node: Node,
  inputs: Record<string, unknown>,
): Promise<NodeRunResult> {
  const payload = {
    code: node.code,
    outputs: node.outputs,
    inputs,
  };

  const command = new Deno.Command(
    "/opt/homebrew/Caskroom/miniconda/base/bin/python",
    {
      args: ["runner.py"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    },
  );

  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();

  const { code, stdout, stderr } = await child.output();
  const stdoutText = new TextDecoder().decode(stdout);
  const stderrText = new TextDecoder().decode(stderr);

  let result: NodeRunResult;
  try {
    result = JSON.parse(stdoutText) as NodeRunResult;
  } catch {
    throw new Error(
      `runner.py produced invalid JSON (exit code ${code}). stderr: ${stderrText}`,
    );
  }

  if (!result.ok && !result.stderr && stderrText) {
    result.stderr = stderrText;
  }

  return result;
}

export async function runToNode(
  graph: Graph,
  nodeId: string,
  inputs: Record<string, unknown> = {},
  trace: boolean = false,
): Promise<ExecutionResponse> {
  const runPlan = buildRunPlan(graph, nodeId);
  const result = await executeRunPlan(
    graph,
    runPlan,
    inputs,
    trace,
    "run_to_node",
    nodeId,
  );

  return result;
}

export function buildRunPlanForTargets(
  graph: Graph,
  targetNodeIds: string[],
): RunPlan {
  const required = new Set<string>();

  for (const nodeId of targetNodeIds) {
    const nodeRequirements = collectRequiredNodeIds(graph, nodeId);
    for (const requiredNodeId of nodeRequirements) {
      required.add(requiredNodeId);
    }
  }

  const upstream = buildUpstreamAdjacency(graph);
  const downstream = buildDownstreamAdjacency(graph);

  const dependsOn = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of required) {
    const parents = (upstream.get(node) ?? []).filter((parent) =>
      required.has(parent)
    );
    dependsOn.set(node, parents);
    inDegree.set(node, parents.length);
  }

  const queue: string[] = [];

  for (const node of required) {
    if (inDegree.get(node) === 0) {
      queue.push(node);
    }
  }

  const steps: RunPlanStep[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;

    steps.push({
      nodeId,
      dependsOn: dependsOn.get(nodeId) ?? [],
    });

    for (const childId of downstream.get(nodeId) ?? []) {
      if (!required.has(childId)) continue;

      const nextInDegree = inDegree.get(childId)! - 1;
      inDegree.set(childId, nextInDegree);

      if (nextInDegree === 0) {
        queue.push(childId);
      }
    }
  }

  if (steps.length !== required.size) {
    throw new Error("Could not build run plan");
  }

  return { targetNodeIds, steps };
}

export async function runGraph(
  graph: Graph,
  userInputs: Record<string, unknown> = {},
  trace: boolean = false,
): Promise<ExecutionResponse> {
  const sinks = getSinkNodes(graph);
  const runPlan = buildRunPlanForTargets(graph, [...sinks]);

  const result = await executeRunPlan(
    graph,
    runPlan,
    userInputs,
    trace,
    "run_graph",
  );

  return result;
}

async function executeRunPlan(
  graph: Graph,
  runPlan: RunPlan,
  userInputs: Record<string, unknown> = {},
  traceEnabled: boolean = false,
  runType: "run_node" | "run_to_node" | "run_graph",
  targetNodeId: string | undefined = undefined,
): Promise<ExecutionResponse> {
  const resultsByNode: Record<string, NodeRunResult> = {};
  const executedNodeIds: string[] = [];
  const trace: ExecutionStepTrace[] | null = traceEnabled ? [] : null;

  for (const [index, step] of runPlan.steps.entries()) {
    const node = getNodeById(graph, step.nodeId);
    const inputs = step.dependsOn.length === 0
      ? userInputs
      : buildInputsForStep(step, resultsByNode);

    const result = await runPythonNode(node, inputs);

    resultsByNode[step.nodeId] = result;
    executedNodeIds.push(step.nodeId);

    trace?.push({
      index,
      nodeId: step.nodeId,
      dependsOn: step.dependsOn,
      inputs,
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr,
      outputs: result.outputs,
      error: result.error ?? null,
    });

    if (!result.ok) {
      return {
        ok: false,
        runType,
        targetNodeId,
        finalNodeIds: runPlan.targetNodeIds,
        executedNodeIds,
        resultsByNode,
        finalOutputsByNode: buildFinalOutputsByNode(
          runPlan.targetNodeIds,
          resultsByNode,
        ),
        trace,
        error: {
          kind: "runtime_error",
          message: `Failed execution at node ${step.nodeId}`,
          nodeId: step.nodeId,
        },
      };
    }
  }

  return {
    ok: true,
    runType,
    targetNodeId,
    finalNodeIds: runPlan.targetNodeIds,
    executedNodeIds,
    resultsByNode,
    finalOutputsByNode: buildFinalOutputsByNode(
      runPlan.targetNodeIds,
      resultsByNode,
    ),
    trace,
    error: null,
  };
}

function buildFinalOutputsByNode(
  targetNodeIds: string[],
  resultsByNode: Record<string, NodeRunResult>,
) {
  return Object.fromEntries(
    targetNodeIds
      .filter((nodeId) => resultsByNode[nodeId])
      .map((nodeId) => [nodeId, resultsByNode[nodeId].outputs]),
  );
}

function buildInputsForStep(
  step: RunPlanStep,
  executionState: Record<string, NodeRunResult>,
) {
  const neededOutputs = step.dependsOn.map((dependency) =>
    getRequiredExecutionResult(executionState, dependency, step.nodeId)
      .outputs
  );
  return Object.assign({}, ...neededOutputs);
}

export function printNodeRunResult(result: NodeRunResult): void {
  console.log(result.ok ? "✔︎" : "✖︎");
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.log(result.stderr);
  console.log("outputs:");
  console.log(result.outputs);

  if (!result.ok && result.error) {
    console.log(`error: ${result.error}`);
  }
}

function getRequiredExecutionResult(
  resultsByNode: Record<string, NodeRunResult>,
  dependencyNodeId: string,
  consumerNodeId: string,
): NodeRunResult {
  const result = resultsByNode[dependencyNodeId];
  if (!result) {
    throw new Error(
      `Missing execution result for dependency ${dependencyNodeId} needed by ${consumerNodeId}`,
    );
  }
  return result;
}

export async function runSingleNode(
  node: Node,
  inputs: Record<string, unknown> = {},
  traceEnabled = false,
): Promise<ExecutionResponse> {
  const result = await runPythonNode(node, inputs);

  return {
    ok: result.ok,
    runType: "run_node",
    targetNodeId: node.id,
    finalNodeIds: [node.id],
    executedNodeIds: [node.id],
    resultsByNode: {
      [node.id]: result,
    },
    finalOutputsByNode: result.ok ? { [node.id]: result.outputs } : {},
    trace: traceEnabled
      ? [{
        index: 0,
        nodeId: node.id,
        dependsOn: [],
        inputs,
        ok: result.ok,
        stdout: result.stdout,
        stderr: result.stderr,
        outputs: result.outputs,
        error: result.error ?? null,
      }]
      : null,
    error: result.ok ? null : {
      kind: "runtime_error",
      message: `Failed execution at node ${node.id}`,
      nodeId: node.id,
    },
  };
}
