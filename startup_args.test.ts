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
