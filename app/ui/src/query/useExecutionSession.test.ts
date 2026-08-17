import { assertEquals } from "@std/assert";
import type { ExecutionResponse } from "../../../../types.ts";
import type {
  ExecutionDisplayState,
  GraphExecutionDisplayState,
} from "../components/InspectorPanel.tsx";
import {
  preserveCompletedExecutionStatesForEdit,
  preserveGraphExecutionStateForEdit,
} from "./executionSessionState.ts";

function completedPreview(value: number): ExecutionDisplayState {
  return {
    status: "completed_node",
    runType: "run_to_node",
    result: {
      ok: true,
      stdout: "",
      stderr: "",
      outputs: {
        value: {
          name: "value",
          type: "int",
          repr: String(value),
          jsonValue: value,
        },
      },
      variables: {
        value: {
          name: "value",
          type: "int",
          repr: String(value),
          jsonValue: value,
        },
      },
      displays: [],
      warnings: [],
    },
  };
}

Deno.test("starting a downstream edit keeps completed upstream previews", () => {
  const upstream = completedPreview(1);

  const result = preserveCompletedExecutionStatesForEdit({
    upstream,
    child: { status: "running", runType: "run_to_node" },
  });

  assertEquals(result, { upstream });
});

Deno.test("graph edits preserve completed graph results as stale", () => {
  const response: ExecutionResponse = {
    ok: true,
    runType: "run_graph",
    finalNodeIds: [],
    executedNodeIds: [],
    resultsByNode: {},
    finalOutputsByNode: {},
    trace: null,
    error: null,
  };
  const current: GraphExecutionDisplayState = {
    status: "completed",
    response,
    freshness: "fresh",
  };

  assertEquals(preserveGraphExecutionStateForEdit(current), {
    ...current,
    freshness: "document_changed",
  });
  assertEquals(
    preserveGraphExecutionStateForEdit({ status: "running" }),
    null,
  );
});

Deno.test("document edits mark completed node results stale", () => {
  const response: ExecutionResponse = {
    ok: true,
    runType: "run_to_node",
    targetNodeId: "target",
    finalNodeIds: ["target"],
    executedNodeIds: ["target"],
    resultsByNode: {},
    finalOutputsByNode: {},
    trace: null,
    error: null,
  };
  const current: ExecutionDisplayState = {
    status: "completed",
    response,
    freshness: "fresh",
  };

  assertEquals(preserveCompletedExecutionStatesForEdit({ target: current }), {
    target: { ...current, freshness: "document_changed" },
  });
});
