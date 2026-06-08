import { validateGraph } from "./graph.ts";
import { toRuntimeGraph } from "./document.ts";
import { loadPythonDocument } from "./python_document.ts";
import type { Graph } from "./types.ts";

export async function loadValidatedGraph(path: string): Promise<Graph> {
  if (!path.endsWith(".py")) {
    throw new Error(
      "Nodebook graph paths must be Python documents ending in .py",
    );
  }

  const document = await loadPythonDocument(path);
  if (!document.ok) {
    throw new Error(formatValidationIssues(document.issues));
  }

  const graph = toRuntimeGraph(document.document);
  const validated = validateGraph(graph);
  if (!validated.ok) {
    throw new Error(formatValidationIssues(validated.issues));
  }
  return graph;
}

function formatValidationIssues(issues: { message: string }[]): string {
  return issues.map((issue) => issue.message).join("; ");
}
