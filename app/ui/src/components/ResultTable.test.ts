import { assertEquals } from "@std/assert";
import { sortingStateToQuery } from "./resultTableState.ts";

Deno.test("result table translates one visible sort into a server query", () => {
  assertEquals(sortingStateToQuery([]), null);
  assertEquals(
    sortingStateToQuery([{ id: "__nodebook_index__", desc: false }]),
    { kind: "index", descending: false },
  );
  assertEquals(
    sortingStateToQuery([{ id: "column:3", desc: true }]),
    { kind: "column", columnIndex: 3, descending: true },
  );
});

Deno.test("result table ignores unknown sort identifiers", () => {
  assertEquals(sortingStateToQuery([{ id: "column:nope", desc: false }]), null);
  assertEquals(sortingStateToQuery([{ id: "other", desc: true }]), null);
});
