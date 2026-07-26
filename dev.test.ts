import { assertEquals, assertThrows } from "@std/assert";
import { parseDevOptions } from "./dev.ts";

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
