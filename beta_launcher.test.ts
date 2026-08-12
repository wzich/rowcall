import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  buildDoctorReport,
  buildLauncherInvocation,
  createExampleProject,
  createNewDocument,
  ensureManagedEnvironment,
  ensureProjectEnvironment,
  formatPortInUseError,
  helpTextForTopic,
  managedEnvironmentRevision,
  parseBetaCommand,
  preflightHeadlessCommand,
  resolveExistingDocumentPath,
  resolveProjectPython,
  runBetaCommand,
} from "./beta_launcher.ts";
import { getBetaPaths, getVenvPythonPath } from "./beta_paths.ts";
import { rowcallVersion } from "./version.ts";

Deno.test("format help teaches the strict generated return structure", () => {
  const help = helpTextForTopic("format");

  assertStringIncludes(help, "numbers = [1, 2, 3]");
  assertStringIncludes(help, 'return {"numbers": numbers}');
  assertStringIncludes(help, "Use exactly one return statement");
  assertStringIncludes(help, "do not return expressions inline");
  assertStringIncludes(help, "rowcall validate");
});

Deno.test("main help teaches the open-once coding-agent workflow", () => {
  const help = helpTextForTopic(undefined);

  assertStringIncludes(help, "Working with coding agents");
  assertStringIncludes(help, "rowcall validate <path>");
  assertStringIncludes(help, "--json=summary");
  assertStringIncludes(help, "Open the\n  Rowcall UI once");
  assertStringIncludes(help, "New folder projects created");
  assertStringIncludes(help, "AGENTS.md");
});

Deno.test("command help explains project environment setup boundaries", () => {
  assertStringIncludes(helpTextForTopic("run"), "installs requirements.txt");
  assertStringIncludes(
    helpTextForTopic("run"),
    "Existing environments are never modified automatically",
  );
  assertStringIncludes(
    helpTextForTopic("validate"),
    "never creates .venv or installs requirements.txt",
  );
});

Deno.test("occupied-port guidance prioritizes the existing window", () => {
  const message = formatPortInUseError("127.0.0.1", 8000);

  assertStringIncludes(message, "Rowcall may already be running");
  assertStringIncludes(message, "return to the existing browser window");
  assertStringIncludes(message, "--port 8001");
});

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
      managedEnv: false,
      port: 8123,
      hostname: "localhost",
    },
  );
  assertEquals(parseBetaCommand(["open", "analysis.py"]), {
    kind: "launch",
    documentPath: "analysis.py",
    openBrowser: true,
    managedEnv: false,
    port: 8000,
    hostname: "127.0.0.1",
  });
  assertEquals(parseBetaCommand(["open", "--managed-env", "analysis.py"]), {
    kind: "launch",
    documentPath: "analysis.py",
    openBrowser: true,
    managedEnv: true,
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
      managedEnv: false,
    },
  );
  assertEquals(parseBetaCommand(["run", "--managed-env", "analysis.py"]), {
    kind: "headless",
    cliCommand: "run",
    args: ["analysis.py"],
    managedEnv: true,
  });
  assertEquals(parseBetaCommand(["validate", "analysis.py"]), {
    kind: "headless",
    cliCommand: "validate",
    args: ["analysis.py"],
    managedEnv: false,
  });
});

Deno.test("headless preflight gates environment side effects", () => {
  assertEquals(
    preflightHeadlessCommand("run", ["analysis.py", "--json"]),
    {
      documentInput: "analysis.py",
      allowsEnvironmentSetup: true,
      machineReadable: true,
    },
  );
  assertEquals(
    preflightHeadlessCommand("run", [
      "--to",
      "n_summary",
      "analysis.py",
      "--trace",
    ]).allowsEnvironmentSetup,
    true,
  );
  assertEquals(
    preflightHeadlessCommand("run", [
      "analysis.py",
      "--trace=summary",
    ]).allowsEnvironmentSetup,
    false,
  );
  assertEquals(
    preflightHeadlessCommand("run", [
      "analysis.py",
      "--outputs-only",
      "--trace",
    ]).allowsEnvironmentSetup,
    false,
  );
  assertEquals(
    preflightHeadlessCommand("validate", ["analysis.py", "--to=n_summary"])
      .allowsEnvironmentSetup,
    false,
  );
  assertEquals(
    preflightHeadlessCommand("run", ["analysis.py", "--unknown"])
      .allowsEnvironmentSetup,
    false,
  );
});

Deno.test({
  name: "invalid headless option combinations never bootstrap environments",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const root = await Deno.makeTempDir();
    const project = `${root}/project`;
    const paths = getBetaPaths(`${root}/home`);
    await Deno.mkdir(project);
    await Deno.writeTextFile(`${project}/graph.py`, "print('graph')\n");

    const summaryTrace = await runBetaCommand({
      kind: "headless",
      cliCommand: "run",
      args: [project, "--trace=summary"],
      managedEnv: true,
    }, { paths });
    assertEquals(summaryTrace.code, 2);

    const outputsWithTrace = await runBetaCommand({
      kind: "headless",
      cliCommand: "run",
      args: [project, "--outputs-only", "--trace"],
      managedEnv: false,
    }, { paths });
    assertEquals(outputsWithTrace.code, 2);

    await assertRejects(
      () => Deno.stat(`${project}/.venv`),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () => Deno.stat(paths.venvDir),
      Deno.errors.NotFound,
    );
  },
});

Deno.test({
  name: "headless environment failures remain machine readable",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const root = await Deno.makeTempDir();
    const project = `${root}/project`;
    const paths = getBetaPaths(`${root}/home`);
    await Deno.mkdir(`${project}/.venv`, { recursive: true });
    await Deno.writeTextFile(`${project}/graph.py`, "print('graph')\n");

    for (const outputOption of ["--json", "--json=summary", "--outputs-only"]) {
      const messages: string[] = [];
      const originalInfo = console.info;
      console.info = (...values: unknown[]) => {
        messages.push(values.map(String).join(" "));
      };
      let result;
      try {
        result = await runBetaCommand({
          kind: "headless",
          cliCommand: "run",
          args: [project, outputOption],
          managedEnv: false,
        }, { paths });
      } finally {
        console.info = originalInfo;
      }

      assertEquals(result?.code, 1);
      assertEquals(messages.length, 1);
      const payload = JSON.parse(messages[0]);
      assertEquals(payload.ok, false);
      assertEquals(payload.command, "run");
      assertEquals(payload.documentPath, project);
      assertEquals(payload.error.kind, "environment_error");
      assertStringIncludes(
        payload.error.message,
        "Project environment exists but does not contain Python 3.10 or newer",
      );
    }
  },
});

Deno.test("parseBetaCommand maps doctor/reset/update commands", () => {
  assertEquals(parseBetaCommand(["doctor", "--updates"]), {
    kind: "doctor",
    checkUpdates: true,
    json: false,
    managedEnv: false,
  });
  assertEquals(parseBetaCommand(["doctor", "--managed-env"]), {
    kind: "doctor",
    checkUpdates: false,
    json: false,
    managedEnv: true,
  });
  assertEquals(parseBetaCommand(["doctor", "--json"]), {
    kind: "doctor",
    checkUpdates: false,
    json: true,
    managedEnv: false,
  });
  assertEquals(parseBetaCommand(["reset-env"]), { kind: "reset-env" });
  assertEquals(parseBetaCommand(["update"]), { kind: "update" });
});

Deno.test({
  name: "doctor inspection does not create Rowcall state",
  permissions: { read: true, run: true, env: true, write: true },
  async fn() {
    const tempDir = await Deno.makeTempDir();
    const home = `${tempDir}/unused-home`;
    const paths = getBetaPaths(home);

    const report = await buildDoctorReport({
      kind: "doctor",
      checkUpdates: false,
      json: true,
      managedEnv: true,
    }, paths);

    assertEquals(report.runtime.mode, "managed");
    assertEquals(report.runtime.python.status, "missing");
    assertEquals(report.runtime.imports.rowcall, "not_checked");
    assertEquals(report.runtime.imports.matplotlib, "not_checked");
    await assertRejects(() => Deno.stat(paths.dataDir), Deno.errors.NotFound);
  },
});

Deno.test({
  name: "managed environment revision invalidates legacy version-only stamps",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const home = await Deno.makeTempDir();
    const paths = getBetaPaths(home);
    const python = getVenvPythonPath(paths.venvDir);
    const callsPath = `${home}/python-calls.log`;
    await Deno.mkdir(python.slice(0, python.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(
      python,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${callsPath}'\nexit 0\n`,
    );
    await Deno.chmod(python, 0o755);
    await Deno.writeTextFile(
      `${paths.venvDir}/.rowcall-version`,
      `${rowcallVersion}\n`,
    );

    assertEquals(await ensureManagedEnvironment(paths), python);
    const firstCalls = await Deno.readTextFile(callsPath);
    assertEquals(countOccurrences(firstCalls, "-m pip install"), 2);
    assertEquals(
      await Deno.readTextFile(`${paths.venvDir}/.rowcall-version`),
      `${rowcallVersion}:${managedEnvironmentRevision}\n`,
    );

    assertEquals(await ensureManagedEnvironment(paths), python);
    const secondCalls = await Deno.readTextFile(callsPath);
    assertEquals(
      countOccurrences(secondCalls, "-m pip install"),
      countOccurrences(firstCalls, "-m pip install"),
    );
  },
});

Deno.test("parseBetaCommand maps new and example commands", () => {
  assertEquals(parseBetaCommand(["new", "my-work"]), {
    kind: "new",
    targetPath: "my-work",
    openBrowser: false,
    managedEnv: false,
  });
  assertEquals(parseBetaCommand(["new", "my-work", "--open"]), {
    kind: "new",
    targetPath: "my-work",
    openBrowser: true,
    managedEnv: false,
  });
  assertEquals(
    parseBetaCommand([
      "new",
      "my-work",
      "--open",
      "--python",
      "/env/bin/python",
    ]),
    {
      kind: "new",
      targetPath: "my-work",
      openBrowser: true,
      pythonCommand: "/env/bin/python",
      managedEnv: false,
    },
  );
  assertEquals(parseBetaCommand(["example", "sample"]), {
    kind: "example",
    targetPath: "sample",
    openBrowser: false,
    managedEnv: false,
  });
});

Deno.test("buildLauncherInvocation re-execs compiled launchers directly", () => {
  assertEquals(
    buildLauncherInvocation(["__server", "--port", "8000"], {
      execPath: "/Users/me/.local/bin/rowcall",
      mainModule: "file:///var/folders/deno-compile-rowcall/beta_launcher.ts",
    }),
    {
      command: "/Users/me/.local/bin/rowcall",
      args: ["__server", "--port", "8000"],
    },
  );
});

Deno.test("buildLauncherInvocation runs the launcher module in source mode", () => {
  assertEquals(
    buildLauncherInvocation(["__server", "--port", "8000"], {
      execPath: "/Users/me/.deno/bin/deno",
      mainModule: "file:///Users/me/src/rowcall/beta_launcher.ts",
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
        "file:///Users/me/src/rowcall/beta_launcher.ts",
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
  assertThrows(
    () =>
      parseBetaCommand([
        "analysis.py",
        "--python",
        "/env/bin/python",
        "--managed-env",
      ]),
    Error,
    "--python cannot be combined with --managed-env",
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
      "rowcall new",
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
    assertEquals(source.includes("from rowcall import node"), true);
    assertEquals(
      source.includes("shout_message.depends_on(load_message)"),
      true,
    );
    assertEquals(
      await Deno.readTextFile(`${folder}/.gitignore`),
      ".venv/\n__pycache__/\n*.py[cod]\n",
    );
    assertEquals(
      await Deno.readTextFile(`${folder}/requirements.txt`),
      "pandas\npolars\nmatplotlib\n",
    );
    const agentInstructions = await Deno.readTextFile(`${folder}/AGENTS.md`);
    assertStringIncludes(agentInstructions, "rowcall help format");
    assertStringIncludes(agentInstructions, "rowcall validate .");
    assertStringIncludes(agentInstructions, "Do not relaunch Rowcall");
    assertStringIncludes(agentInstructions, "stable node IDs");
  },
});

Deno.test({
  name: "createNewDocument preserves existing project files",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await Deno.makeTempDir();
    const folder = `${dir}/new-project`;
    await Deno.mkdir(folder);
    await Deno.writeTextFile(`${folder}/.gitignore`, "custom/\n");
    await Deno.writeTextFile(`${folder}/AGENTS.md`, "# Custom instructions\n");
    await Deno.writeTextFile(`${folder}/requirements.txt`, "duckdb\n");

    await createNewDocument(folder);

    assertEquals(await Deno.readTextFile(`${folder}/.gitignore`), "custom/\n");
    assertEquals(
      await Deno.readTextFile(`${folder}/AGENTS.md`),
      "# Custom instructions\n",
    );
    assertEquals(
      await Deno.readTextFile(`${folder}/requirements.txt`),
      "duckdb\n",
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
    assertEquals(source.includes("from rowcall import node"), true);
    await assertRejects(
      () => Deno.stat(`${dir}/AGENTS.md`),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () => Deno.stat(`${dir}/requirements.txt`),
      Deno.errors.NotFound,
    );
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
    assertEquals(
      await Deno.readTextFile(`${folder}/.gitignore`),
      ".venv/\n__pycache__/\n*.py[cod]\n",
    );
    assertEquals(
      await Deno.readTextFile(`${folder}/requirements.txt`),
      "pandas\npolars\nmatplotlib\n",
    );
    assertStringIncludes(
      await Deno.readTextFile(`${folder}/AGENTS.md`),
      "Do not relaunch Rowcall",
    );
  },
});

Deno.test({
  name: "ensureProjectEnvironment creates and reuses a project venv",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const folder = await Deno.makeTempDir();
    const documentPath = `${folder}/graph.py`;
    await Deno.writeTextFile(documentPath, "print('graph')\n");

    const first = await ensureProjectEnvironment(documentPath);
    const second = await ensureProjectEnvironment(documentPath);

    assertEquals(first, second);
    assertEquals(first.includes(`${folder}/.venv/`), true);
    assertEquals((await Deno.stat(first)).isFile, true);
    assertEquals(
      await Deno.readTextFile(`${folder}/.venv/.rowcall-setup`),
      "complete\n",
    );
  },
});

Deno.test({
  name:
    "resolveProjectPython uses an active environment without creating a project venv",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const folder = await Deno.makeTempDir();
    const activeDirectory = `${folder}/active`;
    const projectDirectory = `${folder}/project`;
    await Deno.mkdir(projectDirectory);
    await Deno.writeTextFile(
      `${projectDirectory}/graph.py`,
      "print('graph')\n",
    );
    await Deno.writeTextFile(
      `${projectDirectory}/requirements.txt`,
      "this must not be installed\n",
    );
    const activePython = await linkCompatiblePython(activeDirectory);
    const previousVirtualEnv = Deno.env.get("VIRTUAL_ENV");
    const previousCondaPrefix = Deno.env.get("CONDA_PREFIX");
    try {
      Deno.env.set("VIRTUAL_ENV", activeDirectory);
      Deno.env.delete("CONDA_PREFIX");
      assertEquals(
        await resolveProjectPython(`${projectDirectory}/graph.py`, {
          bootstrap: true,
        }),
        activePython,
      );
      await assertRejects(
        () => Deno.stat(`${projectDirectory}/.venv`),
        Deno.errors.NotFound,
      );
      Deno.env.set("VIRTUAL_ENV", `${folder}/missing-active`);
      Deno.env.set("CONDA_PREFIX", activeDirectory);
      assertEquals(
        await resolveProjectPython(`${projectDirectory}/graph.py`, {
          bootstrap: true,
        }),
        activePython,
      );
    } finally {
      restoreEnv("VIRTUAL_ENV", previousVirtualEnv);
      restoreEnv("CONDA_PREFIX", previousCondaPrefix);
    }
  },
});

Deno.test({
  name:
    "resolveProjectPython prefers a project venv and rejects it when broken",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const folder = await Deno.makeTempDir();
    const projectDirectory = `${folder}/project`;
    const activeDirectory = `${folder}/active`;
    await Deno.mkdir(projectDirectory);
    await Deno.writeTextFile(
      `${projectDirectory}/graph.py`,
      "print('graph')\n",
    );
    await Deno.writeTextFile(
      `${projectDirectory}/requirements.txt`,
      "this must not be installed\n",
    );
    const projectPython = await linkCompatiblePython(
      `${projectDirectory}/.venv`,
    );
    await linkCompatiblePython(activeDirectory);
    const previousVirtualEnv = Deno.env.get("VIRTUAL_ENV");
    try {
      Deno.env.set("VIRTUAL_ENV", activeDirectory);
      assertEquals(
        await resolveProjectPython(`${projectDirectory}/graph.py`, {
          bootstrap: true,
        }),
        projectPython,
      );
      await Deno.remove(projectPython);
      await assertRejects(
        () =>
          resolveProjectPython(`${projectDirectory}/graph.py`, {
            bootstrap: false,
          }),
        Error,
        "Remove or repair it, or pass --python",
      );
    } finally {
      restoreEnv("VIRTUAL_ENV", previousVirtualEnv);
    }
  },
});

Deno.test({
  name: "resolveProjectPython validation does not create a project venv",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const folder = await Deno.makeTempDir();
    const documentPath = `${folder}/graph.py`;
    await Deno.writeTextFile(documentPath, "print('graph')\n");
    const previousVirtualEnv = Deno.env.get("VIRTUAL_ENV");
    const previousCondaPrefix = Deno.env.get("CONDA_PREFIX");
    try {
      Deno.env.delete("VIRTUAL_ENV");
      Deno.env.delete("CONDA_PREFIX");
      const python = await resolveProjectPython(documentPath, {
        bootstrap: false,
      });
      assertEquals(["python3", "python"].includes(python), true);
      await assertRejects(
        () => Deno.stat(`${folder}/.venv`),
        Deno.errors.NotFound,
      );
    } finally {
      restoreEnv("VIRTUAL_ENV", previousVirtualEnv);
      restoreEnv("CONDA_PREFIX", previousCondaPrefix);
    }
  },
});

Deno.test({
  name: "ensureProjectEnvironment retries incomplete dependency setup only",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const folder = await Deno.makeTempDir();
    const documentPath = `${folder}/graph.py`;
    const venvDirectory = `${folder}/.venv`;
    await Deno.writeTextFile(documentPath, "print('graph')\n");
    await createPythonVenv(venvDirectory);
    await Deno.writeTextFile(
      `${venvDirectory}/.rowcall-setup`,
      "incomplete\n",
    );
    await Deno.writeTextFile(
      `${folder}/requirements.txt`,
      `missing-package @ file://${folder}/missing-package\n`,
    );

    await assertRejects(
      () => ensureProjectEnvironment(documentPath),
      Error,
      "will retry this one-time setup",
    );
    assertEquals(
      await Deno.readTextFile(`${venvDirectory}/.rowcall-setup`),
      "incomplete\n",
    );

    await Deno.writeTextFile(`${folder}/requirements.txt`, "");
    await ensureProjectEnvironment(documentPath);
    assertEquals(
      await Deno.readTextFile(`${venvDirectory}/.rowcall-setup`),
      "complete\n",
    );

    await Deno.writeTextFile(
      `${folder}/requirements.txt`,
      `missing-package @ file://${folder}/still-missing\n`,
    );
    assertEquals(
      await ensureProjectEnvironment(documentPath),
      getVenvPythonPath(venvDirectory),
    );
  },
});

Deno.test({
  name: "ensureProjectEnvironment resumes interrupted venv creation",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const folder = await Deno.makeTempDir();
    const documentPath = `${folder}/graph.py`;
    const venvDirectory = `${folder}/.venv`;
    const venvPython = getVenvPythonPath(venvDirectory);
    await Deno.writeTextFile(documentPath, "print('graph')\n");
    await Deno.writeTextFile(`${folder}/requirements.txt`, "");
    await createPythonVenv(venvDirectory);
    await removePipFromVenv(venvPython);
    await Deno.writeTextFile(
      `${venvDirectory}/.rowcall-setup`,
      "creating\n",
    );

    assertEquals(await pythonModuleWorks(venvPython, "pip"), false);
    assertEquals(await ensureProjectEnvironment(documentPath), venvPython);
    assertEquals(await pythonModuleWorks(venvPython, "pip"), true);
    assertEquals(
      await Deno.readTextFile(`${venvDirectory}/.rowcall-setup`),
      "complete\n",
    );
  },
});

Deno.test({
  name: "ensureProjectEnvironment resolves local requirements from the project",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const root = await Deno.makeTempDir();
    const folder = `${root}/project`;
    const documentPath = `${folder}/graph.py`;
    const venvDirectory = `${folder}/.venv`;
    const wheelName = "relative_probe-0.0.0-py3-none-any.whl";
    await Deno.mkdir(folder);
    await Deno.writeTextFile(documentPath, "print('graph')\n");
    await createPythonVenv(venvDirectory);
    await Deno.writeTextFile(
      `${venvDirectory}/.rowcall-setup`,
      "incomplete\n",
    );
    await createTestWheel(folder, wheelName);
    await Deno.writeTextFile(
      `${folder}/requirements.txt`,
      `./${wheelName}\n`,
    );

    const originalDirectory = Deno.cwd();
    try {
      Deno.chdir(root);
      await ensureProjectEnvironment("project/graph.py");
    } finally {
      Deno.chdir(originalDirectory);
    }

    const output = await new Deno.Command(getVenvPythonPath(venvDirectory), {
      args: [
        "-c",
        "import relative_probe; assert relative_probe.VALUE == 'project-relative'",
      ],
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(output.success, true);
  },
});

async function linkCompatiblePython(environmentDirectory: string) {
  const python = await systemPythonExecutable();
  const target = getVenvPythonPath(environmentDirectory);
  const parent = target.slice(0, target.lastIndexOf("/"));
  await Deno.mkdir(parent, { recursive: true });
  await Deno.symlink(python, target);
  return target;
}

async function systemPythonExecutable(): Promise<string> {
  const output = await new Deno.Command("python3", {
    args: ["-c", "import sys; print(sys.executable)"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error("python3 is required for launcher tests");
  }
  return new TextDecoder().decode(output.stdout).trim();
}

async function createPythonVenv(directory: string): Promise<void> {
  const output = await new Deno.Command("python3", {
    args: ["-m", "venv", directory],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
}

async function removePipFromVenv(venvPython: string): Promise<void> {
  const output = await new Deno.Command(venvPython, {
    args: ["-c", "import site; print(site.getsitepackages()[0])"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
  const sitePackages = new TextDecoder().decode(output.stdout).trim();
  for await (const entry of Deno.readDir(sitePackages)) {
    if (entry.name === "pip" || entry.name.startsWith("pip-")) {
      await Deno.remove(`${sitePackages}/${entry.name}`, { recursive: true });
    }
  }
}

async function pythonModuleWorks(
  python: string,
  module: string,
): Promise<boolean> {
  const output = await new Deno.Command(python, {
    args: ["-m", module, "--version"],
    stdout: "null",
    stderr: "null",
  }).output();
  return output.success;
}

async function createTestWheel(
  projectDirectory: string,
  wheelName: string,
): Promise<void> {
  const sourceDirectory = `${projectDirectory}/wheel-source`;
  const metadataDirectory = `${sourceDirectory}/relative_probe-0.0.0.dist-info`;
  await Deno.mkdir(metadataDirectory, { recursive: true });
  await Deno.writeTextFile(
    `${sourceDirectory}/relative_probe.py`,
    "VALUE = 'project-relative'\n",
  );
  await Deno.writeTextFile(
    `${metadataDirectory}/METADATA`,
    "Metadata-Version: 2.1\nName: relative-probe\nVersion: 0.0.0\n",
  );
  await Deno.writeTextFile(
    `${metadataDirectory}/WHEEL`,
    "Wheel-Version: 1.0\nGenerator: rowcall-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
  );
  await Deno.writeTextFile(`${metadataDirectory}/RECORD`, "");
  const output = await new Deno.Command("python3", {
    args: [
      "-c",
      [
        "import pathlib, sys, zipfile",
        "root = pathlib.Path(sys.argv[1])",
        "wheel = zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED)",
        "[wheel.write(path, path.relative_to(root)) for path in root.rglob('*') if path.is_file()]",
        "wheel.close()",
      ].join("; "),
      sourceDirectory,
      `${projectDirectory}/${wheelName}`,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
    return;
  }
  Deno.env.set(name, value);
}
