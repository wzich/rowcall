import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  buildLauncherInvocation,
  createExampleProject,
  createNewDocument,
  parseBetaCommand,
  resolveExistingDocumentPath,
} from "./beta_launcher.ts";

Deno.test("parseBetaCommand maps help and version utility commands", () => {
  assertEquals(parseBetaCommand([]), { kind: "help" });
  assertEquals(parseBetaCommand(["--help"]), { kind: "help" });
  assertEquals(parseBetaCommand(["-h"]), { kind: "help" });
  assertEquals(parseBetaCommand(["help", "format"]), {
    kind: "help",
    topic: "format",
  });
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
  assertEquals(parseBetaCommand(["open", "analysis.py"]), {
    kind: "launch",
    documentPath: "analysis.py",
    openBrowser: true,
    port: 8000,
    hostname: "127.0.0.1",
  });
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

Deno.test("parseBetaCommand maps new and example commands", () => {
  assertEquals(parseBetaCommand(["new", "my-work"]), {
    kind: "new",
    targetPath: "my-work",
    openBrowser: false,
  });
  assertEquals(parseBetaCommand(["new", "my-work", "--open"]), {
    kind: "new",
    targetPath: "my-work",
    openBrowser: true,
  });
  assertEquals(parseBetaCommand(["example", "sample"]), {
    kind: "example",
    targetPath: "sample",
    openBrowser: false,
  });
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
    () => parseBetaCommand(["analysis.py", "extra.py"]),
    Error,
    "Expected exactly one",
  );
});

Deno.test({
  name: "resolveExistingDocumentPath accepts existing Python documents",
  permissions: { read: true, write: true },
  async fn() {
    const path = await Deno.makeTempFile({ suffix: ".py" });
    await Deno.writeTextFile(path, "print('existing')\n");
    assertEquals(await resolveExistingDocumentPath(path), path);
  },
});

Deno.test({
  name: "resolveExistingDocumentPath maps folders to graph.py",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await Deno.makeTempDir();
    const path = `${dir}/graph.py`;
    await Deno.writeTextFile(path, "print('graph')\n");
    assertEquals(await resolveExistingDocumentPath(dir), path);
  },
});

Deno.test({
  name: "resolveExistingDocumentPath rejects missing paths with new suggestion",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await Deno.makeTempDir();
    await assertRejects(
      () => resolveExistingDocumentPath(`${dir}/missing`),
      Error,
      "nodebook new",
    );
  },
});

Deno.test({
  name: "createNewDocument creates graph.py for folder paths",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await Deno.makeTempDir();
    const folder = `${dir}/new-project`;
    const path = await createNewDocument(folder);
    assertEquals(path, `${folder}/graph.py`);
    const source = await Deno.readTextFile(path);
    assertEquals(source.includes("from nodebook import node"), true);
    assertEquals(
      source.includes("shout_message.depends_on(load_message)"),
      true,
    );
  },
});

Deno.test({
  name: "createNewDocument creates standalone Python documents",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await Deno.makeTempDir();
    const path = `${dir}/new.py`;
    assertEquals(await createNewDocument(path), path);
    const source = await Deno.readTextFile(path);
    assertEquals(source.includes("from nodebook import node"), true);
  },
});

Deno.test({
  name: "createNewDocument rejects existing documents",
  permissions: { read: true, write: true },
  async fn() {
    const path = await Deno.makeTempFile({ suffix: ".py" });
    await assertRejects(
      () => createNewDocument(path),
      Error,
      "already exists",
    );
  },
});

Deno.test({
  name: "createNewDocument rejects a missing parent directory for .py paths",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await Deno.makeTempDir();
    await assertRejects(
      () => createNewDocument(`${dir}/missing/new.py`),
      Error,
      "Parent directory does not exist",
    );
  },
});

Deno.test({
  name: "createExampleProject creates graph and data files",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await Deno.makeTempDir();
    const folder = `${dir}/sample`;
    const path = await createExampleProject(folder);
    assertEquals(path, `${folder}/graph.py`);
    assertEquals(
      await Deno.stat(`${folder}/data/orders.csv`).then((stat) => stat.isFile),
      true,
    );
    const source = await Deno.readTextFile(path);
    assertEquals(source.includes("pl.read_csv"), true);
  },
});
