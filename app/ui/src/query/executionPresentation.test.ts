import { assertEquals } from "@std/assert";
import type { ExecutionResponse } from "../../../../types.ts";
import {
  createRunNotification,
  getNodeRunVisualStatusFromResponse,
  getRunNotificationSummary,
} from "./executionPresentation.ts";

function failedResponse(
  error: ExecutionResponse["error"],
): ExecutionResponse {
  return {
    ok: false,
    runType: "run_graph",
    finalNodeIds: ["n_total"],
    executedNodeIds: [],
    resultsByNode: {},
    finalOutputsByNode: {},
    trace: null,
    error,
  };
}

Deno.test("document globals failures navigate to globals and block planned nodes", () => {
  const response = failedResponse({
    kind: "missing_module",
    phase: "document_globals",
    message: "Missing Python package while loading document globals: polars",
    missingModule: "polars",
  });

  assertEquals(createRunNotification(response, 4), {
    id: 4,
    tone: "danger",
    title: "Run couldn't start",
    summary: "Missing polars in Document Globals",
    destination: { kind: "document_globals" },
  });
  assertEquals(
    getNodeRunVisualStatusFromResponse(response, "n_total"),
    "blocked_globals",
  );
});

Deno.test("node failures navigate to the failed node", () => {
  const response = failedResponse({
    kind: "runtime_error",
    phase: "node_execution",
    message: "Failed execution at node n_source",
    nodeId: "n_source",
  });

  assertEquals(createRunNotification(response, 7).destination, {
    kind: "node",
    nodeId: "n_source",
  });
  assertEquals(
    getNodeRunVisualStatusFromResponse(response, "n_downstream"),
    "blocked",
  );
});

Deno.test("successful partial runs stay attached to their target node", () => {
  const response: ExecutionResponse = {
    ok: true,
    runType: "run_to_node",
    targetNodeId: "n_total",
    finalNodeIds: ["n_total"],
    executedNodeIds: ["n_total"],
    resultsByNode: {},
    finalOutputsByNode: {},
    trace: null,
    error: null,
  };

  const notification = createRunNotification(response, 9);
  assertEquals(notification.destination, {
    kind: "node",
    nodeId: "n_total",
  });
  assertEquals(
    getRunNotificationSummary(notification, { n_total: "Total" }),
    "Run through completed",
  );
});

Deno.test("failed node notifications use the node label in their summary", () => {
  const notification = createRunNotification(
    failedResponse({
      kind: "runtime_error",
      phase: "node_execution",
      message: "Failed execution at node n_source",
      nodeId: "n_source",
    }),
    10,
  );

  assertEquals(
    getRunNotificationSummary(notification, { n_source: "Source" }),
    "Source failed",
  );
});
