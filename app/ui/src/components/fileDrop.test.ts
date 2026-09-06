import { assertEquals } from "@std/assert";
import { containsDroppedDirectory } from "./fileDrop.ts";

Deno.test("directory drops are distinguished from regular files", () => {
  assertEquals(
    containsDroppedDirectory([
      { kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }) },
      { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) },
    ]),
    true,
  );
  assertEquals(
    containsDroppedDirectory([
      { kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }) },
      { kind: "string" },
    ]),
    false,
  );
});

Deno.test("directory detection tolerates unavailable entry APIs", () => {
  assertEquals(containsDroppedDirectory([{ kind: "file" }]), false);
  assertEquals(
    containsDroppedDirectory([{
      kind: "file",
      webkitGetAsEntry: () => {
        throw new DOMException("Entry is no longer readable");
      },
    }]),
    false,
  );
});
