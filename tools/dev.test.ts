import { assertEquals, assertThrows } from "@std/assert";
import { parseDevOptions, resolveDevRuntime } from "./dev.ts";

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
      uiPort: 5174,
    },
  );
});

Deno.test("parseDevOptions defaults to opening the standard Vite port", () => {
  const options = parseDevOptions([]);

  assertEquals(options.openBrowser, true);
  assertEquals(options.uiPort, 5173);
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
    (documentPath, resolverOptions) => {
      calls.push({ documentPath, options: resolverOptions });
      return Promise.resolve("/project/.venv/bin/python");
    },
  );

  assertEquals(calls, [{
    documentPath: "documents/analysis.py",
    options: { bootstrap: true },
  }]);
  assertEquals(resolved.pythonCommand, "/project/.venv/bin/python");
});

Deno.test("resolveDevRuntime preserves an explicit Python override", async () => {
  const options = parseDevOptions([
    "documents/analysis.py",
    "--python",
    "/chosen/python",
  ]);
  let resolverCalled = false;

  const resolved = await resolveDevRuntime(options, () => {
    resolverCalled = true;
    return Promise.resolve("/unexpected/python");
  });

  assertEquals(resolverCalled, false);
  assertEquals(resolved, options);
});
