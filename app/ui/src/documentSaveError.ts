import { parser as pythonParser } from "@lezer/python";
import {
  DocumentApiRequestError,
  type DocumentOperation,
  type DocumentValidationIssue,
} from "./api/documents.ts";
import {
  type PythonSyntaxLocation,
  pythonSyntaxLocationFromOffset,
} from "./pythonSyntaxError.ts";

export type SaveErrorMessage = {
  title: string;
  detail: string;
  target?: PythonEditorErrorTarget;
};

export type PythonEditorErrorTarget = PythonSyntaxLocation & {
  editor: "globals" | "node";
  nodeId?: string;
  message: string;
};

export function formatSaveError(
  error: unknown,
  operations: DocumentOperation[] = [],
): SaveErrorMessage {
  if (error instanceof DocumentApiRequestError && error.issues.length > 0) {
    const issue = error.issues[0];
    const location = formatIssueLocation(issue.path);

    if (issue.kind === "invalid_python") {
      const target = getPythonEditorErrorTarget(issue, operations);
      return {
        title: "Save failed: unsaved Python has a syntax error",
        detail: `${issue.message}${
          target ? formatEditorLocation(target) : location
        }. The saved file was not changed and your edits are still in the editor.`,
        ...(target ? { target } : {}),
      };
    }

    return {
      title: "Save failed",
      detail: `${issue.kind}: ${issue.message}${location}`,
    };
  }

  return {
    title: "Save failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

function getPythonEditorErrorTarget(
  issue: DocumentValidationIssue,
  operations: DocumentOperation[],
): PythonEditorErrorTarget | undefined {
  if (issue.operationIndex === undefined) {
    return undefined;
  }

  const operation = operations[issue.operationIndex];
  if (!operation) {
    return undefined;
  }

  if (operation.type === "update_globals") {
    const location = (issue.field === "globalsCode"
      ? parsePythonIssueLocation(issue.path)
      : null) ?? findPythonSyntaxError(operation.code);
    return location
      ? { ...location, editor: "globals", message: issue.message }
      : undefined;
  }

  if (operation.type === "update_node_body") {
    const location =
      (issue.field === "code" ? parsePythonIssueLocation(issue.path) : null) ??
        findPythonSyntaxError(operation.code);
    return location
      ? {
        ...location,
        editor: "node",
        nodeId: operation.nodeId,
        message: issue.message,
      }
      : undefined;
  }

  if (operation.type === "add_node") {
    const location = findPythonSyntaxError(operation.node.code);
    return location
      ? {
        ...location,
        editor: "node",
        nodeId: operation.node.id,
        message: issue.message,
      }
      : undefined;
  }

  return undefined;
}

function parsePythonIssueLocation(
  path: string | undefined,
): PythonSyntaxLocation | null {
  if (!path) {
    return null;
  }
  const [lineText, columnText] = path.split(":", 2);
  const line = Number(lineText);
  const column = Number(columnText);
  return Number.isInteger(line) && line > 0 && Number.isInteger(column) &&
      column > 0
    ? { line, column }
    : null;
}

function findPythonSyntaxError(code: string): PythonSyntaxLocation | null {
  const tree = pythonParser.parse(code);
  let errorOffset: number | null = null;

  tree.iterate({
    enter(node) {
      if (errorOffset === null && node.type.isError) {
        errorOffset = node.from;
      }
    },
  });

  return errorOffset === null
    ? null
    : pythonSyntaxLocationFromOffset(code, errorOffset);
}

function formatEditorLocation(target: PythonEditorErrorTarget): string {
  return ` at line ${target.line}, column ${target.column} in ${
    target.editor === "globals" ? "Document Globals" : "this step"
  }`;
}

function formatIssueLocation(path: string | undefined): string {
  if (!path) {
    return "";
  }

  const [line, column] = path.split(":");
  if (line && column) {
    return ` at line ${line}, column ${column}`;
  }

  return ` at ${path}`;
}
