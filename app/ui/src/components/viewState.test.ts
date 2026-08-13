import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  hasResultPreviews,
  orderDevelopResultNames,
  toggleOrderedName,
} from "./viewState.ts";

Deno.test("hasResultPreviews recognizes view-only results", () => {
  assertEquals(hasResultPreviews({ outputs: {}, views: { chart: {} } }), true);
  assertEquals(hasResultPreviews({ outputs: {}, views: {} }), false);
});

Deno.test("toggleOrderedName preserves existing order and appends additions", () => {
  assertEquals(
    toggleOrderedName(["chart", "summary"], "details", 10),
    ["chart", "summary", "details"],
  );
  assertEquals(
    toggleOrderedName(["chart", "summary"], "chart", 10),
    ["summary"],
  );
});

Deno.test("toggleOrderedName leaves a full selection unchanged", () => {
  const names = ["one", "two"];
  assertStrictEquals(toggleOrderedName(names, "three", 2), names);
});

Deno.test("develop results show views first and deduplicate shared outputs", () => {
  assertEquals(
    orderDevelopResultNames(["data", "chart", "summary"], ["chart", "note"]),
    ["chart", "note", "data", "summary"],
  );
});
