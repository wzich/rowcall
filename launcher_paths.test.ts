import { assertEquals } from "@std/assert";
import { getLauncherPaths, getVenvPythonPath } from "./launcher_paths.ts";

Deno.test("getLauncherPaths returns the launcher data layout under the home directory", () => {
  assertEquals(getLauncherPaths("/Users/test"), {
    home: "/Users/test",
    dataDir: "/Users/test/.rowcall",
    venvDir: "/Users/test/.rowcall/venvs/default",
    logsDir: "/Users/test/.rowcall/logs",
    logFile: "/Users/test/.rowcall/logs/rowcall.log",
    configFile: "/Users/test/.rowcall/config.json",
    updateCheckFile: "/Users/test/.rowcall/update-check.json",
    bundledDir: "/Users/test/.rowcall/bundled",
    bundledPythonPackageDir: "/Users/test/.rowcall/bundled/python-package",
    bundledRequirementsPath:
      "/Users/test/.rowcall/bundled/requirements-alpha.txt",
    uiDistPath: "/Users/test/.rowcall/bundled/app/ui/dist",
  });
});

Deno.test("getVenvPythonPath returns the platform venv interpreter", () => {
  const expected = Deno.build.os === "windows"
    ? "/tmp/env/Scripts/python.exe"
    : "/tmp/env/bin/python";
  assertEquals(getVenvPythonPath("/tmp/env"), expected);
});
