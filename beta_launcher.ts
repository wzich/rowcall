import { parseArgs } from "@std/cli/parse-args";
import { startNodebookServer } from "./main.ts";
import {
  type BetaPaths,
  getBetaPaths,
  getVenvPythonPath,
} from "./beta_paths.ts";
import { defaultHostname, defaultPort } from "./startup_args.ts";
import { nodebookVersion } from "./version.ts";

export type BetaCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "doctor"; checkUpdates: boolean; pythonCommand?: string }
  | { kind: "reset-env" }
  | { kind: "update" }
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


@node(id="n_start", outputs=["message"])
def start():
    message = "hello"
    return {"message": message}
`;

const helpText = `Nodebook ${nodebookVersion}

Usage:
  nodebook                         Show this help
  nodebook <document.py>           Open or create a Nodebook document
  nodebook run <document.py>       Run a document without opening the UI
  nodebook validate <document.py>  Validate a document without opening the UI
  nodebook doctor                  Inspect the local Nodebook install
  nodebook reset-env               Recreate the managed Python environment
  nodebook update                  Check for a launcher update

Options:
  --python <path>                  Use a specific Python 3.10+ interpreter
  --port <port>                    Start the UI server on a custom port
  --hostname <host>                Bind the UI server to a custom host
  --no-open                        Do not open the browser after starting
  --version                        Print the launcher version
`;

export function parseBetaCommand(args: string[]): BetaCommand {
  if (args.length === 0) return { kind: "help" };

  if (args[0] === "__server") {
    return {
      kind: "server",
      args: args.slice(1),
    };
  }

  if (args[0] === "--version" || args[0] === "-V") {
    return { kind: "version" };
  }

  if (args[0] === "doctor") {
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
    return { kind: "reset-env" };
  }

  if (args[0] === "update") {
    return { kind: "update" };
  }

  if (args[0] === "run" || args[0] === "validate") {
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

  const parsed = parseArgs(args, {
    boolean: ["no-open"],
    string: ["python", "port", "hostname"],
    unknown: rejectUnknownOption,
  });
  if (parsed._.length !== 1 || typeof parsed._[0] !== "string") {
    throw new Error("Expected exactly one .py document path.");
  }
  const documentPath = parsed._[0];
  if (!documentPath.endsWith(".py")) {
    throw new Error("Nodebook document path must end with .py");
  }

  return {
    kind: "launch",
    documentPath,
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
      console.info(helpText);
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
      await ensureDocumentReady(command.documentPath);
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

export async function ensureDocumentReady(documentPath: string): Promise<void> {
  try {
    const stat = await Deno.stat(documentPath);
    if (!stat.isFile) {
      throw new Error(`Nodebook document path is not a file: ${documentPath}`);
    }
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

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
          `Parent directory does not exist: ${parent}. Create it first, or pass an existing directory.`,
        );
      }
      throw error;
    }
  }

  await Deno.writeTextFile(documentPath, defaultDocumentSource);
  console.info(`Created new Nodebook document: ${documentPath}`);
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
  await copyIfExists(bundledSource("runner.py"), paths.bundledRunnerPath);
  await copyIfExists(
    bundledSource("python_document_loader.py"),
    paths.bundledDocumentLoaderPath,
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
  const serverArgs = [
    "__server",
    "--document",
    command.documentPath,
    "--port",
    String(command.port),
    "--hostname",
    command.hostname,
    "--python",
    getVenvPythonPath(paths.venvDir),
    "--runner",
    paths.bundledRunnerPath,
    "--loader",
    paths.bundledDocumentLoaderPath,
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
  const url = `http://${command.hostname}:${command.port}/`;
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

async function ensureServerPortAvailable(
  hostname: string,
  port: number,
): Promise<void> {
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
