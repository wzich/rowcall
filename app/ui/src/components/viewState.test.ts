import { assertEquals } from "@std/assert";
import { hasResultPreviews } from "./viewState.ts";

Deno.test("hasResultPreviews recognizes display-only results", () => {
  assertEquals(hasResultPreviews({ outputs: {}, displays: [{}] }), true);
  assertEquals(hasResultPreviews({ outputs: {}, displays: [] }), false);
});
