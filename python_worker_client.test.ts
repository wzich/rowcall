import { assertEquals } from "@std/assert";
import {
  pythonWorkerOperations,
  pythonWorkerTerminalEventsByOperation,
  pythonWorkerTerminalEventTypes,
} from "./python_worker_client.ts";

Deno.test("Python worker protocol declares document and run operations", () => {
  assertEquals([...pythonWorkerOperations], [
    "validate_source",
    "inspect_source",
    "render_source",
    "validate_candidate_source",
    "plan_run",
    "run_graph",
    "run_to_node",
    "run_node",
    "load_document",
    "clear_session_cache",
    "shutdown",
  ]);
});

Deno.test("Python worker terminal event map covers every declared operation", () => {
  assertEquals(
    Object.keys(pythonWorkerTerminalEventsByOperation).sort(),
    [...pythonWorkerOperations].sort(),
  );

  const terminalTypes = new Set(pythonWorkerTerminalEventTypes);
  for (
    const eventTypes of Object.values(pythonWorkerTerminalEventsByOperation)
  ) {
    for (const eventType of eventTypes) {
      assertEquals(terminalTypes.has(eventType), true);
    }
  }
});
