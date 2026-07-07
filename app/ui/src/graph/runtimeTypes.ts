// TODO: Replace these duplicated UI-side runtime types with shared core types
// once the UI starts calling the execution API directly.
export type RuntimeNode = {
  id: string;
  code: string;
  displayCode?: string;
  runtimeCode?: string;
  functionName?: string;
  title?: string;
  description?: string;
  parameters?: string[];
  customReturn?: boolean;
  editable?: boolean;
  outputs: string[];
  position?: GraphPosition;
};

export type RuntimeEdge = {
  fromNode: string;
  toNode: string;
};

export type RuntimeGraph = {
  nodes: RuntimeNode[];
  edges: RuntimeEdge[];
};

export type GraphPosition = {
  x: number;
  y: number;
};
