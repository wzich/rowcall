import { assertEquals } from "@std/assert";
import { resolveGraphOutputSelection } from "./graphOutputSelection.ts";

Deno.test("resolveGraphOutputSelection preserves an available selection", () => {
  assertEquals(
    resolveGraphOutputSelection("n_second:result", [
      "n_first:result",
      "n_second:result",
    ]),
    "n_second:result",
  );
});

Deno.test("resolveGraphOutputSelection falls back to the first available output", () => {
  assertEquals(
    resolveGraphOutputSelection("n_removed:result", [
      "n_first:result",
      "n_second:result",
    ]),
    "n_first:result",
  );
  assertEquals(resolveGraphOutputSelection("n_removed:result", []), "");
});
