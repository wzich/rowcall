export type Edge = {
  fromNode: string;
  toNode: string;
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
  | { kind: "integer"; value: string }
  | { kind: "repr"; value: string };

export type TablePreview = {
  columns: Array<{
    name: string;
    dtype?: string;
  }>;
  rows: TableCellPreview[][];
  index?: TableCellPreview[];
  indexLabel?: string;
  rowCount: number;
  columnCount: number;
  truncated: boolean;
};

export type ResultStoreIdentity = {
  runId: string;
  documentRevision: string;
};

export type TableSort =
  | { kind: "index"; descending: boolean }
  | { kind: "column"; columnIndex: number; descending: boolean };

export type TableQueryRequest = ResultStoreIdentity & {
  nodeId: string;
  outputName: string;
  offset: number;
  sort: TableSort | null;
};

export type TableQueryResponse =
  | (TableQueryRequest & {
    ok: true;
    table: TablePreview;
  })
  | {
    ok: false;
    error: {
      kind:
        | "stale_result"
        | "missing_output"
        | "unsupported_output"
        | "invalid_table_query"
        | "table_query_failed";
      message: string;
    };
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
    | "missing_node"
    | "unsupported_node_syntax"
    | "duplicate_node_id"
    | "invalid_node_id"
    | "invalid_output"
    | "duplicate_output"
    | "duplicate_edge"
    | "missing_node_reference"
    | "cycle"
    | "document_read_error"
    | "document_write_error"
    | "conflicting_outputs"
    | "invalid_operation"
    | "invalid_python"
    | "invalid_node_return"
    | "stale_document"
    | "duplicate_function_name"
    | "unsupported_python"
    | "unsupported_version";
  message: string;
  path?: string;
  nodeId?: string;
  edgeIndex?: number;
  field?: string;
  operationIndex?: number;
  operationType?: string;
};

export type ExecutionError = {
  kind:
    | "runtime_error"
    | "node_not_found"
    | "internal_error"
    | "validation_error"
    | "planning_error"
    | "missing_module"
    | "import_freshness_error"
    | "invalid_request";
  message: string;
  nodeId?: string;
  issues?: ValidationIssue[];
  phase?: "runtime_preparation" | "document_globals" | "node_execution";
  missingModule?: string;
  pythonExecutable?: string;
  stdout?: string;
  stderr?: string;
  warnings?: string[];
  error?: string;
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
  documentRevision?: string;
  resultStore?: ResultStoreIdentity;
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
