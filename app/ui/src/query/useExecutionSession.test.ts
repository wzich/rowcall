import { assertEquals } from "@std/assert";
import type { ExecutionDisplayState } from "../components/InspectorPanel.tsx";
import {
  preserveCompletedExecutionStatesForEdit,
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
      displays: [],
      outputEvents: [],
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
