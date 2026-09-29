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
  name: "Python package derives its version from VERSION",
  permissions: { read: true },
  async fn() {
    const pyproject = await Deno.readTextFile("pyproject.toml");
    assertEquals(pyproject.includes('dynamic = ["version"]'), true);
    assertEquals(pyproject.includes('version = { file = "VERSION" }'), true);
  },
});
