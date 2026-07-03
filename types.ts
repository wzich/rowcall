export type Node = {
  id: string;
  code: string;
  codeKind?: "body" | "runtime";
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

export type ValuePreview = {
  name: string;
  type: string;
  repr: string;
  jsonValue?: unknown;
  table?: TablePreview;
  warning?: string;
};

export type TableCellPreview =
  | string
  | number
  | boolean
  | null
  | { kind: "nan" }
  | { kind: "datetime"; value: string }
  | { kind: "repr"; value: string };

export type TablePreview = {
  columns: Array<{
    name: string;
    dtype?: string;
  }>;
  rows: TableCellPreview[][];
  index?: TableCellPreview[];
  rowCount: number;
  columnCount: number;
  truncated: boolean;
};

export type DisplayPreview = {
  value: ValuePreview;
};

export type OutputEvent =
  | { kind: "stdout"; text: string }
  | { kind: "display"; value: ValuePreview };

export type NodeRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  outputs: Record<string, ValuePreview>;
  displays: DisplayPreview[];
  outputEvents: OutputEvent[];
  warnings: string[];
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
    | "conflicting_outputs"
    | "invalid_python"
    | "stale_document"
    | "duplicate_function_name"
    | "unsupported_python"
    | "unsupported_version";
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
  kind:
    | "runtime_error"
    | "node_not_found"
    | "internal_error"
    | "cache_miss"
    | "invalid_request";
  message: string;
  nodeId?: string;
};

export type ExecutionStepTrace = {
  index: number;
  nodeId: string;
  dependsOn: string[];
  inputs: Record<string, ValuePreview>;
  ok: boolean;
  stdout: string;
  stderr: string;
  outputs: Record<string, ValuePreview>;
  displays: DisplayPreview[];
  outputEvents: OutputEvent[];
  warnings: string[];
  error: string | null;
};

export type ExecutionResponse = {
  ok: boolean;
  runType: "run_node" | "run_to_node" | "run_graph";
  targetNodeId?: string;
  finalNodeIds: string[];
  executedNodeIds: string[];
  resultsByNode: Record<string, NodeRunResult>;
  finalOutputsByNode: Record<string, Record<string, ValuePreview>>;
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
