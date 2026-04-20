import { queryOptions } from "@tanstack/react-query";
import type { GraphSource } from "../api/graphSources.ts";
import {
  inspectGraph,
  type InspectGraphValidationIssue,
} from "../api/inspectGraph.ts";

export class InspectGraphQueryError extends Error {
  readonly issues: InspectGraphValidationIssue[];

  constructor(message: string, issues: InspectGraphValidationIssue[] = []) {
    super(message);
    this.name = "InspectGraphQueryError";
    this.issues = issues;
  }
}

function graphSourceQueryKey(source: GraphSource) {
  switch (source.kind) {
    case "example":
      return ["graph-source", "example", source.id] as const;
  }
}

export function inspectedGraphQueryOptions(source: GraphSource) {
  return queryOptions({
    queryKey: graphSourceQueryKey(source),
    queryFn: async () => {
      const result = await inspectGraph(source);

      if (!result.ok) {
        // TanStack Query only enters its error path when the query function
        // throws. The raw API helper returns the runtime contract as-is, while
        // this query layer decides how React should model a failed inspection.
        throw new InspectGraphQueryError(
          result.error.message,
          result.error.issues ?? [],
        );
      }

      return result;
    },
  });
}
