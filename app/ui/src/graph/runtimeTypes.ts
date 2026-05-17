// TODO: Replace these duplicated UI-side runtime types with shared core types
// once the UI starts calling the execution API directly.
export type RuntimeNode = {
  id: string;
  code: string;
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
