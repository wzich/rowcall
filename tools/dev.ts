import { resolveExistingDocumentPath } from "../document_path.ts";
import { getLauncherPaths, type LauncherPaths } from "../launcher_paths.ts";
import { parseStartupOptions } from "../startup_args.ts";
import {
  ensureManagedEnvironment,
  resolveProjectPython,
  validatePythonRuntime,
} from "../launcher.ts";

const viteHostname = "127.0.0.1";
const defaultVitePort = 5173;

type DevOptions = ReturnType<typeof parseDevOptions>;

async function main(): Promise<void> {
  const options = await resolveDevRuntime(
    await resolveDevDocumentPath(parseDevOptions(Deno.args)),
  );
  const authToken = crypto.randomUUID();
  const apiOrigin = buildOrigin(options.hostname, options.port);
  const viteOrigin = buildOrigin(viteHostname, options.uiPort);
  const appUrl = buildAuthenticatedUrl(viteOrigin, authToken);

  ensurePortAvailable(options.hostname, options.port, "API");
  ensurePortAvailable(viteHostname, options.uiPort, "UI");

  const api = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--watch",
      "--allow-read",
      "--allow-write",
      "--allow-net",
      "--allow-run",
      "--allow-env",
      "main.ts",
      ...buildServerArgs(options, authToken),
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const ui = new Deno.Command(Deno.execPath(), {
    args: ["task", "--cwd", "app/ui", "dev"],
    env: {
      ROWCALL_DEV_API_ORIGIN: apiOrigin,
      ROWCALL_DEV_UI_PORT: String(options.uiPort),
    },
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  const apiStatus = api.status;
  const uiStatus = ui.status;
  let shuttingDown = false;
  let shutdownRequested = false;
  const stopChildren = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopChild(api);
    stopChild(ui);
  };
  const signalHandlers = registerSignalHandlers(() => {
    shutdownRequested = true;
    stopChildren();
  });

  try {
    await Promise.all([
      waitForServer(apiOrigin, "API", apiStatus),
      waitForServer(viteOrigin, "UI", uiStatus),
    ]);

    console.info(`Rowcall development server: ${appUrl}`);
    if (options.openBrowser) {
      await openBrowser(appUrl);
    }

    const firstExit = await Promise.race([
      apiStatus.then((status) => ({ process: "API", status })),
      uiStatus.then((status) => ({ process: "UI", status })),
    ]);
    stopChildren();
    await Promise.all([apiStatus, uiStatus]);

    if (!shutdownRequested && firstExit.status.code !== 0) {
      console.error(
        `${firstExit.process} development process exited with code ${firstExit.status.code}.`,
      );
    }
    Deno.exit(firstExit.status.code);
  } catch (error) {
    stopChildren();
    await Promise.allSettled([apiStatus, uiStatus]);
    throw error;
  } finally {
    unregisterSignalHandlers(signalHandlers);
  }
}

type ProjectPythonResolver = (
  documentPath: string,
  options: { bootstrap: boolean },
) => Promise<string>;

type DevRuntimeDependencies = {
  resolveProjectPython: ProjectPythonResolver;
  ensureManagedEnvironment: (paths: LauncherPaths) => Promise<string>;
  validatePythonRuntime: (
    pythonCommand: string,
    pythonPathEntries?: string[],
  ) => Promise<void>;
  launcherPaths: LauncherPaths;
};

export async function resolveDevDocumentPath(
  options: DevOptions,
  resolveDocument: (path: string) => Promise<string> =
    resolveExistingDocumentPath,
): Promise<DevOptions> {
  if (options.create) return options;
  return {
    ...options,
    documentPath: await resolveDocument(options.documentPath),
  };
}

export async function resolveDevRuntime(
  options: DevOptions,
  dependencies: Partial<DevRuntimeDependencies> = {},
): Promise<DevOptions> {
  const ensureManaged = dependencies.ensureManagedEnvironment ??
    ensureManagedEnvironment;
  const resolvePython = dependencies.resolveProjectPython ??
    resolveProjectPython;
  const validatePython = dependencies.validatePythonRuntime ??
    validatePythonRuntime;

  if (options.managedEnv) {
    return {
      ...options,
      pythonCommand: await ensureManaged(
        dependencies.launcherPaths ?? getLauncherPaths(),
      ),
      runtimeMode: "managed",
    };
  }

  const pythonCommand = options.pythonCommand ?? await resolvePython(
    options.documentPath,
    { bootstrap: true },
  );
  const rowcallPythonPackagePath = options.rowcallPythonPackagePath ?? ".";
  await validatePython(pythonCommand, [rowcallPythonPackagePath]);
  return {
    ...options,
    pythonCommand,
    rowcallPythonPackagePath,
    runtimeMode: "user",
  };
}

export function parseDevOptions(args: string[]) {
  const serverArgs: string[] = [];
  let openBrowser = true;
  let managedEnv = false;
  let uiPort = defaultVitePort;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-open") {
      openBrowser = false;
      continue;
    }
    if (arg === "--managed-env") {
      managedEnv = true;
      continue;
    }
    if (arg === "--ui-port") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value after --ui-port");
      }
      uiPort = parsePort(value, "--ui-port");
      index += 1;
      continue;
    }
    serverArgs.push(arg);
  }

  const startupOptions = parseStartupOptions(serverArgs, {
    allowDirectoryInput: true,
  });
  if (managedEnv && startupOptions.pythonCommand) {
    throw new Error("--python cannot be combined with --managed-env");
  }
  if (startupOptions.create && !startupOptions.documentPath.endsWith(".py")) {
    throw new Error(
      "Development --create requires a .py path. Use `rowcall new <folder>` to create a folder project.",
    );
  }

  return {
    ...startupOptions,
    openBrowser,
    managedEnv,
    uiPort,
  };
}

function buildServerArgs(options: DevOptions, authToken: string): string[] {
  return [
    "--document",
    options.documentPath,
    "--port",
    String(options.port),
    "--hostname",
    options.hostname,
    "--auth-token",
    authToken,
    ...(options.create ? ["--create"] : []),
    ...(options.pythonCommand ? ["--python", options.pythonCommand] : []),
    ...(options.rowcallPythonPackagePath
      ? ["--rowcall-python-package", options.rowcallPythonPackagePath]
      : []),
    ...(options.runtimeMode ? ["--runtime-mode", options.runtimeMode] : []),
    ...(options.uiDistPath ? ["--ui-dist", options.uiDistPath] : []),
  ];
}

function buildOrigin(hostname: string, port: number): string {
  const host = hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
  return `http://${host}:${port}`;
}

export function buildAuthenticatedUrl(
  origin: string,
  authToken: string,
): string {
  const url = new URL(origin);
  url.searchParams.set("token", authToken);
  return url.toString();
}

function parsePort(value: string, flag: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${flag} value: ${value}`);
  }
  return port;
}

function ensurePortAvailable(
  hostname: string,
  port: number,
  name: string,
): void {
  let listener: Deno.Listener | undefined;
  try {
    listener = Deno.listen({ hostname, port });
  } catch (error) {
    if (error instanceof Deno.errors.AddrInUse) {
      throw new Error(
        `${name} port ${port} is already in use on ${hostname}.`,
      );
    }
    throw error;
  } finally {
    listener?.close();
  }
}

async function waitForServer(
  origin: string,
  name: string,
  status: Promise<Deno.CommandStatus>,
): Promise<void> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const result = await Promise.race([
      fetch(origin).then(async (response) => {
        await response.body?.cancel().catch(() => {});
        return "ready" as const;
      }).catch(() => "not-ready" as const),
      status.then((processStatus) => ({
        kind: "exited" as const,
        code: processStatus.code,
      })),
      delay(150).then(() => "not-ready" as const),
    ]);

    if (result === "ready") return;
    if (typeof result === "object" && result.kind === "exited") {
      throw new Error(
        `${name} development process exited before it was ready (code ${result.code}).`,
      );
    }
  }

  throw new Error(`Timed out waiting for the ${name} at ${origin}.`);
}

function registerSignalHandlers(
  handler: () => void,
): Array<{ signal: Deno.Signal; handler: () => void }> {
  const signals: Deno.Signal[] = Deno.build.os === "windows"
    ? ["SIGINT"]
    : ["SIGINT", "SIGTERM"];
  return signals.map((signal) => {
    Deno.addSignalListener(signal, handler);
    return { signal, handler };
  });
}

function unregisterSignalHandlers(
  handlers: Array<{ signal: Deno.Signal; handler: () => void }>,
): void {
  for (const { signal, handler } of handlers) {
    Deno.removeSignalListener(signal, handler);
  }
}

function stopChild(child: Deno.ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may already have exited.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openBrowser(url: string): Promise<void> {
  const output = await new Deno.Command("open", {
    args: [url],
    stdout: "null",
    stderr: "piped",
  }).output().catch((error) => {
    console.warn(
      `Could not open browser automatically: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  });

  if (!output || output.success) return;

  const stderr = new TextDecoder().decode(output.stderr).trim();
  console.warn(
    `Could not open browser automatically${stderr ? `: ${stderr}` : ""}`,
  );
}

if (import.meta.main) {
  await main();
}
