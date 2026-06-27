import { assertEquals } from "@std/assert";
import { nodebookVersion } from "./version.ts";

Deno.test({
  name: "nodebookVersion matches VERSION",
  permissions: { read: true },
  async fn() {
    assertEquals((await Deno.readTextFile("VERSION")).trim(), nodebookVersion);
  },
});

Deno.test({
  name: "nodebookVersion matches pyproject.toml",
  permissions: { read: true },
  async fn() {
    const pyproject = await Deno.readTextFile("pyproject.toml");
    const match = pyproject.match(/^version = "([^"]+)"$/m);
    assertEquals(match?.[1], nodebookVersion);
  },
});
