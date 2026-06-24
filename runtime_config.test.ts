import { assertEquals } from "@std/assert";
import { getLocalVirtualEnvPythonCandidates } from "./runtime_config.ts";

Deno.test("getLocalVirtualEnvPythonCandidates returns platform venv Python paths", () => {
  assertEquals(getLocalVirtualEnvPythonCandidates(), [
    ".venv/bin/python",
    ".venv/Scripts/python.exe",
  ]);

  assertEquals(getLocalVirtualEnvPythonCandidates("/repo"), [
    "/repo/.venv/bin/python",
    "/repo/.venv/Scripts/python.exe",
  ]);
});
