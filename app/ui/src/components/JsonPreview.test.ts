import { assertEquals, assertRejects } from "@std/assert";
import {
  copyJsonText,
  formatJsonValue,
  isJsonContainer,
  jsonPreviewModeStorageKey,
  persistJsonPreviewMode,
  readJsonPreviewMode,
  shouldExpandJsonNode,
} from "./jsonPreviewState.ts";

function memoryStorage(initialValue?: string) {
  const values = new Map<string, string>();
  if (initialValue !== undefined) {
    values.set(jsonPreviewModeStorageKey, initialValue);
  }
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

Deno.test("JSON preview mode defaults to tree and persists raw mode", () => {
  const storage = memoryStorage();

  assertEquals(readJsonPreviewMode(storage), "tree");
  persistJsonPreviewMode("raw", storage);
  assertEquals(readJsonPreviewMode(storage), "raw");
});

Deno.test("JSON preview mode safely ignores invalid and unavailable storage", () => {
  assertEquals(readJsonPreviewMode(memoryStorage("unexpected")), "tree");

  const unavailableStorage = {
    getItem(): string | null {
      throw new Error("storage unavailable");
    },
    setItem(): void {
      throw new Error("storage unavailable");
    },
  };

  assertEquals(readJsonPreviewMode(unavailableStorage), "tree");
  persistJsonPreviewMode("raw", unavailableStorage);
});

Deno.test("JSON preview identifies containers and formats valid raw JSON", () => {
  assertEquals(isJsonContainer({ nested: true }), true);
  assertEquals(isJsonContainer([1, 2]), true);
  assertEquals(isJsonContainer(null), false);
  assertEquals(isJsonContainer("text"), false);
  assertEquals(
    formatJsonValue({ nested: ["value"] }),
    '{\n  "nested": [\n    "value"\n  ]\n}',
  );
});

Deno.test("JSON tree expands objects through two levels", () => {
  const value = { nested: { value: true } };

  assertEquals(shouldExpandJsonNode(0, value, value), true);
  assertEquals(shouldExpandJsonNode(1, value.nested, value), true);
  assertEquals(shouldExpandJsonNode(2, true, value), false);
});

Deno.test("JSON tree expands a representative prefix of top-level records", () => {
  const value = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

  assertEquals(shouldExpandJsonNode(0, value, value), true);
  assertEquals(shouldExpandJsonNode(1, value[0], value), true);
  assertEquals(shouldExpandJsonNode(1, value[1], value), true);
  assertEquals(shouldExpandJsonNode(1, value[2], value), true);
  assertEquals(shouldExpandJsonNode(1, value[3], value), false);
  assertEquals(shouldExpandJsonNode(2, value[0], value), false);
});

Deno.test("JSON copy delegates to the browser clipboard", async () => {
  let copied = "";
  await copyJsonText('{"ok":true}', {
    writeText(text: string) {
      copied = text;
      return Promise.resolve();
    },
  });

  assertEquals(copied, '{"ok":true}');
  await assertRejects(
    () => copyJsonText("value", undefined),
    Error,
    "Clipboard access is unavailable",
  );
});
