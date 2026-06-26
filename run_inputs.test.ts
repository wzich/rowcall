import { assertEquals } from "@std/assert";
import { hasExplicitRunInputs } from "./run_inputs.ts";

Deno.test("hasExplicitRunInputs allows omitted and empty object inputs", () => {
  assertEquals(hasExplicitRunInputs(undefined), false);
  assertEquals(hasExplicitRunInputs(null), false);
  assertEquals(hasExplicitRunInputs({}), false);
});

Deno.test("hasExplicitRunInputs rejects non-empty and malformed inputs", () => {
  assertEquals(hasExplicitRunInputs({ value: 1 }), true);
  assertEquals(hasExplicitRunInputs([]), true);
  assertEquals(hasExplicitRunInputs("value"), true);
});
