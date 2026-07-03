import { parseArgs } from "@std/cli/parse-args";
import { buildNodebookUrl, startNodebookServer } from "./main.ts";
import {
  type BetaPaths,
  getBetaPaths,
  getVenvPythonPath,
} from "./beta_paths.ts";
import { defaultHostname, defaultPort } from "./startup_args.ts";
import { nodebookVersion } from "./version.ts";

export type BetaCommand =
  | { kind: "help"; topic?: string }
  | { kind: "version" }
  | { kind: "doctor"; checkUpdates: boolean; pythonCommand?: string }
  | { kind: "reset-env" }
  | { kind: "update" }
  | { kind: "new"; targetPath: string; openBrowser: boolean }
  | { kind: "example"; targetPath: string; openBrowser: boolean }
  | {
    kind: "headless";
    cliCommand: "run" | "validate";
    args: string[];
    pythonCommand?: string;
  }
  | {
    kind: "launch";
    documentPath: string;
    openBrowser: boolean;
    pythonCommand?: string;
    port: number;
    hostname: string;
  }
  | {
    kind: "server";
    args: string[];
    uiDistPath?: string;
  };

type RunCommandOptions = {
  paths?: BetaPaths;
};

type CommandResult = {
  code: number;
};

type LauncherRuntime = {
  execPath: string;
  mainModule: string;
};

type LauncherInvocation = {
  command: string;
  args: string[];
};

const bundledSourceRoot = new URL(".", import.meta.url);
const sourceModePermissionArgs = [
  "--allow-read",
  "--allow-write",
  "--allow-net",
  "--allow-run",
  "--allow-env",
];

const defaultDocumentSource = `from nodebook import node


# Nodebook documents are normal Python files.
# Nodes declare outputs; depends_on declares graph edges.
# Run: nodebook validate . && nodebook run . --json
# Help: nodebook help format


@node(id="n_load", outputs=["message"])
def load_message():
    message = "hello from Nodebook"
    return {"message": message}


@node(id="n_shout", outputs=["shouted"])
def shout_message(message):
    shouted = message.upper()
    return {"shouted": shouted}


shout_message.depends_on(load_message)
`;

const exampleDocumentSource = `from pathlib import Path

import polars as pl
from nodebook import node


# Nodebook documents are normal Python files.
# Nodes declare outputs; depends_on declares graph edges.
# Run: nodebook validate . && nodebook run . --json
# Help: nodebook help format


@node(id="n_load_orders", outputs=["orders"])
def load_orders():
    orders = pl.read_csv(Path(__file__).parent / "data" / "orders.csv")
    return {"orders": orders}


@node(id="n_summarize_orders", outputs=["summary"])
def summarize_orders(orders):
    summary = (
        orders
        .group_by("category")
        .agg(
            pl.len().alias("orders"),
            pl.col("amount").sum().alias("revenue"),
        )
        .sort("revenue", descending=True)
    )
    return {"summary": summary}


summarize_orders.depends_on(load_orders)
`;

const exampleOrdersCsv = `order_id,category,amount
1001,Books,28.40
1002,Kitchen,85.00
1003,Books,17.95
1004,Games,64.99
1005,Kitchen,42.50
1006,Games,21.25
`;

const helpText = `Nodebook ${nodebookVersion}

Usage:
  nodebook                         Show this help
  nodebook help [topic]            Show help for a command or topic
  nodebook <path>                  Open an existing folder or .py document
  nodebook open <path>             Open an existing folder or .py document
  nodebook new <path>              Create a Nodebook folder or .py document
  nodebook example <folder>        Create a sample Nodebook project
  nodebook run <path>              Run a document without opening the UI
  nodebook validate <path>         Validate a document without opening the UI
  nodebook doctor                  Inspect the local Nodebook install
  nodebook reset-env               Recreate the managed Python environment
  nodebook update                  Check for a launcher update

Options:
  --python <path>                  Use a specific Python 3.10+ interpreter
  --port <port>                    Start the UI server on a custom port
  --hostname <host>                Bind the UI server to a custom host
  --no-open                        Do not open the browser after starting
  --open                           Open after creating with new/example
  --version                        Print the launcher version

Paths:
  Folders resolve to graph.py inside the folder. For example, nodebook run
  my-work runs my-work/graph.py. Passing a .py path uses that exact file.

Try:
  nodebook new my-work --open
  nodebook example my-example
  nodebook run my-example --json
  nodebook help format
`;

const formatHelpText = `Nodebook Python Document Format

Nodebook documents are normal Python files. A node is a Python function
decorated with @node. The decorator declares stable output names, and the
function returns a dict with those output names.

Example:
  from nodebook import node

  @node(id="n_load", outputs=["numbers"])
  def load_numbers():
      return {"numbers": [1, 2, 3]}

  @node(id="n_total", outputs=["total"])
  def total_numbers(numbers):
      return {"total": sum(numbers)}

  total_numbers.depends_on(load_numbers)

Edges are explicit: depends_on says which upstream nodes may provide inputs.
Function parameters consume upstream outputs by name. Run nodebook validate
<path> to check IDs, outputs, edges, and parameter binding.
`;

const runHelpText = `Usage:
  nodebook run <folder-or-document.py> [--to <node-id-or-function-name>] [--json] [--trace]

Folders resolve to graph.py inside the folder.

Examples:
  nodebook run my-work
  nodebook run my-work --to total_numbers --json
  nodebook run my-work/graph.py --json --trace
`;

const validateHelpText = `Usage:
  nodebook validate <folder-or-document.py> [--json]

Folders resolve to graph.py inside the folder.

Examples:
  nodebook validate my-work
  nodebook validate my-work/graph.py --json
`;

const newHelpText = `Usage:
  nodebook new <folder-or-document.py> [--open]

If the path ends with .py, Nodebook creates that file. Otherwise Nodebook
creates graph.py inside the folder path.

Examples:
  nodebook new my-work
  nodebook new my-work --open
  nodebook new graph.py
`;

const openHelpText = `Usage:
  nodebook open <folder-or-document.py> [--no-open] [--port <port>] [--hostname <host>]

Folders resolve to graph.py inside the folder. The path must already exist.

Examples:
  nodebook open my-work
  nodebook open my-work/explore.py
`;

const exampleHelpText = `Usage:
  nodebook example <folder> [--open]

Creates a sample Nodebook project with graph.py and data/orders.csv.
`;

const doctorHelpText = `Usage:
  nodebook doctor [--updates] [--python <path>]

Inspects the local Nodebook install, managed Python environment, dependency
availability, and log path.
`;

const resetEnvHelpText = `Usage:
  nodebook reset-env

Recreates the managed Python environment used by the launcher.
`;

const updateHelpText = `Usage:
  nodebook update

Checks for launcher updates. Update checks are not implemented yet; rerun the
beta installer to upgrade Nodebook.
`;

export function parseBetaCommand(args: string[]): BetaCommand {
  if (args.length === 0) return { kind: "help" };

  if (args[0] === "__server") {
    return {
      kind: "server",
      args: args.slice(1),
    };
  }

  if (args[0] === "--help" || args[0] === "-h") {
    return { kind: "help" };
  }

  if (args[0] === "help") {
    if (args.length > 2) {
      throw new Error("Usage: nodebook help [topic]");
    }
    const topic = args[1];
    return topic ? { kind: "help", topic } : { kind: "help" };
  }

  if (args[0] === "--version" || args[0] === "-V") {
    return { kind: "version" };
  }

  if (args[0] === "doctor") {
    if (args.includes("--help") || args.includes("-h")) {
      return { kind: "help", topic: "doctor" };
    }
    const parsed = parseArgs(args.slice(1), {
      boolean: ["updates"],
      string: ["python"],
      unknown: rejectUnknownOption,
    });
    return {
      kind: "doctor",
      checkUpdates: Boolean(parsed.updates),
      ...(typeof parsed.python === "string"
        ? { pythonCommand: parsed.python }
        : {}),
    };
  }

  if (args[0] === "reset-env") {
    if (args.includes("--help") || args.includes("-h")) {
      return { kind: "help", topic: "reset-env" };
    }
    if (args.length > 1) {
      throw new Error("Usage: nodebook reset-env");
    }
    return { kind: "reset-env" };
  }

  if (args[0] === "update") {
    if (args.includes("--help") || args.includes("-h")) {
      return { kind: "help", topic: "update" };
    }
    if (args.length > 1) {
      throw new Error("Usage: nodebook update");
    }
    return { kind: "update" };
  }

  if (args[0] === "new") {
    if (args.includes("--help") || args.includes("-h")) {
      return { kind: "help", topic: "new" };
    }
    const parsed = parseArgs(args.slice(1), {
      boolean: ["open"],
      unknown: rejectUnknownOption,
    });
    if (parsed._.length !== 1 || typeof parsed._[0] !== "string") {
      throw new Error("Usage: nodebook new <folder-or-document.py> [--open]");
    }
    return {
      kind: "new",
      targetPath: parsed._[0],
      openBrowser: Boolean(parsed.open),
    };
  }

  if (args[0] === "example") {
    if (args.includes("--help") || args.includes("-h")) {
      return { kind: "help", topic: "example" };
    }
    const parsed = parseArgs(args.slice(1), {
      boolean: ["open"],
      unknown: rejectUnknownOption,
    });
    if (parsed._.length !== 1 || typeof parsed._[0] !== "string") {
      throw new Error("Usage: nodebook example <folder> [--open]");
    }
    return {
      kind: "example",
      targetPath: parsed._[0],
      openBrowser: Boolean(parsed.open),
    };
  }

  if (args[0] === "run" || args[0] === "validate") {
    if (args.includes("--help") || args.includes("-h")) {
      return { kind: "help", topic: args[0] };
    }
    const { pythonCommand, forwardedArgs } = stripGlobalPythonOption(
      args.slice(1),
    );
    return {
      kind: "headless",
      cliCommand: args[0],
      args: forwardedArgs,
      ...(pythonCommand ? { pythonCommand } : {}),
    };
  }

  const openArgs = args[0] === "open" ? args.slice(1) : args;
  if (
    args[0] === "open" &&
    (openArgs.includes("--help") || openArgs.includes("-h"))
  ) {
    return { kind: "help", topic: "open" };
  }

  const parsed = parseArgs(openArgs, {
    boolean: ["no-open"],
    string: ["python", "port", "hostname"],
    unknown: rejectUnknownOption,
  });
  if (parsed._.length !== 1 || typeof parsed._[0] !== "string") {
    throw new Error("Expected exactly one folder or .py document path.");
  }

  return {
    kind: "launch",
    documentPath: parsed._[0],
    openBrowser: !parsed["no-open"],
    ...(typeof parsed.python === "string"
      ? { pythonCommand: parsed.python }
      : {}),
    port: parsePortOption(parsed.port),
    hostname: typeof parsed.hostname === "string"
      ? parsed.hostname
      : defaultHostname,
  };
}

export async function runBetaCommand(
  command: BetaCommand,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const paths = options.paths ?? getBetaPaths();
  switch (command.kind) {
    case "help":
      console.info(helpTextForTopic(command.topic));
      return { code: 0 };
    case "version":
      console.info(nodebookVersion);
      return { code: 0 };
    case "doctor":
      await appendLog(paths, `nodebook ${command.kind}`);
      await printDoctor(command, paths);
      return { code: 0 };
    case "reset-env":
      await appendLog(paths, `nodebook ${command.kind}`);
      await resetManagedEnvironment(paths);
      await ensureManagedEnvironment(paths);
      console.info(`Recreated managed Python environment: ${paths.venvDir}`);
      return { code: 0 };
    case "update":
      await appendLog(paths, `nodebook ${command.kind}`);
      console.info(
        "Update checks are not implemented yet. Rerun the beta installer to upgrade Nodebook.",
      );
      return { code: 1 };
    case "new": {
      const documentPath = await createNewDocument(command.targetPath);
      if (!command.openBrowser) return { code: 0 };
      await appendLog(paths, `nodebook ${command.kind}`);
      await ensureManagedEnvironment(paths);
      await ensureBundledAssets(paths);
      await ensureServerPortAvailable(defaultHostname, defaultPort);
      return await launchServer({
        kind: "launch",
        documentPath,
        openBrowser: true,
        port: defaultPort,
        hostname: defaultHostname,
      }, paths);
    }
    case "example": {
      const documentPath = await createExampleProject(command.targetPath);
      if (!command.openBrowser) return { code: 0 };
      await appendLog(paths, `nodebook ${command.kind}`);
      await ensureManagedEnvironment(paths);
      await ensureBundledAssets(paths);
      await ensureServerPortAvailable(defaultHostname, defaultPort);
      return await launchServer({
        kind: "launch",
        documentPath,
        openBrowser: true,
        port: defaultPort,
        hostname: defaultHostname,
      }, paths);
    }
    case "headless": {
      await appendLog(paths, `nodebook ${command.kind}`);
      const python = await ensureManagedEnvironment(
        paths,
        command.pythonCommand,
      );
      const status = await runChild(python, [
        "-m",
        "nodebook",
        command.cliCommand,
        ...command.args,
      ]);
      return { code: status.code };
    }
    case "launch":
      await appendLog(paths, `nodebook ${command.kind}`);
      command = {
        ...command,
        documentPath: await resolveExistingDocumentPath(command.documentPath),
      };
      await ensureManagedEnvironment(paths, command.pythonCommand);
      await ensureBundledAssets(paths);
      await ensureServerPortAvailable(command.hostname, command.port);
      return await launchServer(command, paths);
    case "server":
      await startNodebookServer(command.args, {
        ...(command.uiDistPath ? { uiDistPath: command.uiDistPath } : {}),
      });
      return { code: 0 };
  }
}

function helpTextForTopic(topic: string | undefined): string {
  switch (topic) {
    case undefined:
      return helpText;
    case "format":
      return formatHelpText;
    case "run":
      return runHelpText;
    case "validate":
      return validateHelpText;
    case "new":
      return newHelpText;
    case "open":
      return openHelpText;
    case "example":
    case "examples":
      return exampleHelpText;
    case "doctor":
      return doctorHelpText;
    case "reset-env":
      return resetEnvHelpText;
    case "update":
      return updateHelpText;
    default:
      throw new Error(`Unknown help topic: ${topic}`);
  }
}

export async function resolveExistingDocumentPath(
  path: string,
): Promise<string> {
  try {
    const stat = await Deno.stat(path);
    if (stat.isDirectory) {
      const documentPath = `${path.replace(/\/+$/, "")}/graph.py`;
      const documentStat = await Deno.stat(documentPath).catch((error) => {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
      });
      if (!documentStat?.isFile) {
        throw new Error(
          `Nodebook folder does not contain graph.py: ${path}\n\nCreate it with:\n  nodebook new ${path}`,
        );
      }
      return documentPath;
    }
    if (!stat.isFile) {
      throw new Error(`Nodebook path is not a file or directory: ${path}`);
    }
    if (!path.endsWith(".py")) {
      throw new Error(
        "Nodebook document path must be a .py file or a folder containing graph.py.",
      );
    }
    return path;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  const noun = path.endsWith(".py") ? "Nodebook document" : "Nodebook folder";
  throw new Error(
    `Path not found: ${path}\n\nCreate a new ${noun}:\n  nodebook new ${path}\n\nCreate and open it:\n  nodebook new ${path} --open`,
  );
}

export async function createNewDocument(targetPath: string): Promise<string> {
  const standaloneFile = targetPath.endsWith(".py");
  const folderPath = standaloneFile
    ? undefined
    : targetPath.replace(/\/+$/, "");
  const documentPath = standaloneFile ? targetPath : `${folderPath}/graph.py`;

  try {
    const stat = await Deno.stat(documentPath);
    if (stat.isFile) {
      throw new Error(`Nodebook document already exists: ${documentPath}`);
    }
    throw new Error(`Nodebook document path is not a file: ${documentPath}`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  if (folderPath) {
    await Deno.mkdir(folderPath, { recursive: true });
  } else {
    const parent = getParentDirectory(documentPath);
    if (parent) {
      try {
        const stat = await Deno.stat(parent);
        if (!stat.isDirectory) {
          throw new Error(`Parent path is not a directory: ${parent}`);
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          throw new Error(
            `Parent directory does not exist: ${parent}. Create it first, or pass a folder path to nodebook new.`,
          );
        }
        throw error;
      }
    }
  }

  await Deno.writeTextFile(documentPath, defaultDocumentSource);
  console.info(`Created new Nodebook document: ${documentPath}`);
  return documentPath;
}

export async function createExampleProject(
  targetPath: string,
): Promise<string> {
  if (targetPath.endsWith(".py")) {
    throw new Error("nodebook example expects a folder path, not a .py file.");
  }
  const directory = targetPath.replace(/\/+$/, "");
  const documentPath = `${directory}/graph.py`;
  const dataPath = `${directory}/data/orders.csv`;
  if (await pathExists(documentPath)) {
    throw new Error(`Nodebook document already exists: ${documentPath}`);
  }
  if (await pathExists(dataPath)) {
    throw new Error(`Example data file already exists: ${dataPath}`);
  }
  const parent = getParentDirectory(directory);
  if (parent) {
    try {
      const stat = await Deno.stat(parent);
      if (!stat.isDirectory) {
        throw new Error(`Parent path is not a directory: ${parent}`);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(
          `Parent directory does not exist: ${parent}. Create it first, or pass an existing directory.`,
        );
      }
      throw error;
    }
  }
  await Deno.mkdir(`${directory}/data`, { recursive: true });
  await Deno.writeTextFile(documentPath, exampleDocumentSource);
  await Deno.writeTextFile(dataPath, exampleOrdersCsv);
  console.info(`Created Nodebook example: ${directory}`);
  console.info(`Open it with: nodebook open ${directory}`);
  return documentPath;
}

export async function ensureManagedEnvironment(
  paths: BetaPaths,
  pythonOverride?: string,
): Promise<string> {
  await Deno.mkdir(paths.logsDir, { recursive: true });
  const venvPython = getVenvPythonPath(paths.venvDir);
  if (await commandWorks(venvPython, ["--version"])) {
    if (await managedEnvironmentVersion(paths) !== nodebookVersion) {
      await installBundledPythonRuntime(paths, venvPython);
      await writeManagedEnvironmentVersion(paths);
    }
    return venvPython;
  }

  const basePython = pythonOverride ?? await findCompatiblePython();
  await runChecked(basePython, ["-m", "venv", paths.venvDir]);
  await installBundledPythonRuntime(paths, venvPython);
  await writeManagedEnvironmentVersion(paths);
  return venvPython;
}

export async function resetManagedEnvironment(paths: BetaPaths): Promise<void> {
  await Deno.remove(paths.venvDir, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
}

async function installBundledPythonRuntime(
  paths: BetaPaths,
  venvPython: string,
): Promise<void> {
  await ensureBundledAssets(paths);
  if (!await pathExists(paths.bundledPythonPackageDir)) {
    throw new Error(
      `Bundled Nodebook Python package was not materialized at ${paths.bundledPythonPackageDir}`,
    );
  }
  await runChecked(venvPython, [
    "-m",
    "pip",
    "install",
    paths.bundledPythonPackageDir,
  ]);

  if (await pathExists(paths.bundledRequirementsPath)) {
    await runChecked(venvPython, [
      "-m",
      "pip",
      "install",
      "-r",
      paths.bundledRequirementsPath,
    ]);
  }
}

async function managedEnvironmentVersion(
  paths: BetaPaths,
): Promise<string | null> {
  try {
    return (await Deno.readTextFile(managedEnvironmentVersionPath(paths)))
      .trim();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function writeManagedEnvironmentVersion(paths: BetaPaths): Promise<void> {
  await Deno.writeTextFile(
    managedEnvironmentVersionPath(paths),
    `${nodebookVersion}\n`,
  );
}

function managedEnvironmentVersionPath(paths: BetaPaths): string {
  return `${paths.venvDir}/.nodebook-version`;
}

async function ensureBundledAssets(paths: BetaPaths): Promise<void> {
  await Deno.mkdir(paths.bundledDir, { recursive: true });
  await copyRequirementsIfExists(
    bundledSource("requirements-alpha.txt"),
    paths.bundledRequirementsPath,
  );
  await copyDirectoryIfExists(
    bundledSource("nodebook"),
    `${paths.bundledPythonPackageDir}/nodebook`,
  );
  await copyIfExists(
    bundledSource("pyproject.toml"),
    `${paths.bundledPythonPackageDir}/pyproject.toml`,
  );
  await copyDirectoryIfExists(bundledSource("app/ui/dist"), paths.uiDistPath);
}

async function printDoctor(
  command: Extract<BetaCommand, { kind: "doctor" }>,
  paths: BetaPaths,
): Promise<void> {
  const detectedPython = command.pythonCommand ??
    await findCompatiblePython().catch(() => "");
  const venvPython = getVenvPythonPath(paths.venvDir);
  const venvExists = await commandWorks(venvPython, ["--version"]);
  const nodebookImport = venvExists
    ? await commandWorks(venvPython, ["-c", "import nodebook"])
    : false;
  const pandasImport = venvExists
    ? await commandWorks(venvPython, ["-c", "import pandas"])
    : false;
  const polarsImport = venvExists
    ? await commandWorks(venvPython, ["-c", "import polars"])
    : false;

  console.info(`Nodebook ${nodebookVersion}`);
  console.info(`Data directory: ${paths.dataDir}`);
  console.info(`Managed venv: ${paths.venvDir}`);
  console.info(`Log file: ${paths.logFile}`);
  console.info(
    `PATH contains ~/.local/bin: ${
      pathContainsLocalBin(paths.home) ? "ok" : "missing"
    }`,
  );
  console.info(`Python 3.10+: ${detectedPython || "not found"}`);
  console.info(`Venv Python: ${venvExists ? venvPython : "missing"}`);
  console.info(`nodebook package: ${nodebookImport ? "ok" : "missing"}`);
  console.info(`pandas: ${pandasImport ? "ok" : "missing"}`);
  console.info(`polars: ${polarsImport ? "ok" : "missing"}`);
  if (command.checkUpdates) {
    console.info("Update checks are not implemented yet.");
  }

  if (!venvExists || !nodebookImport || !pandasImport || !polarsImport) {
    console.info("");
    console.info("Fix: nodebook reset-env");
  }
}

async function launchServer(
  command: Extract<BetaCommand, { kind: "launch" }>,
  paths: BetaPaths,
): Promise<CommandResult> {
  const authToken = crypto.randomUUID();
  const serverArgs = [
    "__server",
    "--document",
    command.documentPath,
    "--port",
    String(command.port),
    "--hostname",
    command.hostname,
    "--auth-token",
    authToken,
    "--python",
    getVenvPythonPath(paths.venvDir),
    "--ui-dist",
    paths.uiDistPath,
  ];
  const invocation = buildLauncherInvocation(serverArgs);
  const server = new Deno.Command(invocation.command, {
    args: invocation.args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stdoutDone = teeProcessOutput(server.stdout, Deno.stdout, paths);
  const stderrDone = teeProcessOutput(server.stderr, Deno.stderr, paths);
  const serverStatus = server.status;
  const url = buildNodebookUrl(command.hostname, command.port, authToken);
  try {
    await waitForServer(url, serverStatus);
  } catch (error) {
    try {
      server.kill("SIGTERM");
    } catch {
      // The server may already have exited.
    }
    throw error;
  }
  console.info(`Nodebook is running at ${url}`);
  if (command.openBrowser) {
    await openBrowser(url);
  }
  const status = await serverStatus;
  await Promise.allSettled([stdoutDone, stderrDone]);
  return { code: status.code };
}

export function buildLauncherInvocation(
  serverArgs: string[],
  runtime: LauncherRuntime = {
    execPath: Deno.execPath(),
    mainModule: Deno.mainModule,
  },
): LauncherInvocation {
  if (!isDenoExecutable(runtime.execPath)) {
    return {
      command: runtime.execPath,
      args: serverArgs,
    };
  }

  return {
    command: runtime.execPath,
    args: [
      "run",
      ...sourceModePermissionArgs,
      runtime.mainModule,
      ...serverArgs,
    ],
  };
}

function isDenoExecutable(execPath: string): boolean {
  const executableName = execPath.split(/[\\/]/).at(-1);
  return executableName === "deno" || executableName === "deno.exe";
}

function stripGlobalPythonOption(args: string[]): {
  pythonCommand?: string;
  forwardedArgs: string[];
} {
  const forwardedArgs: string[] = [];
  let pythonCommand: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--python") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value after --python");
      }
      pythonCommand = value;
      index += 1;
      continue;
    }
    forwardedArgs.push(arg);
  }
  return {
    ...(pythonCommand ? { pythonCommand } : {}),
    forwardedArgs,
  };
}

function parsePortOption(value: unknown): number {
  if (value === undefined) return defaultPort;
  if (typeof value !== "string") {
    throw new Error("Invalid --port value");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${value}`);
  }
  return port;
}

function rejectUnknownOption(option: string): boolean {
  if (!option.startsWith("-")) return true;
  throw new Error(`Unknown option: ${option}`);
}

async function findCompatiblePython(): Promise<string> {
  for (const command of ["python3", "python"]) {
    if (await isCompatiblePython(command)) {
      return command;
    }
  }
  throw new Error("Could not find Python 3.10 or newer.");
}

async function isCompatiblePython(command: string): Promise<boolean> {
  return await commandWorks(command, [
    "-c",
    "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)",
  ]);
}

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  try {
    const output = await new Deno.Command(command, {
      args,
      stdout: "null",
      stderr: "null",
    }).output();
    return output.success;
  } catch {
    return false;
  }
}

async function runChecked(command: string, args: string[]): Promise<void> {
  const output = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  await forwardSetupOutput(output);
  if (!output.success) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${output.code}`,
    );
  }
}

async function forwardSetupOutput(output: Deno.CommandOutput): Promise<void> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const text = `${decoder.decode(output.stdout)}${
    decoder.decode(output.stderr)
  }`;
  if (text.length > 0) {
    await Deno.stderr.write(encoder.encode(text));
  }
}

async function runChild(
  command: string,
  args: string[],
): Promise<Deno.CommandStatus> {
  return await new Deno.Command(command, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
}

function ensureServerPortAvailable(
  hostname: string,
  port: number,
): void {
  let listener: Deno.Listener | undefined;
  try {
    listener = Deno.listen({ hostname, port });
  } catch (error) {
    if (error instanceof Deno.errors.AddrInUse) {
      throw new Error(
        `Port ${port} is already in use on ${hostname}. Stop the process using it, or start Nodebook with --port ${
          port + 1
        }.`,
      );
    }
    throw error;
  } finally {
    listener?.close();
  }
}

async function waitForServer(
  url: string,
  status: Promise<Deno.CommandStatus>,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      fetch(url).then(async (response) => {
        await response.body?.cancel().catch(() => {});
        return response.ok ? "ready" as const : "not-ready" as const;
      }).catch(() => "not-ready" as const),
      status.then((serverStatus) => ({
        kind: "exited" as const,
        code: serverStatus.code,
      })),
      delay(150).then(() => "not-ready" as const),
    ]);
    if (result === "ready") return;
    if (typeof result === "object" && result.kind === "exited") {
      throw new Error(
        `Nodebook server exited before it was ready (exit code ${result.code})`,
      );
    }
  }
  throw new Error(`Timed out waiting for Nodebook server at ${url}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function teeProcessOutput(
  stream: ReadableStream<Uint8Array>,
  output: { write(chunk: Uint8Array): Promise<number> },
  paths: BetaPaths,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    await output.write(value);
    await appendLog(paths, decoder.decode(value));
  }
}

async function appendLog(paths: BetaPaths, message: string): Promise<void> {
  await Deno.mkdir(paths.logsDir, { recursive: true });
  const timestamp = new Date().toISOString();
  await Deno.writeTextFile(paths.logFile, `[${timestamp}] ${message}\n`, {
    append: true,
  }).catch(() => {
    // Logging should never prevent Nodebook from starting.
  });
}

async function openBrowser(url: string): Promise<void> {
  const output = await new Deno.Command("open", {
    args: [url],
    stdout: "null",
    stderr: "piped",
  }).output().catch(() => null);
  if (!output || output.success) return;
  const stderr = new TextDecoder().decode(output.stderr).trim();
  console.warn(
    `Could not open browser automatically${stderr ? `: ${stderr}` : ""}`,
  );
}

function bundledSource(path: string): URL {
  return new URL(path, bundledSourceRoot);
}

async function copyIfExists(from: string | URL, to: string): Promise<void> {
  if (!await pathExists(from)) return;
  await Deno.mkdir(getParentDirectory(to) ?? ".", { recursive: true });
  await Deno.writeFile(to, await Deno.readFile(from));
}

async function copyRequirementsIfExists(
  from: string | URL,
  to: string,
): Promise<void> {
  if (!await pathExists(from)) return;
  const source = await Deno.readTextFile(from);
  const filtered = source.split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== "-e ." && !trimmed.startsWith("-e ./");
    })
    .join("\n")
    .trimEnd();
  await Deno.mkdir(getParentDirectory(to) ?? ".", { recursive: true });
  await Deno.writeTextFile(to, `${filtered}\n`);
}

async function copyDirectoryIfExists(
  from: string | URL,
  to: string,
): Promise<void> {
  if (!await pathExists(from)) return;
  await Deno.remove(to, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const source = joinSourcePath(from, entry.name);
    const target = `${to}/${entry.name}`;
    if (entry.isDirectory) {
      await copyDirectoryIfExists(source, target);
    } else if (entry.isFile) {
      await Deno.writeFile(target, await Deno.readFile(source));
    }
  }
}

function joinSourcePath(base: string | URL, name: string): string | URL {
  if (base instanceof URL) {
    return new URL(name, ensureDirectoryUrl(base));
  }
  return `${base}/${name}`;
}

function ensureDirectoryUrl(url: URL): URL {
  return new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
}

async function pathExists(path: string | URL): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function getParentDirectory(path: string): string | undefined {
  const normalizedPath = path.replaceAll("\\", "/");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex < 0) return undefined;
  if (separatorIndex === 0) return "/";
  return path.slice(0, separatorIndex);
}

function pathContainsLocalBin(home: string): boolean {
  const path = Deno.env.get("PATH") ?? "";
  return path.split(":").includes(`${home}/.local/bin`);
}

if (import.meta.main) {
  try {
    const command = parseBetaCommand(Deno.args);
    if (command.kind === "server") {
      const parsed = parseArgs(command.args, {
        string: ["ui-dist"],
        collect: [],
        unknown: () => true,
      });
      const forwardedArgs = command.args.filter((arg, index) => {
        if (arg === "--ui-dist") return false;
        if (index > 0 && command.args[index - 1] === "--ui-dist") return false;
        return true;
      });
      const result = await runBetaCommand({
        kind: "server",
        args: forwardedArgs,
        ...(typeof parsed["ui-dist"] === "string"
          ? { uiDistPath: parsed["ui-dist"] }
          : {}),
      });
      Deno.exit(result.code);
    }
    const result = await runBetaCommand(command);
    Deno.exit(result.code);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
