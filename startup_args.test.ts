import { assertEquals, assertThrows } from "@std/assert";
import {
  defaultDocumentPath,
  defaultHostname,
  defaultPort,
  parseStartupOptions,
} from "./startup_args.ts";

Deno.test("parseStartupOptions defaults to the alpha example", () => {
  assertEquals(parseStartupOptions([]), {
    documentPath: defaultDocumentPath,
    create: false,
    port: defaultPort,
    hostname: defaultHostname,
  });
});

Deno.test("parseStartupOptions accepts clean positional startup args", () => {
  assertEquals(
    parseStartupOptions([
      "--create",
      "--python",
      "/env/bin/python",
      "--port",
      "8123",
      "analysis.py",
    ]),
    {
      documentPath: "analysis.py",
      create: true,
      pythonCommand: "/env/bin/python",
      port: 8123,
      hostname: defaultHostname,
    },
  );
});

Deno.test("parseStartupOptions accepts explicit document flag", () => {
  assertEquals(
    parseStartupOptions([
      "--document",
      "analysis.py",
      "--hostname",
      "localhost",
    ]),
    {
      documentPath: "analysis.py",
      create: false,
      port: defaultPort,
      hostname: "localhost",
    },
  );
});

Deno.test("parseStartupOptions can defer folder resolution to a launcher", () => {
  assertEquals(
    parseStartupOptions(["my-project"], { allowDirectoryInput: true }),
    {
      documentPath: "my-project",
      create: false,
      port: defaultPort,
      hostname: defaultHostname,
    },
  );
});

Deno.test("parseStartupOptions accepts packaged server paths", () => {
  assertEquals(
    parseStartupOptions([
      "--document",
      "analysis.py",
      "--python",
      "/env/bin/python",
      "--ui-dist",
      "/app/ui/dist",
      "--rowcall-python-package",
      "/app/python-package",
      "--runtime-mode",
      "user",
      "--auth-token",
      "secret-token",
    ]),
    {
      documentPath: "analysis.py",
      create: false,
      pythonCommand: "/env/bin/python",
      rowcallPythonPackagePath: "/app/python-package",
      runtimeMode: "user",
      uiDistPath: "/app/ui/dist",
      authToken: "secret-token",
      port: defaultPort,
      hostname: defaultHostname,
    },
  );
});

Deno.test("parseStartupOptions rejects invalid startup args", () => {
  assertThrows(
    () => parseStartupOptions(["analysis.py", "extra.py"]),
    Error,
    "Unexpected extra document path",
  );
  assertThrows(
    () => parseStartupOptions(["analysis.ipynb"]),
    Error,
    "must end with .py",
  );
  assertThrows(
    () => parseStartupOptions(["--port", "99999"]),
    Error,
    "Invalid --port value",
  );
  assertThrows(
    () => parseStartupOptions(["--runtime-mode", "cloud", "analysis.py"]),
    Error,
    "Invalid --runtime-mode value",
  );
});
