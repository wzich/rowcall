import { parseArgs } from "@std/cli/parse-args";
import { buildRowcallUrl, startRowcallServer } from "./main.ts";
import {
  getLauncherPaths,
  getVenvPythonPath,
  type LauncherPaths,
} from "./launcher_paths.ts";
import { getActiveEnvironmentPythonCandidates } from "./runtime_config.ts";
import { defaultHostname, defaultPort } from "./startup_args.ts";
import { rowcallVersion } from "./version.ts";

export type LauncherCommand =
  | { kind: "help"; topic?: string }
  | { kind: "version" }
  | {
    kind: "doctor";
    checkUpdates: boolean;
    json: boolean;
    pythonCommand?: string;
    managedEnv: boolean;
  }
  | { kind: "reset-env" }
  | { kind: "update" }
  | {
    kind: "new";
    targetPath: string;
    openBrowser: boolean;
    pythonCommand?: string;
    managedEnv: boolean;
  }
  | {
    kind: "example";
    targetPath: string;
    openBrowser: boolean;
    pythonCommand?: string;
    managedEnv: boolean;
  }
  | {
    kind: "headless";
    cliCommand: "run" | "validate";
    args: string[];
    pythonCommand?: string;
    managedEnv: boolean;
  }
  | {
    kind: "launch";
    documentPath: string;
    openBrowser: boolean;
    pythonCommand?: string;
    managedEnv: boolean;
    port: number;
    hostname: string;
  }
  | {
    kind: "server";
    args: string[];
    uiDistPath?: string;
  };

type RunCommandOptions = {
  paths?: LauncherPaths;
};

type RuntimeSelection = {
  mode: "user" | "managed";
  pythonCommand?: string;
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
// Increment when bundled runtime dependencies must refresh independently of
// the public Rowcall version.
export const managedEnvironmentRevision = 1;
const sourceModePermissionArgs = [
  "--allow-read",
  "--allow-write",
  "--allow-net",
  "--allow-run",
  "--allow-env",
];

const defaultDocumentSource = `from rowcall import node


@node(id="n_load", outputs=["message"])
def load_message():
    message = "hello from Rowcall"
    return {"message": message}


@node(id="n_shout", outputs=["shouted"])
def shout_message(message):
    shouted = message.upper()
    return {"shouted": shouted}


shout_message.depends_on(load_message.output("message"))
`;

const defaultGitignore = `.venv/
__pycache__/
*.py[cod]
`;

const defaultAgentInstructions = `# Rowcall

- Edit \`graph.py\` directly. Node functions must follow \`rowcall help format\`.
- After edits, run \`rowcall validate .\`; run \`rowcall run . --json=summary\` when execution is needed.
- Do not relaunch Rowcall after every edit. The open UI reloads changes from disk.
- Use bare \`display(value)\` for human-facing results; add \`label="..."\` when useful; do not call \`plt.show()\` or manually export image bytes.
- Keep dependencies in \`requirements.txt\` and the project environment.
- Canvas metadata, when present, is in \`graph.rowcall.json\`; match it to stable node IDs in \`graph.py\`.
`;

const defaultRequirements = `pandas
polars
matplotlib
`;

const exampleDocumentSource = `from pathlib import Path

import polars as pl
from rowcall import node


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
    display(summary, label="Orders by category")
    return {"summary": summary}


summarize_orders.depends_on(load_orders.output("orders"))
`;

const exampleOrdersCsv = `order_id,category,amount
1001,Books,28.40
1002,Kitchen,85.00
1003,Books,17.95
1004,Games,64.99
1005,Kitchen,42.50
1006,Games,21.25
`;

const helpText = `Rowcall ${rowcallVersion}

Usage:
  rowcall                         Show this help
  rowcall help [topic]            Show help for a command or topic
  rowcall <path>                  Open an existing folder or .py document
  rowcall open <path>             Open an existing folder or .py document
  rowcall new <path>              Create a Rowcall folder or .py document
  rowcall example <folder>        Create a sample Rowcall project
  rowcall run <path>              Run a document without opening the UI
  rowcall validate <path>         Validate a document without opening the UI
  rowcall doctor                  Inspect the local Rowcall install
  rowcall reset-env               Recreate the managed Python environment
  rowcall update                  Check for a launcher update

Options:
  --python <path>                  Use a specific Python 3.10+ interpreter
  --managed-env                    Use Rowcall's managed Python environment
  --port <port>                    Start the UI server on a custom port
  --hostname <host>                Bind the UI server to a custom host
  --no-open                        Do not open the browser after starting
  --open                           Open after creating with new/example
  --version                        Print the launcher version

Paths:
  Folders resolve to graph.py inside the folder. For example, rowcall run
  my-work runs my-work/graph.py. Passing a .py path uses that exact file.

Try:
  rowcall new my-work --open
  rowcall example my-example
  rowcall run my-example --json
  rowcall help format

Working with coding agents:
  Let an agent edit graph.py directly, then run rowcall validate <path>.
  Run rowcall run <path> --json=summary when execution is needed. Open the
  Rowcall UI once; it reloads changes from disk. New folder projects created
  with rowcall new or rowcall example include a short project-specific
  AGENTS.md.

Open and run prefer an existing project .venv, then an active virtualenv or
Conda environment. If neither exists, they create a project .venv and install
its requirements.txt. Rowcall-created project environments refresh dependencies
when requirements.txt changes; pre-existing and active environments are never
modified automatically. Validate uses the same existing-environment order but
never creates an environment or installs packages. Pass --python to use a
specific interpreter or --managed-env to use Rowcall's shared starter environment.
`;

const formatHelpText = `Rowcall Python Document Format

Rowcall documents are normal Python files. A node is a Python function
decorated with @node. The decorator declares stable output names. Human-facing
results use bare display(value, label="...") calls. Every declared
output must exist as a same-named local variable (parameters already count).
Assign computed values in the function body, then end with one generated return
dictionary.

Example:
  from rowcall import node

  @node(id="n_load", outputs=["numbers"])
  def load_numbers():
      numbers = [1, 2, 3]
      return {"numbers": numbers}

  @node(id="n_total", outputs=["total"])
  def total_numbers(numbers):
      total = sum(numbers)
      display(total, label="Total")
      return {"total": total}

  total_numbers.depends_on(load_numbers.output("numbers"))

Return requirements:
  - Use exactly one return statement, last in the node function.
  - Return a dictionary literal.
  - Map each returned name directly to its same-named variable.
  - Use return {} when outputs=[]; do not return expressions inline.

Outputs flow to downstream nodes. Displays are only for human inspection and
never flow downstream. Displays support normal table/value previews and static
PNGs from PNG bytes, objects with
a _repr_png_() method, Matplotlib figures or axes, Seaborn plots, Pillow images,
and Plotly figures when Kaleido and Chrome or Chromium are available. Call
display() with the plotting object; do not call plt.show() or export image bytes
yourself. Interactive JavaScript displays are not supported.

Invalid:
  return {"total": sum(numbers)}

Valid:
  total = sum(numbers)
  return {"total": total}

Edges are explicit: depends_on routes named upstream outputs into node inputs.
Function parameters consume upstream outputs by name. Run rowcall validate
<path> after every edit to check returns, IDs, outputs, edges, and
parameter binding.
`;

const runHelpText = `Usage:
  rowcall run <folder-or-document.py> [--to <node-id-or-function-name>] [--json|--json=summary] [--trace|--trace=summary] [--python <path>] [--managed-env]
  rowcall run <folder-or-document.py> [--to <node-id-or-function-name>] --outputs-only [--python <path>] [--managed-env]

Folders resolve to graph.py inside the folder.
Run prefers a compatible project .venv, then an active virtualenv or Conda
environment. If neither exists, it creates .venv and installs requirements.txt
and refreshes dependencies when that file changes. Pre-existing and active
environments are never modified automatically.

Examples:
  rowcall run my-work
  rowcall run my-work --to total_numbers --json
  rowcall run my-work --to total_numbers --outputs-only
  rowcall run my-work --json=summary --trace=summary
  rowcall run my-work/graph.py --json --trace
`;

const validateHelpText = `Usage:
  rowcall validate <folder-or-document.py> [--json] [--python <path>] [--managed-env]

Folders resolve to graph.py inside the folder.
See rowcall help format for the required node and return structure.
Validate prefers an existing project .venv, then an active environment, then
system Python. It never creates .venv or installs requirements.txt.

Examples:
  rowcall validate my-work
  rowcall validate my-work/graph.py --json
`;

const newHelpText = `Usage:
  rowcall new <folder-or-document.py> [--open] [--python <path>] [--managed-env]

If the path ends with .py, Rowcall creates that file. Otherwise Rowcall
creates graph.py, .gitignore, AGENTS.md, and requirements.txt inside the folder
path. Existing .gitignore, AGENTS.md, and requirements.txt files are preserved.
Opening prefers an existing project .venv, then an active environment. If
neither exists, it creates the project's .venv and installs requirements.txt.

Examples:
  rowcall new my-work
  rowcall new my-work --open
  rowcall new my-work --open --python /path/to/python
  rowcall new graph.py
`;

const openHelpText = `Usage:
  rowcall open <folder-or-document.py> [--no-open] [--port <port>] [--hostname <host>] [--python <path>] [--managed-env]

Folders resolve to graph.py inside the folder. The path must already exist.
Open prefers an existing project .venv, then an active environment. If neither
exists, it creates the project's .venv and installs requirements.txt. A
Rowcall-created environment refreshes dependencies when that file changes.

Examples:
  rowcall open my-work
  rowcall open my-work/explore.py
`;

const exampleHelpText = `Usage:
  rowcall example <folder> [--open] [--python <path>] [--managed-env]

Creates a sample Rowcall project with graph.py, data/orders.csv, lightweight
agent guidance, and starter requirements.
`;

const doctorHelpText = `Usage:
  rowcall doctor [--updates] [--json] [--python <path>] [--managed-env]

Inspects the local Rowcall install, selected Python environment, dependency
availability, and log path without modifying Rowcall state.
`;

const resetEnvHelpText = `Usage:
  rowcall reset-env

Recreates the managed Python environment used by the launcher.
`;

const updateHelpText = `Usage:
  rowcall update

Checks for launcher updates. Update checks are not implemented yet; rerun the
beta installer to upgrade Rowcall.
`;

export function parseLauncherCommand(args: string[]): LauncherCommand {
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
      throw new Error("Usage: rowcall help [topic]");
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
      boolean: ["updates", "json", "managed-env"],
      string: ["python"],
      unknown: rejectUnknownOption,
    });
    rejectPythonWithManagedEnv(parsed.python, parsed["managed-env"]);
    return {
      kind: "doctor",
      checkUpdates: Boolean(parsed.updates),
      json: Boolean(parsed.json),
      managedEnv: Boolean(parsed["managed-env"]),
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
      throw new Error("Usage: rowcall reset-env");
    }
    return { kind: "reset-env" };
  }

  if (args[0] === "update") {
    if (args.includes("--help") || args.includes("-h")) {
      return { kind: "help", topic: "update" };
    }
    if (args.length > 1) {
      throw new Error("Usage: rowcall update");
    }
    return { kind: "update" };
  }

  if (args[0] === "new") {
    if (args.includes("--help") || args.includes("-h")) {
      return { kind: "help", topic: "new" };
    }
    const parsed = parseArgs(args.slice(1), {
      boolean: ["open", "managed-env"],
      string: ["python"],
      unknown: rejectUnknownOption,
    });
    rejectPythonWithManagedEnv(parsed.python, parsed["managed-env"]);
    if (parsed._.length !== 1 || typeof parsed._[0] !== "string") {
      throw new Error("Usage: rowcall new <folder-or-document.py> [--open]");
    }
    return {
      kind: "new",
      targetPath: parsed._[0],
      openBrowser: Boolean(parsed.open),
      managedEnv: Boolean(parsed["managed-env"]),
      ...(typeof parsed.python === "string"
        ? { pythonCommand: parsed.python }
        : {}),
    };
  }

  if (args[0] === "example") {
    if (args.includes("--help") || args.includes("-h")) {
      return { kind: "help", topic: "example" };
    }
    const parsed = parseArgs(args.slice(1), {
      boolean: ["open", "managed-env"],
      string: ["python"],
      unknown: rejectUnknownOption,
    });
    rejectPythonWithManagedEnv(parsed.python, parsed["managed-env"]);
    if (parsed._.length !== 1 || typeof parsed._[0] !== "string") {
      throw new Error("Usage: rowcall example <folder> [--open]");
    }
    return {
      kind: "example",
      targetPath: parsed._[0],
      openBrowser: Boolean(parsed.open),
      managedEnv: Boolean(parsed["managed-env"]),
      ...(typeof parsed.python === "string"
        ? { pythonCommand: parsed.python }
        : {}),
    };
  }

  if (args[0] === "run" || args[0] === "validate") {
    if (args.includes("--help") || args.includes("-h")) {
      return { kind: "help", topic: args[0] };
    }
    const { pythonCommand, managedEnv, forwardedArgs } =
      stripGlobalRuntimeOptions(
        args.slice(1),
      );
    rejectPythonWithManagedEnv(pythonCommand, managedEnv);
    return {
      kind: "headless",
      cliCommand: args[0],
      args: forwardedArgs,
      managedEnv,
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
    boolean: ["no-open", "managed-env"],
    string: ["python", "port", "hostname"],
    unknown: rejectUnknownOption,
  });
  rejectPythonWithManagedEnv(parsed.python, parsed["managed-env"]);
  if (parsed._.length !== 1 || typeof parsed._[0] !== "string") {
    throw new Error("Expected exactly one folder or .py document path.");
  }

  return {
    kind: "launch",
    documentPath: parsed._[0],
    openBrowser: !parsed["no-open"],
    managedEnv: Boolean(parsed["managed-env"]),
    ...(typeof parsed.python === "string"
      ? { pythonCommand: parsed.python }
      : {}),
    port: parsePortOption(parsed.port),
    hostname: typeof parsed.hostname === "string"
      ? parsed.hostname
      : defaultHostname,
  };
}

export async function runLauncherCommand(
  command: LauncherCommand,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const paths = options.paths ?? getLauncherPaths();
  switch (command.kind) {
    case "help":
      console.info(helpTextForTopic(command.topic));
      return { code: 0 };
    case "version":
      console.info(rowcallVersion);
      return { code: 0 };
    case "doctor":
      await printDoctor(command, paths);
      return { code: 0 };
    case "reset-env":
      await appendLog(paths, `rowcall ${command.kind}`);
      await resetManagedEnvironment(paths);
      await ensureManagedEnvironment(paths);
      console.info(`Recreated managed Python environment: ${paths.venvDir}`);
      return { code: 0 };
    case "update":
      await appendLog(paths, `rowcall ${command.kind}`);
      console.info(
        "Update checks are not implemented yet. Rerun the beta installer to upgrade Rowcall.",
      );
      return { code: 1 };
    case "new": {
      const documentPath = await createNewDocument(command.targetPath);
      if (!command.openBrowser) return { code: 0 };
      await appendLog(paths, `rowcall ${command.kind}`);
      const runtime = await resolveLaunchRuntime(paths, documentPath, {
        managedEnv: command.managedEnv,
        pythonCommand: command.pythonCommand,
      });
      await ensureBundledAssets(paths);
      await ensureServerPortAvailable(defaultHostname, defaultPort);
      return await launchServer({
        kind: "launch",
        documentPath,
        openBrowser: true,
        managedEnv: command.managedEnv,
        ...(runtime.pythonCommand
          ? { pythonCommand: runtime.pythonCommand }
          : {}),
        port: defaultPort,
        hostname: defaultHostname,
      }, paths);
    }
    case "example": {
      const documentPath = await createExampleProject(command.targetPath);
      if (!command.openBrowser) return { code: 0 };
      await appendLog(paths, `rowcall ${command.kind}`);
      const runtime = await resolveLaunchRuntime(paths, documentPath, {
        managedEnv: command.managedEnv,
        pythonCommand: command.pythonCommand,
      });
      await ensureBundledAssets(paths);
      await ensureServerPortAvailable(defaultHostname, defaultPort);
      return await launchServer({
        kind: "launch",
        documentPath,
        openBrowser: true,
        managedEnv: command.managedEnv,
        ...(runtime.pythonCommand
          ? { pythonCommand: runtime.pythonCommand }
          : {}),
        port: defaultPort,
        hostname: defaultHostname,
      }, paths);
    }
    case "headless": {
      await appendLog(paths, `rowcall ${command.kind}`);
      const preflight = preflightHeadlessCommand(
        command.cliCommand,
        command.args,
      );
      const documentPath = preflight.documentInput
        ? await resolveExistingDocumentPath(preflight.documentInput).catch(() =>
          null
        )
        : null;
      try {
        let runtime: RuntimeSelection & { pythonCommand: string };
        if (!preflight.allowsEnvironmentSetup || !documentPath) {
          runtime = await resolveRuntimeSelection(paths, {
            mode: "user",
            pythonCommand: command.pythonCommand,
          });
        } else if (command.managedEnv || command.pythonCommand) {
          runtime = await resolveRuntimeSelection(paths, {
            mode: command.managedEnv ? "managed" : "user",
            pythonCommand: command.pythonCommand,
          });
        } else {
          runtime = await resolveDocumentRuntime(paths, documentPath, {
            bootstrap: command.cliCommand === "run",
          });
        }
        const status = await runChild(runtime.pythonCommand, [
          "-m",
          "rowcall",
          command.cliCommand,
          ...command.args,
        ], runtime.mode === "user" ? pythonRuntimeEnv(paths) : undefined);
        return { code: status.code };
      } catch (error) {
        if (!preflight.machineReadable) throw error;
        printHeadlessEnvironmentError(command, preflight.documentInput, error);
        return { code: 1 };
      }
    }
    case "launch": {
      await appendLog(paths, `rowcall ${command.kind}`);
      command = {
        ...command,
        documentPath: await resolveExistingDocumentPath(command.documentPath),
      };
      const runtime = await resolveLaunchRuntime(paths, command.documentPath, {
        managedEnv: command.managedEnv,
        pythonCommand: command.pythonCommand,
      });
      command = {
        ...command,
        ...(runtime.pythonCommand
          ? { pythonCommand: runtime.pythonCommand }
          : {}),
      };
      await ensureBundledAssets(paths);
      await ensureServerPortAvailable(command.hostname, command.port);
      return await launchServer(command, paths);
    }
    case "server":
      await startRowcallServer(command.args, {
        ...(command.uiDistPath ? { uiDistPath: command.uiDistPath } : {}),
      });
      return { code: 0 };
  }
}

export function helpTextForTopic(topic: string | undefined): string {
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
          `Rowcall folder does not contain graph.py: ${path}\n\nCreate it with:\n  rowcall new ${path}`,
        );
      }
      return documentPath;
    }
    if (!stat.isFile) {
      throw new Error(`Rowcall path is not a file or directory: ${path}`);
    }
    if (!path.endsWith(".py")) {
      throw new Error(
        "Rowcall document path must be a .py file or a folder containing graph.py.",
      );
    }
    return path;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  const noun = path.endsWith(".py") ? "Rowcall document" : "Rowcall folder";
  throw new Error(
    `Path not found: ${path}\n\nCreate a new ${noun}:\n  rowcall new ${path}\n\nCreate and open it:\n  rowcall new ${path} --open`,
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
      throw new Error(`Rowcall document already exists: ${documentPath}`);
    }
    throw new Error(`Rowcall document path is not a file: ${documentPath}`);
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
            `Parent directory does not exist: ${parent}. Create it first, or pass a folder path to rowcall new.`,
          );
        }
        throw error;
      }
    }
  }

  await Deno.writeTextFile(documentPath, defaultDocumentSource);
  if (folderPath) {
    await writeDefaultProjectFiles(folderPath);
  }
  console.info(`Created new Rowcall document: ${documentPath}`);
  return documentPath;
}

export async function createExampleProject(
  targetPath: string,
): Promise<string> {
  if (targetPath.endsWith(".py")) {
    throw new Error("rowcall example expects a folder path, not a .py file.");
  }
  const directory = targetPath.replace(/\/+$/, "");
  const documentPath = `${directory}/graph.py`;
  const dataPath = `${directory}/data/orders.csv`;
  if (await pathExists(documentPath)) {
    throw new Error(`Rowcall document already exists: ${documentPath}`);
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
  await writeDefaultProjectFiles(directory);
  console.info(`Created Rowcall example: ${directory}`);
  console.info(`Open it with: rowcall open ${directory}`);
  return documentPath;
}

async function writeDefaultProjectFiles(directory: string): Promise<void> {
  await writeTextFileIfMissing(
    `${directory}/.gitignore`,
    defaultGitignore,
  );
  await writeTextFileIfMissing(
    `${directory}/AGENTS.md`,
    defaultAgentInstructions,
  );
  await writeTextFileIfMissing(
    `${directory}/requirements.txt`,
    defaultRequirements,
  );
}

async function writeTextFileIfMissing(
  path: string,
  content: string,
): Promise<void> {
  if (!await pathExists(path)) {
    await Deno.writeTextFile(path, content);
  }
}

export async function ensureManagedEnvironment(
  paths: LauncherPaths,
  pythonOverride?: string,
): Promise<string> {
  await Deno.mkdir(paths.logsDir, { recursive: true });
  const venvPython = getVenvPythonPath(paths.venvDir);
  if (await commandWorks(venvPython, ["--version"])) {
    if (
      await readManagedEnvironmentStamp(paths) !== managedEnvironmentStamp()
    ) {
      await installBundledPythonRuntime(paths, venvPython);
      await writeManagedEnvironmentStamp(paths);
    }
    return venvPython;
  }

  const basePython = pythonOverride ?? await findCompatiblePython();
  await runChecked(basePython, ["-m", "venv", paths.venvDir]);
  await installBundledPythonRuntime(paths, venvPython);
  await writeManagedEnvironmentStamp(paths);
  return venvPython;
}

async function resolveRuntimeSelection(
  paths: LauncherPaths,
  selection: RuntimeSelection,
): Promise<RuntimeSelection & { pythonCommand: string }> {
  if (selection.mode === "managed") {
    return {
      mode: "managed",
      pythonCommand: await ensureManagedEnvironment(paths),
    };
  }

  await ensureBundledAssets(paths);
  const pythonCommand = selection.pythonCommand ??
    await findCompatibleUserPython();
  if (!await isCompatiblePython(pythonCommand)) {
    throw new Error(
      `Selected Python must be Python 3.10 or newer: ${pythonCommand}`,
    );
  }
  if (
    !await commandWorks(
      pythonCommand,
      ["-c", "import rowcall.runtime.worker"],
      pythonRuntimeEnv(paths),
    )
  ) {
    throw new Error(
      `Selected Python could not start Rowcall: ${pythonCommand}\n\n` +
        "Try --managed-env to use Rowcall's starter environment, or pass a different Python with --python.",
    );
  }
  return {
    mode: "user",
    pythonCommand,
  };
}

async function resolveLaunchRuntime(
  paths: LauncherPaths,
  documentPath: string,
  selection: { managedEnv: boolean; pythonCommand?: string },
): Promise<RuntimeSelection & { pythonCommand: string }> {
  if (selection.managedEnv || selection.pythonCommand) {
    return await resolveRuntimeSelection(paths, {
      mode: selection.managedEnv ? "managed" : "user",
      pythonCommand: selection.pythonCommand,
    });
  }

  return await resolveDocumentRuntime(paths, documentPath, {
    bootstrap: true,
  });
}

async function resolveDocumentRuntime(
  paths: LauncherPaths,
  documentPath: string,
  options: { bootstrap: boolean },
): Promise<RuntimeSelection & { pythonCommand: string }> {
  return await resolveRuntimeSelection(paths, {
    mode: "user",
    pythonCommand: await resolveProjectPython(documentPath, options),
  });
}

export async function resolveProjectPython(
  documentPath: string,
  options: { bootstrap: boolean },
): Promise<string> {
  const projectDirectory = getParentDirectory(documentPath) ?? ".";
  const venvDirectory = `${projectDirectory}/.venv`;
  const venvPython = getVenvPythonPath(venvDirectory);
  if (await isCompatiblePython(venvPython)) {
    if (options.bootstrap) {
      await completeProjectEnvironmentSetup(
        projectDirectory,
        venvDirectory,
      );
    }
    reportEnvironment(`Using project Python environment: ${venvPython}`);
    return venvPython;
  }

  if (await pathExists(venvDirectory)) {
    if (
      options.bootstrap &&
      (await readProjectEnvironmentSetupState(
          projectEnvironmentSetupPath(venvDirectory),
        ))?.status === "creating"
    ) {
      return await ensureProjectEnvironment(documentPath);
    }
    throw brokenProjectEnvironmentError(venvDirectory);
  }

  const activePython = await findCompatibleActivePython();
  if (activePython) {
    reportEnvironment(`Using active Python environment: ${activePython}`);
    return activePython;
  }

  if (options.bootstrap) {
    return await ensureProjectEnvironment(documentPath);
  }

  const systemPython = await findCompatiblePython();
  reportEnvironment(`Using Python for validation: ${systemPython}`);
  return systemPython;
}

export async function ensureProjectEnvironment(
  documentPath: string,
): Promise<string> {
  const projectDirectory = getParentDirectory(documentPath) ?? ".";
  const venvDirectory = `${projectDirectory}/.venv`;
  const venvPython = getVenvPythonPath(venvDirectory);
  const setupPath = projectEnvironmentSetupPath(venvDirectory);
  if (await isCompatiblePython(venvPython)) {
    await completeProjectEnvironmentSetup(
      projectDirectory,
      venvDirectory,
    );
    reportEnvironment(`Using project Python environment: ${venvPython}`);
    return venvPython;
  }

  if (await pathExists(venvDirectory)) {
    const setupState = await readOptionalTextFile(setupPath);
    if (setupState?.trim() !== "creating") {
      throw brokenProjectEnvironmentError(venvDirectory);
    }
  } else {
    await Deno.mkdir(venvDirectory);
    await Deno.writeTextFile(setupPath, "creating\n");
  }

  await completeProjectEnvironmentSetup(
    projectDirectory,
    venvDirectory,
  );
  reportEnvironment(`Using project Python environment: ${venvPython}`);
  return venvPython;
}

async function completeProjectEnvironmentSetup(
  projectDirectory: string,
  venvDirectory: string,
): Promise<void> {
  const setupPath = projectEnvironmentSetupPath(venvDirectory);
  let setupState = await readProjectEnvironmentSetupState(setupPath);
  // A missing marker means the environment belongs to the user. Rowcall only
  // installs into project environments that it created and marked itself.
  if (setupState === null) return;
  if (setupState.status === "creating") {
    await finishProjectEnvironmentCreation(venvDirectory);
    await Deno.writeTextFile(setupPath, "incomplete\n");
    setupState = { status: "incomplete" };
  }

  const requirementsPath = `${projectDirectory}/requirements.txt`;
  const requirementsFingerprint = await projectRequirementsFingerprint(
    requirementsPath,
  );
  if (
    setupState.status === "complete" &&
    setupState.requirementsFingerprint === requirementsFingerprint
  ) {
    return;
  }

  const hasRequirements = requirementsFingerprint !== "absent";
  if (hasRequirements) {
    const absoluteProjectDirectory = await Deno.realPath(projectDirectory);
    const absoluteRequirementsPath = await Deno.realPath(requirementsPath);
    const absoluteVenvDirectory = await Deno.realPath(venvDirectory);
    const absoluteVenvPython = getVenvPythonPath(absoluteVenvDirectory);
    reportEnvironment(
      `Installing changed project dependencies from ${absoluteRequirementsPath} (this may take a minute)...`,
    );
    try {
      await runChecked(absoluteVenvPython, [
        "-m",
        "pip",
        "install",
        "-r",
        absoluteRequirementsPath,
      ], { cwd: absoluteProjectDirectory });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not install project dependencies from ${absoluteRequirementsPath}.\n` +
          `Rowcall will retry dependency setup on the next open or run.\n\n${detail}`,
      );
    }
  }

  await writeCompleteProjectEnvironmentSetup(
    setupPath,
    requirementsFingerprint,
  );
  reportEnvironment("Project Python environment is ready.");
}

async function finishProjectEnvironmentCreation(
  venvDirectory: string,
): Promise<void> {
  const basePython = await findCompatiblePython();
  reportEnvironment(`Creating project Python environment: ${venvDirectory}`);
  try {
    await runChecked(basePython, ["-m", "venv", venvDirectory]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not finish creating the project environment: ${venvDirectory}\n` +
        `Rowcall will retry creation on the next open or run.\n\n${detail}`,
    );
  }
  const venvPython = getVenvPythonPath(venvDirectory);
  if (!await isCompatiblePython(venvPython)) {
    throw new Error(
      `Created project environment could not run Python 3.10 or newer: ${venvDirectory}\n` +
        "Rowcall will retry creation on the next open or run.",
    );
  }
}

function projectEnvironmentSetupPath(venvDirectory: string): string {
  return `${venvDirectory}/.rowcall-setup`;
}

type ProjectEnvironmentSetupState = {
  status: "creating" | "incomplete" | "complete";
  requirementsFingerprint?: string;
};

async function readProjectEnvironmentSetupState(
  path: string,
): Promise<ProjectEnvironmentSetupState | null> {
  const text = await readOptionalTextFile(path);
  if (text === null) return null;
  const lines = text.trim().split("\n");
  const status = lines[0];
  const requirementsLine = lines.find((line) =>
    line.startsWith("requirements-sha256=")
  );
  const requirementsFingerprint = requirementsLine?.slice(
    "requirements-sha256=".length,
  );
  return {
    status: status === "creating" || status === "complete"
      ? status
      : "incomplete",
    ...(requirementsFingerprint ? { requirementsFingerprint } : {}),
  };
}

async function writeCompleteProjectEnvironmentSetup(
  path: string,
  requirementsFingerprint: string,
): Promise<void> {
  await Deno.writeTextFile(
    path,
    `complete\nrequirements-sha256=${requirementsFingerprint}\n`,
  );
}

async function projectRequirementsFingerprint(path: string): Promise<string> {
  let contents: Uint8Array<ArrayBuffer>;
  try {
    contents = await Deno.readFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "absent";
    throw error;
  }
  const digest = await crypto.subtle.digest("SHA-256", contents);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readOptionalTextFile(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function brokenProjectEnvironmentError(venvDirectory: string): Error {
  return new Error(
    `Project environment exists but does not contain Python 3.10 or newer: ${venvDirectory}\n\n` +
      `Remove or repair it, or pass --python /path/to/python.`,
  );
}

function reportEnvironment(message: string): void {
  console.error(message);
}

export async function resetManagedEnvironment(
  paths: LauncherPaths,
): Promise<void> {
  await Deno.remove(paths.venvDir, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
}

async function installBundledPythonRuntime(
  paths: LauncherPaths,
  venvPython: string,
): Promise<void> {
  await ensureBundledAssets(paths);
  if (!await pathExists(paths.bundledPythonPackageDir)) {
    throw new Error(
      `Bundled Rowcall Python package was not materialized at ${paths.bundledPythonPackageDir}`,
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

async function readManagedEnvironmentStamp(
  paths: LauncherPaths,
): Promise<string | null> {
  try {
    return (await Deno.readTextFile(managedEnvironmentStampPath(paths)))
      .trim();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function writeManagedEnvironmentStamp(
  paths: LauncherPaths,
): Promise<void> {
  await Deno.writeTextFile(
    managedEnvironmentStampPath(paths),
    `${managedEnvironmentStamp()}\n`,
  );
}

function managedEnvironmentStamp(): string {
  return `${rowcallVersion}:${managedEnvironmentRevision}`;
}

function managedEnvironmentStampPath(paths: LauncherPaths): string {
  return `${paths.venvDir}/.rowcall-version`;
}

async function ensureBundledAssets(paths: LauncherPaths): Promise<void> {
  await Deno.mkdir(paths.bundledDir, { recursive: true });
  await copyRequirementsIfExists(
    bundledSource("requirements-alpha.txt"),
    paths.bundledRequirementsPath,
  );
  await copyDirectoryIfExists(
    bundledSource("rowcall"),
    `${paths.bundledPythonPackageDir}/rowcall`,
  );
  await copyIfExists(
    bundledSource("pyproject.toml"),
    `${paths.bundledPythonPackageDir}/pyproject.toml`,
  );
  await copyDirectoryIfExists(bundledSource("app/ui/dist"), paths.uiDistPath);
}

type DoctorCheckStatus = "ok" | "missing" | "not_checked";

type DoctorReport = {
  ok: boolean;
  command: "doctor";
  rowcallVersion: string;
  dataDirectory: string;
  managedEnvironment: string;
  logFile: string;
  pathContainsLocalBin: boolean;
  runtime: {
    mode: "user" | "managed";
    python: {
      status: DoctorCheckStatus;
      command?: string;
      error?: string;
    };
    imports: Record<
      "rowcall" | "pandas" | "polars" | "matplotlib",
      DoctorCheckStatus
    >;
  };
  updateCheck: "not_requested" | "not_implemented";
};

export async function buildDoctorReport(
  command: Extract<LauncherCommand, { kind: "doctor" }>,
  paths: LauncherPaths,
): Promise<DoctorReport> {
  const mode = command.managedEnv ? "managed" : "user";
  let pythonCommand = "";
  let pythonError: string | undefined;

  if (mode === "managed") {
    const runtime = await inspectManagedRuntime(paths);
    pythonCommand = runtime.pythonCommand;
    pythonError = runtime.error;
  } else if (command.pythonCommand) {
    if (await isCompatiblePython(command.pythonCommand)) {
      pythonCommand = command.pythonCommand;
    } else {
      pythonError =
        `Selected Python is unavailable or older than Python 3.10: ${command.pythonCommand}`;
    }
  } else {
    try {
      pythonCommand = await findCompatibleUserPython();
    } catch (error) {
      pythonError = error instanceof Error ? error.message : String(error);
    }
  }

  const runtimeEnv = {
    ...(mode === "user" ? pythonRuntimeEnv(paths) : {}),
    PYTHONDONTWRITEBYTECODE: "1",
  };
  const imports = {
    rowcall: await inspectPythonImport(pythonCommand, "rowcall", runtimeEnv),
    pandas: await inspectPythonImport(pythonCommand, "pandas", runtimeEnv),
    polars: await inspectPythonImport(pythonCommand, "polars", runtimeEnv),
    matplotlib: await inspectPythonImport(
      pythonCommand,
      "matplotlib",
      runtimeEnv,
    ),
  };

  return {
    ok: Boolean(pythonCommand) && imports.rowcall === "ok",
    command: "doctor",
    rowcallVersion,
    dataDirectory: paths.dataDir,
    managedEnvironment: paths.venvDir,
    logFile: paths.logFile,
    pathContainsLocalBin: pathContainsLocalBin(paths.home),
    runtime: {
      mode,
      python: {
        status: pythonCommand ? "ok" : "missing",
        ...(pythonCommand ? { command: pythonCommand } : {}),
        ...(pythonError ? { error: pythonError } : {}),
      },
      imports,
    },
    updateCheck: command.checkUpdates ? "not_implemented" : "not_requested",
  };
}

async function inspectPythonImport(
  pythonCommand: string,
  packageName: string,
  env?: Record<string, string>,
): Promise<DoctorCheckStatus> {
  if (!pythonCommand) return "not_checked";
  return await commandWorks(
      pythonCommand,
      ["-c", `import ${packageName}`],
      env,
    )
    ? "ok"
    : "missing";
}

async function printDoctor(
  command: Extract<LauncherCommand, { kind: "doctor" }>,
  paths: LauncherPaths,
): Promise<void> {
  const report = await buildDoctorReport(command, paths);
  if (command.json) {
    console.info(JSON.stringify(report, null, 2));
    return;
  }

  console.info(`Rowcall ${report.rowcallVersion}`);
  console.info(`Data directory: ${report.dataDirectory}`);
  console.info(`Managed venv: ${report.managedEnvironment}`);
  console.info(`Log file: ${report.logFile}`);
  console.info(
    `PATH contains ~/.local/bin: ${
      report.pathContainsLocalBin ? "ok" : "missing"
    }`,
  );
  console.info(`Runtime mode: ${report.runtime.mode}`);
  console.info(
    `Runtime Python: ${
      report.runtime.python.command || report.runtime.python.status
    }`,
  );
  if (report.runtime.python.error) {
    console.info(`Runtime error: ${report.runtime.python.error}`);
  }
  console.info(`rowcall package: ${report.runtime.imports.rowcall}`);
  console.info(`pandas: ${report.runtime.imports.pandas}`);
  console.info(`polars: ${report.runtime.imports.polars}`);
  console.info(`matplotlib: ${report.runtime.imports.matplotlib}`);
  if (command.checkUpdates) {
    console.info("Update checks are not implemented yet.");
  }

  if (
    command.managedEnv &&
    Object.values(report.runtime.imports).some((status) => status !== "ok")
  ) {
    console.info("");
    console.info("Fix: rowcall reset-env");
  } else if (!command.managedEnv && report.runtime.python.status !== "ok") {
    console.info("");
    console.info("Fix: rowcall doctor --managed-env");
  }
}

async function inspectManagedRuntime(
  paths: LauncherPaths,
): Promise<{ mode: "managed"; pythonCommand: string; error?: string }> {
  const venvPython = getVenvPythonPath(paths.venvDir);
  if (await commandWorks(venvPython, ["--version"])) {
    return { mode: "managed", pythonCommand: venvPython };
  }
  return {
    mode: "managed",
    pythonCommand: "",
    error: "Managed environment is missing.",
  };
}

async function launchServer(
  command: Extract<LauncherCommand, { kind: "launch" }>,
  paths: LauncherPaths,
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
    command.pythonCommand ?? getVenvPythonPath(paths.venvDir),
    "--runtime-mode",
    command.managedEnv ? "managed" : "user",
    "--ui-dist",
    paths.uiDistPath,
  ];
  if (!command.managedEnv) {
    serverArgs.push(
      "--rowcall-python-package",
      paths.bundledPythonPackageDir,
    );
  }
  const invocation = buildLauncherInvocation(serverArgs);
  const server = new Deno.Command(invocation.command, {
    args: invocation.args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stdoutDone = teeProcessOutput(server.stdout, Deno.stdout, paths);
  const stderrDone = teeProcessOutput(server.stderr, Deno.stderr, paths);
  const serverStatus = server.status;
  const url = buildRowcallUrl(command.hostname, command.port, authToken);
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
  console.info(`Rowcall is running at ${url}`);
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

function stripGlobalRuntimeOptions(args: string[]): {
  pythonCommand?: string;
  managedEnv: boolean;
  forwardedArgs: string[];
} {
  const forwardedArgs: string[] = [];
  let pythonCommand: string | undefined;
  let managedEnv = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--managed-env") {
      managedEnv = true;
      continue;
    }
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
    managedEnv,
    forwardedArgs,
  };
}

export function preflightHeadlessCommand(
  cliCommand: "run" | "validate",
  args: string[],
): {
  documentInput?: string;
  allowsEnvironmentSetup: boolean;
  machineReadable: boolean;
} {
  const positionals: string[] = [];
  let valid = true;
  let jsonMode: "none" | "full" | "summary" = "none";
  let traceMode: "none" | "full" | "summary" = "none";
  let outputsOnly = false;
  let hasTarget = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      jsonMode = "full";
    } else if (arg.startsWith("--json=")) {
      const value = arg.slice("--json=".length);
      if (value === "full" || value === "summary") {
        jsonMode = value;
      } else {
        valid = false;
      }
    } else if (arg === "--trace") {
      traceMode = "full";
    } else if (arg.startsWith("--trace=")) {
      const value = arg.slice("--trace=".length);
      if (value === "full" || value === "summary") {
        traceMode = value;
      } else {
        valid = false;
      }
    } else if (arg === "--outputs-only") {
      outputsOnly = true;
    } else if (arg === "--to") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) {
        valid = false;
      } else {
        hasTarget = true;
        index += 1;
      }
    } else if (arg.startsWith("--to=")) {
      if (arg.length === "--to=".length) {
        valid = false;
      } else {
        hasTarget = true;
      }
    } else if (arg.startsWith("-")) {
      valid = false;
    } else {
      positionals.push(arg);
    }
  }

  valid = valid && positionals.length === 1;
  if (cliCommand === "validate" && hasTarget) valid = false;
  if (cliCommand === "validate" && traceMode !== "none") valid = false;
  if (cliCommand === "validate" && outputsOnly) valid = false;
  if (outputsOnly && jsonMode === "summary") valid = false;
  if (outputsOnly && traceMode !== "none") valid = false;
  if (traceMode === "summary" && jsonMode === "none") valid = false;

  return {
    ...(positionals.length === 1 ? { documentInput: positionals[0] } : {}),
    allowsEnvironmentSetup: valid,
    machineReadable: args.some((arg) =>
      arg === "--outputs-only" ||
      arg === "--json" ||
      arg.startsWith("--json=")
    ),
  };
}

function printHeadlessEnvironmentError(
  command: Extract<LauncherCommand, { kind: "headless" }>,
  documentInput: string | undefined,
  error: unknown,
): void {
  console.info(JSON.stringify(
    {
      ok: false,
      command: command.cliCommand,
      documentPath: documentInput ?? null,
      error: {
        kind: "environment_error",
        message: error instanceof Error ? error.message : String(error),
      },
    },
    null,
    2,
  ));
}

function rejectPythonWithManagedEnv(
  pythonCommand: unknown,
  managedEnv: unknown,
): void {
  if (pythonCommand && managedEnv) {
    throw new Error("--python cannot be combined with --managed-env");
  }
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

async function findCompatibleUserPython(): Promise<string> {
  const activePython = await findCompatibleActivePython();
  if (activePython) return activePython;
  try {
    return await findCompatiblePython();
  } catch {
    // Use the user-facing message below, which includes the launcher escapes.
  }
  throw new Error(
    "Could not find Python 3.10 or newer. Pass --managed-env to use Rowcall's starter environment, or pass --python /path/to/python.",
  );
}

async function findCompatibleActivePython(): Promise<string | undefined> {
  for (const command of getActiveEnvironmentPythonCandidates()) {
    if (await isCompatiblePython(command)) return command;
  }
  return undefined;
}

async function isCompatiblePython(command: string): Promise<boolean> {
  return await commandWorks(command, [
    "-c",
    "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)",
  ]);
}

async function commandWorks(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<boolean> {
  try {
    const output = await new Deno.Command(command, {
      args,
      stdout: "null",
      stderr: "null",
      ...(env ? { env } : {}),
    }).output();
    return output.success;
  } catch {
    return false;
  }
}

function pythonRuntimeEnv(paths: LauncherPaths): Record<string, string> {
  const existingPythonPath = Deno.env.get("PYTHONPATH");
  return {
    PYTHONPATH: [
      paths.bundledPythonPackageDir,
      ...(existingPythonPath ? [existingPythonPath] : []),
    ].join(Deno.build.os === "windows" ? ";" : ":"),
  };
}

async function runChecked(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<void> {
  const child = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
    ...(options.cwd ? { cwd: options.cwd } : {}),
  }).spawn();
  const outputDone = Promise.all([
    forwardProcessOutput(child.stdout, Deno.stderr),
    forwardProcessOutput(child.stderr, Deno.stderr),
  ]);
  const status = await child.status;
  await outputDone;
  if (!status.success) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${status.code}`,
    );
  }
}

async function forwardProcessOutput(
  stream: ReadableStream<Uint8Array>,
  output: { write(chunk: Uint8Array): Promise<number> },
): Promise<void> {
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    await output.write(value);
  }
}

async function runChild(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<Deno.CommandStatus> {
  return await new Deno.Command(command, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    ...(env ? { env } : {}),
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
      throw new Error(formatPortInUseError(hostname, port));
    }
    throw error;
  } finally {
    listener?.close();
  }
}

export function formatPortInUseError(hostname: string, port: number): string {
  return `Port ${port} is already in use on ${hostname}. Rowcall may already be running; return to the existing browser window. If you intentionally need another server, stop the process using the port or start Rowcall with --port ${
    port + 1
  }.`;
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
        `Rowcall server exited before it was ready (exit code ${result.code})`,
      );
    }
  }
  throw new Error(`Timed out waiting for Rowcall server at ${url}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function teeProcessOutput(
  stream: ReadableStream<Uint8Array>,
  output: { write(chunk: Uint8Array): Promise<number> },
  paths: LauncherPaths,
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

async function appendLog(paths: LauncherPaths, message: string): Promise<void> {
  await Deno.mkdir(paths.logsDir, { recursive: true });
  const timestamp = new Date().toISOString();
  await Deno.writeTextFile(paths.logFile, `[${timestamp}] ${message}\n`, {
    append: true,
  }).catch(() => {
    // Logging should never prevent Rowcall from starting.
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
    const command = parseLauncherCommand(Deno.args);
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
      const result = await runLauncherCommand({
        kind: "server",
        args: forwardedArgs,
        ...(typeof parsed["ui-dist"] === "string"
          ? { uiDistPath: parsed["ui-dist"] }
          : {}),
      });
      Deno.exit(result.code);
    }
    const result = await runLauncherCommand(command);
    Deno.exit(result.code);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
