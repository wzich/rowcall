import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  buildLauncherInvocation,
  ensureDocumentReady,
  parseBetaCommand,
} from "./beta_launcher.ts";

Deno.test("parseBetaCommand maps empty args and version to utility commands", () => {
  assertEquals(parseBetaCommand([]), { kind: "help" });
  assertEquals(parseBetaCommand(["--version"]), { kind: "version" });
});

Deno.test("parseBetaCommand maps launch args", () => {
  assertEquals(
    parseBetaCommand([
      "--python",
      "/env/bin/python",
      "--port",
      "8123",
      "--hostname",
      "localhost",
      "--no-open",
      "analysis.py",
    ]),
    {
      kind: "launch",
      documentPath: "analysis.py",
      openBrowser: false,
      pythonCommand: "/env/bin/python",
      port: 8123,
      hostname: "localhost",
    },
  );
});

Deno.test("parseBetaCommand maps headless run and validate commands", () => {
  assertEquals(
    parseBetaCommand(["run", "--python", "/env/bin/python", "analysis.py"]),
    {
      kind: "headless",
      cliCommand: "run",
      args: ["analysis.py"],
      pythonCommand: "/env/bin/python",
    },
  );
  assertEquals(parseBetaCommand(["validate", "analysis.py"]), {
    kind: "headless",
    cliCommand: "validate",
    args: ["analysis.py"],
  });
});

Deno.test("parseBetaCommand maps doctor/reset/update commands", () => {
  assertEquals(parseBetaCommand(["doctor", "--updates"]), {
    kind: "doctor",
    checkUpdates: true,
  });
  assertEquals(parseBetaCommand(["reset-env"]), { kind: "reset-env" });
  assertEquals(parseBetaCommand(["update"]), { kind: "update" });
});

Deno.test("buildLauncherInvocation re-execs compiled launchers directly", () => {
  assertEquals(
    buildLauncherInvocation(["__server", "--port", "8000"], {
      execPath: "/Users/me/.local/bin/nodebook",
      mainModule: "file:///var/folders/deno-compile-nodebook/beta_launcher.ts",
    }),
    {
      command: "/Users/me/.local/bin/nodebook",
      args: ["__server", "--port", "8000"],
    },
  );
});

Deno.test("buildLauncherInvocation runs the launcher module in source mode", () => {
  assertEquals(
    buildLauncherInvocation(["__server", "--port", "8000"], {
      execPath: "/Users/me/.deno/bin/deno",
      mainModule: "file:///Users/me/src/nodebook/beta_launcher.ts",
    }),
    {
      command: "/Users/me/.deno/bin/deno",
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-net",
        "--allow-run",
        "--allow-env",
        "file:///Users/me/src/nodebook/beta_launcher.ts",
        "__server",
        "--port",
        "8000",
      ],
    },
  );
});

Deno.test("parseBetaCommand rejects invalid launch args", () => {
  assertThrows(
    () => parseBetaCommand(["analysis.ipynb"]),
    Error,
    "must end with .py",
  );
  assertThrows(
    () => parseBetaCommand(["analysis.py", "extra.py"]),
    Error,
    "Expected exactly one",
  );
});

Deno.test({
  name: "ensureDocumentReady leaves existing documents alone",
  permissions: { read: true, write: true },
  async fn() {
    const path = await Deno.makeTempFile({ suffix: ".py" });
    await Deno.writeTextFile(path, "print('existing')\n");
    await ensureDocumentReady(path);
    assertEquals(await Deno.readTextFile(path), "print('existing')\n");
  },
});

Deno.test({
  name: "ensureDocumentReady creates a missing document when parent exists",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await Deno.makeTempDir();
    const path = `${dir}/new.py`;
    await ensureDocumentReady(path);
    const source = await Deno.readTextFile(path);
    assertEquals(source.includes("from nodebook import node"), true);
  },
});

Deno.test({
  name: "ensureDocumentReady rejects a missing parent directory",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await Deno.makeTempDir();
    await assertRejects(
      () => ensureDocumentReady(`${dir}/missing/new.py`),
      Error,
      "Parent directory does not exist",
    );
  },
});
