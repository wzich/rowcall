import { assertEquals } from "@std/assert";
import {
  configurePythonDocumentLoaderPath,
  configurePythonRunnerPath,
  getLocalVirtualEnvPythonCandidates,
  resolvePythonDocumentLoaderPath,
  resolvePythonRunnerPath,
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

Deno.test("runtime helper paths default and can be configured", () => {
  configurePythonRunnerPath(undefined);
  configurePythonDocumentLoaderPath(undefined);
  assertEquals(resolvePythonRunnerPath(), "runner.py");
  assertEquals(resolvePythonDocumentLoaderPath(), "python_document_loader.py");

  configurePythonRunnerPath("/bundle/runner.py");
  configurePythonDocumentLoaderPath("/bundle/python_document_loader.py");
  assertEquals(resolvePythonRunnerPath(), "/bundle/runner.py");
  assertEquals(
    resolvePythonDocumentLoaderPath(),
    "/bundle/python_document_loader.py",
  );

  configurePythonRunnerPath(undefined);
  configurePythonDocumentLoaderPath(undefined);
});
