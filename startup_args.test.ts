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

Deno.test("parseStartupOptions accepts packaged runtime helper paths", () => {
  assertEquals(
    parseStartupOptions([
      "--document",
      "analysis.py",
      "--python",
      "/env/bin/python",
      "--runner",
      "/app/runner.py",
      "--loader",
      "/app/python_document_loader.py",
      "--ui-dist",
      "/app/ui/dist",
      "--auth-token",
      "secret-token",
    ]),
    {
      documentPath: "analysis.py",
      create: false,
      pythonCommand: "/env/bin/python",
      pythonRunnerPath: "/app/runner.py",
      pythonDocumentLoaderPath: "/app/python_document_loader.py",
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
});
