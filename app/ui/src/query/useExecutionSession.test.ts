import { assertEquals } from "@std/assert";
import type { ExecutionDisplayState } from "../components/InspectorPanel.tsx";
import {
  preserveCompletedExecutionStatesForEdit,
  preserveUnaffectedExecutionStates,
} from "./executionSessionState.ts";

function requestError(message: string): ExecutionDisplayState {
  return { status: "request_error", message };
}

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
      displays: [],
      outputEvents: [],
      warnings: [],
    },
  };
}

Deno.test("execution invalidation preserves unaffected node previews", () => {
  const upstream = completedPreview(1);
  const edited = completedPreview(2);
  const downstream = completedPreview(3);

  const result = preserveUnaffectedExecutionStates(
    { upstream, edited, downstream },
    new Set(["edited", "downstream"]),
  );

  assertEquals(result, { upstream });
});

Deno.test("starting a downstream edit keeps completed upstream previews", () => {
  const upstream = completedPreview(1);

  const result = preserveCompletedExecutionStatesForEdit({
    upstream,
    child: { status: "running", runType: "run_to_node" },
  });

  assertEquals(result, { upstream });
});

Deno.test("execution invalidation clears all previews when every node is stale", () => {
  const result = preserveUnaffectedExecutionStates(
    {
      first: requestError("first result marker"),
      second: requestError("second result marker"),
    },
    new Set(["first", "second"]),
  );

  assertEquals(result, {});
});
