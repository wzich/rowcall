export type Node = {
  id: string;
  code: string;
  outputs: string[];
};

export type Edge = {
  fromNode: string;
  toNode: string;
};

export type Graph = {
  nodes: Node[];
  edges: Edge[];
};

export type RunPlanStep = {
  nodeId: string;
  dependsOn: string[];
};

export type RunPlan = {
  targetNodeIds: string[];
  steps: RunPlanStep[];
};

export type NodeRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  outputs: Record<string, unknown>;
  error?: string;
};

export type ExecutionState = Map<string, NodeRunResult>;

export type ValidationIssue = {
  kind:
    | "invalid_json"
    | "missing_field"
    | "wrong_type"
    | "duplicate_node_id"
    | "missing_node_reference"
    | "cycle"
    | "conflicting_outputs";
  message: string;
  path?: string;
  nodeId?: string;
  edgeIndex?: number;
  field?: string;
};

export type DecodeGraphResult =
  | { ok: true; graph: Graph; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

export type GraphValidationResult =
  | { ok: true; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

export type ExecutionError = {
  kind: "runtime_error" | "node_not_found" | "internal_error";
  message: string;
  nodeId?: string;
};

export type ExecutionStepTrace = {
  index: number;
  nodeId: string;
  dependsOn: string[];
  inputs: Record<string, unknown>;
  ok: boolean;
  stdout: string;
  stderr: string;
  outputs: Record<string, unknown>;
  error: string | null;
};

export type ExecutionResponse = {
  ok: boolean;
  runType: "run_node" | "run_to_node" | "run_graph";
  targetNodeId?: string;
  finalNodeIds: string[];
  executedNodeIds: string[];
  resultsByNode: Record<string, NodeRunResult>;
  finalOutputsByNode: Record<string, Record<string, unknown>>;
  trace: ExecutionStepTrace[] | null;
  error: ExecutionError | null;
};

export type ExecutionRunType = ExecutionResponse["runType"];

export type ExecutionRunStartedEvent = {
  type: "run_started";
  runId: string;
  runType: ExecutionRunType;
  targetNodeId?: string;
};

export type ExecutionRunPlanEvent = {
  type: "run_plan";
  runId: string;
  runType: ExecutionRunType;
  targetNodeId?: string;
  plan: RunPlan;
};

export type ExecutionNodeStartedEvent = {
  type: "node_started";
  runId: string;
  runType: ExecutionRunType;
  targetNodeId?: string;
  index: number;
  nodeId: string;
  dependsOn: string[];
};

export type ExecutionNodeCompletedEvent = {
  type: "node_completed";
  runId: string;
  runType: ExecutionRunType;
  targetNodeId?: string;
  index: number;
  nodeId: string;
  dependsOn: string[];
  result: NodeRunResult;
};

export type ExecutionNodeFailedEvent = {
  type: "node_failed";
  runId: string;
  runType: ExecutionRunType;
  targetNodeId?: string;
  index: number;
  nodeId: string;
  dependsOn: string[];
  result: NodeRunResult;
};

export type ExecutionRunCompletedEvent = {
  type: "run_completed";
  runId: string;
  runType: ExecutionRunType;
  targetNodeId?: string;
  response: ExecutionResponse;
};

export type ExecutionRunFailedEvent = {
  type: "run_failed";
  runId: string;
  runType: ExecutionRunType;
  targetNodeId?: string;
  response: ExecutionResponse;
};

export type ExecutionStreamEvent =
  | ExecutionRunStartedEvent
  | ExecutionRunPlanEvent
  | ExecutionNodeStartedEvent
  | ExecutionNodeCompletedEvent
  | ExecutionNodeFailedEvent
  | ExecutionRunCompletedEvent
  | ExecutionRunFailedEvent;
