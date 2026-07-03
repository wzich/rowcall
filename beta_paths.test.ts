import { assertEquals } from "@std/assert";
import { getBetaPaths, getVenvPythonPath } from "./beta_paths.ts";

Deno.test("getBetaPaths returns the beta data layout under the home directory", () => {
  assertEquals(getBetaPaths("/Users/test"), {
    home: "/Users/test",
    dataDir: "/Users/test/.nodebook",
    venvDir: "/Users/test/.nodebook/venvs/default",
    logsDir: "/Users/test/.nodebook/logs",
    logFile: "/Users/test/.nodebook/logs/nodebook.log",
    configFile: "/Users/test/.nodebook/config.json",
    updateCheckFile: "/Users/test/.nodebook/update-check.json",
    bundledDir: "/Users/test/.nodebook/bundled",
    bundledPythonPackageDir: "/Users/test/.nodebook/bundled/python-package",
    bundledRequirementsPath:
      "/Users/test/.nodebook/bundled/requirements-alpha.txt",
    uiDistPath: "/Users/test/.nodebook/bundled/app/ui/dist",
  });
});

Deno.test("getVenvPythonPath returns the platform venv interpreter", () => {
  const expected = Deno.build.os === "windows"
    ? "/tmp/env/Scripts/python.exe"
    : "/tmp/env/bin/python";
  assertEquals(getVenvPythonPath("/tmp/env"), expected);
});
