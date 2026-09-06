import { assertEquals, assertThrows } from "@std/assert";
import {
  buildAuthenticatedUrl,
  parseDevOptions,
  resolveDevDocumentPath,
  resolveDevRuntime,
} from "./dev.ts";

Deno.test("parseDevOptions keeps server arguments and handles dev-only flags", () => {
  assertEquals(
    parseDevOptions([
      "--no-open",
      "--ui-port",
      "5174",
      "--create",
      "--python",
      "/tmp/python",
      "analysis.py",
    ]),
    {
      documentPath: "analysis.py",
      create: true,
      pythonCommand: "/tmp/python",
      port: 8000,
      hostname: "127.0.0.1",
      openBrowser: false,
      managedEnv: false,
      uiPort: 5174,
    },
  );
});

Deno.test("parseDevOptions defaults to opening the standard Vite port", () => {
  const options = parseDevOptions([]);

  assertEquals(options.openBrowser, true);
  assertEquals(options.managedEnv, false);
  assertEquals(options.uiPort, 5173);
});

Deno.test("parseDevOptions accepts folder inputs and managed environments", () => {
  assertEquals(parseDevOptions(["--managed-env", "my-project"]), {
    documentPath: "my-project",
    create: false,
    port: 8000,
    hostname: "127.0.0.1",
    openBrowser: true,
    managedEnv: true,
    uiPort: 5173,
  });
});

Deno.test("parseDevOptions rejects conflicting runtime options", () => {
  assertThrows(
    () => parseDevOptions(["--managed-env", "--python", "python3", "graph.py"]),
    Error,
    "--python cannot be combined with --managed-env",
  );
});

Deno.test("parseDevOptions rejects invalid Vite ports", () => {
  assertThrows(
    () => parseDevOptions(["--ui-port", "invalid"]),
    Error,
    "Invalid --ui-port value",
  );
});

Deno.test("resolveDevRuntime selects the document project environment", async () => {
  const options = parseDevOptions(["documents/analysis.py"]);
  const calls: Array<{
    documentPath: string;
    options: { bootstrap: boolean };
  }> = [];

  const resolved = await resolveDevRuntime(
    options,
    {
      resolveProjectPython(documentPath, resolverOptions) {
        calls.push({ documentPath, options: resolverOptions });
        return Promise.resolve("/project/.venv/bin/python");
      },
      validatePythonRuntime: () => Promise.resolve(),
    },
  );

  assertEquals(calls, [{
    documentPath: "documents/analysis.py",
    options: { bootstrap: true },
  }]);
  assertEquals(resolved.pythonCommand, "/project/.venv/bin/python");
  assertEquals(resolved.rowcallPythonPackagePath, ".");
  assertEquals(resolved.runtimeMode, "user");
});

Deno.test("resolveDevRuntime validates an explicit Python override", async () => {
  const options = parseDevOptions([
    "documents/analysis.py",
    "--python",
    "/chosen/python",
  ]);
  let resolverCalled = false;
  const validations: Array<{ command: string; paths?: string[] }> = [];

  const resolved = await resolveDevRuntime(options, {
    resolveProjectPython: () => {
      resolverCalled = true;
      return Promise.resolve("/unexpected/python");
    },
    validatePythonRuntime(command, paths) {
      validations.push({ command, paths });
      return Promise.resolve();
    },
  });

  assertEquals(resolverCalled, false);
  assertEquals(validations, [{ command: "/chosen/python", paths: ["."] }]);
  assertEquals(resolved.pythonCommand, "/chosen/python");
  assertEquals(resolved.rowcallPythonPackagePath, ".");
  assertEquals(resolved.runtimeMode, "user");
});

Deno.test("resolveDevRuntime selects the managed launcher environment", async () => {
  const options = parseDevOptions(["--managed-env", "documents/analysis.py"]);
  let projectResolverCalled = false;
  let validatorCalled = false;

  const resolved = await resolveDevRuntime(options, {
    resolveProjectPython: () => {
      projectResolverCalled = true;
      return Promise.resolve("/unexpected/python");
    },
    ensureManagedEnvironment: () => Promise.resolve("/managed/bin/python"),
    validatePythonRuntime: () => {
      validatorCalled = true;
      return Promise.resolve();
    },
  });

  assertEquals(projectResolverCalled, false);
  assertEquals(validatorCalled, false);
  assertEquals(resolved.pythonCommand, "/managed/bin/python");
  assertEquals(resolved.runtimeMode, "managed");
});

Deno.test("resolveDevDocumentPath maps a folder before runtime selection", async () => {
  const options = parseDevOptions(["documents"]);
  const resolved = await resolveDevDocumentPath(
    options,
    (path) => {
      assertEquals(path, "documents");
      return Promise.resolve("documents/graph.py");
    },
  );

  assertEquals(resolved.documentPath, "documents/graph.py");
});

Deno.test("development URL carries the browser authentication token", () => {
  assertEquals(
    buildAuthenticatedUrl("http://127.0.0.1:5173", "dev token"),
    "http://127.0.0.1:5173/?token=dev+token",
  );
});
