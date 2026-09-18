import { assertEquals } from "@std/assert";
import {
  configurePythonRuntime,
  getActiveEnvironmentPythonCandidates,
  getLocalVirtualEnvPythonCandidates,
  getPythonCommandEnvironment,
} from "./runtime_config.ts";

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

Deno.test("getActiveEnvironmentPythonCandidates prefers active venv then conda", () => {
  const previousVirtualEnv = Deno.env.get("VIRTUAL_ENV");
  const previousCondaPrefix = Deno.env.get("CONDA_PREFIX");
  try {
    Deno.env.set("VIRTUAL_ENV", "/venv");
    Deno.env.set("CONDA_PREFIX", "/conda");
    assertEquals(getActiveEnvironmentPythonCandidates(), [
      "/venv/bin/python",
      "/venv/Scripts/python.exe",
      "/venv/python.exe",
      "/conda/bin/python",
      "/conda/Scripts/python.exe",
      "/conda/python.exe",
    ]);
  } finally {
    restoreEnv("VIRTUAL_ENV", previousVirtualEnv);
    restoreEnv("CONDA_PREFIX", previousCondaPrefix);
  }
});

Deno.test("getPythonCommandEnvironment prepends configured Python paths", () => {
  const previousPythonPath = Deno.env.get("PYTHONPATH");
  try {
    Deno.env.set("PYTHONPATH", "/existing");
    configurePythonRuntime({
      pythonPathEntries: ["/rowcall"],
      runtimeMode: "user",
    });
    assertEquals(getPythonCommandEnvironment(), {
      MPLBACKEND: "Agg",
      PYTHONPATH: `/rowcall${Deno.build.os === "windows" ? ";" : ":"}/existing`,
    });
  } finally {
    configurePythonRuntime({});
    restoreEnv("PYTHONPATH", previousPythonPath);
  }
});

Deno.test("getPythonCommandEnvironment forces a headless plotting backend", () => {
  configurePythonRuntime({});
  assertEquals(getPythonCommandEnvironment(), { MPLBACKEND: "Agg" });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
    return;
  }
  Deno.env.set(name, value);
}
