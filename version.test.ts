import { assertEquals } from "@std/assert";
import { rowcallVersion } from "./version.ts";

Deno.test({
  name: "rowcallVersion matches VERSION",
  permissions: { read: true },
  async fn() {
    assertEquals((await Deno.readTextFile("VERSION")).trim(), rowcallVersion);
  },
});

Deno.test({
  name: "rowcallVersion matches pyproject.toml",
  permissions: { read: true },
  async fn() {
    const pyproject = await Deno.readTextFile("pyproject.toml");
    const match = pyproject.match(/^version = "([^"]+)"$/m);
    assertEquals(match?.[1], rowcallVersion);
  },
});
