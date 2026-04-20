import { decodeGraph, validateGraph } from "./graph.ts";
import type { Graph } from "./types.ts";

export async function loadGraphFile(path: string): Promise<unknown> {
  try {
    const text = await Deno.readTextFile(path);
    return JSON.parse(text);
  } catch (e) {
    console.error(`Failed to read graph file at ${path}:`);
    throw e;
  }
}

export async function loadValidatedGraph(path: string): Promise<Graph> {
  const obj = await loadGraphFile(path);
  const decoded = decodeGraph(obj);
  if (!decoded.ok) {
    throw new Error(formatValidationIssues(decoded.issues));
  }

  const validated = validateGraph(decoded.graph);
  if (!validated.ok) {
    throw new Error(formatValidationIssues(validated.issues));
  }

  return decoded.graph;
}

function formatValidationIssues(issues: { message: string }[]): string {
  return issues.map((issue) => issue.message).join("; ");
}
