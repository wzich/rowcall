export type ExampleGraphId =
  | "basic"
  | "hello-world"
  | "multiOutput"
  | "split"
  | "userInputNeeded"
  | "cyclic"
  | "nonuniqueids"
  | "input";

export type ExampleGraphSource = {
  kind: "example";
  id: ExampleGraphId;
};

export type GraphSource = ExampleGraphSource;

export type AvailableGraphSource = {
  source: GraphSource;
  label: string;
  description: string;
};

export const availableGraphSources: AvailableGraphSource[] = [
  {
    source: { kind: "example", id: "basic" },
    label: "Basic",
    description: "Two connected Python nodes",
  },
  {
    source: { kind: "example", id: "hello-world" },
    label: "Hello world",
    description: "Basic graph with stdout",
  },
  {
    source: { kind: "example", id: "multiOutput" },
    label: "Multi output",
    description: "One source feeding two branches",
  },
  {
    source: { kind: "example", id: "split" },
    label: "Split",
    description: "Branch and merge shape",
  },
  {
    source: { kind: "example", id: "userInputNeeded" },
    label: "User input needed",
    description: "Root node expects external input at run time",
  },
  {
    source: { kind: "example", id: "cyclic" },
    label: "Cyclic (invalid)",
    description: "Validation error example",
  },
  {
    source: { kind: "example", id: "nonuniqueids" },
    label: "Non-unique IDs (invalid)",
    description: "Validation error example",
  },
  {
    source: { kind: "example", id: "input" },
    label: "Input JSON (invalid graph)",
    description: "Non-graph JSON example",
  },
];

export const defaultGraphSource: GraphSource = {
  kind: "example",
  id: "basic",
};

export function encodeGraphSource(source: GraphSource): string {
  switch (source.kind) {
    case "example":
      return `example:${source.id}`;
  }
}

export function getGraphSourceByValue(value: string): GraphSource {
  const match = availableGraphSources.find((item) =>
    encodeGraphSource(item.source) === value
  );
  return match?.source ?? defaultGraphSource;
}

export function describeGraphSource(source: GraphSource): string {
  switch (source.kind) {
    case "example":
      return `examples/${source.id}.json`;
  }
}

export function toInspectRequest(source: GraphSource) {
  switch (source.kind) {
    case "example":
      // TODO: Replace this path mapping with an API-owned example/document
      // source registry before supporting arbitrary user-selectable sources.
      return {
        source: {
          type: "path",
          path: describeGraphSource(source),
        },
      };
  }
}
