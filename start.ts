import { buildNodebookUrl } from "./main.ts";
import { parseStartupOptions } from "./startup_args.ts";

type LauncherOptions = ReturnType<typeof parseLauncherOptions>;

const serverUrl = (options: LauncherOptions, authToken: string) =>
  buildNodebookUrl(options.hostname, options.port, authToken);

async function main(): Promise<void> {
  let options: LauncherOptions;
  try {
    options = parseLauncherOptions(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }

  console.info("Building Nodebook UI...");
  await runChecked([Deno.execPath(), "task", "ui:build"]);
  console.info("Preparing Nodebook server...");
  await runChecked([Deno.execPath(), "cache", "main.ts"]);

  console.info(`Starting Nodebook for ${options.documentPath}`);
  if (options.pythonCommand) {
    console.info(`Using Python: ${options.pythonCommand}`);
  }
  ensureServerPortAvailable(options);

  const authToken = crypto.randomUUID();
  const serverArgs = [
    "run",
    "--allow-read",
    "--allow-write",
    "--allow-net",
    "--allow-run",
    "main.ts",
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
  ];
  const server = new Deno.Command(Deno.execPath(), {
    args: serverArgs,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const serverStatus = server.status;

  const url = serverUrl(options, authToken);
  try {
    await waitForServer(url, serverStatus);
  } catch (error) {
    try {
      server.kill("SIGTERM");
    } catch {
      // The server may have exited while the readiness wait was failing.
    }
    throw error;
  }
  console.info(`Nodebook is running at ${url}`);

  if (options.openBrowser) {
    await openBrowser(url);
  }

  const status = await serverStatus;
  Deno.exit(status.code);
}

function parseLauncherOptions(args: string[]) {
  const forwardedArgs: string[] = [];
  let openBrowser = true;

  for (const arg of args) {
    if (arg === "--no-open") {
      openBrowser = false;
      continue;
    }
    forwardedArgs.push(arg);
  }

  const startupOptions = parseStartupOptions(forwardedArgs);
  return {
    ...startupOptions,
    openBrowser,
  };
}

async function runChecked(command: string[]): Promise<void> {
  const output = await new Deno.Command(command[0], {
    args: command.slice(1),
    stdout: "inherit",
    stderr: "inherit",
  }).output();

  if (!output.success) {
    throw new Error(
      `${command.join(" ")} failed with exit code ${output.code}`,
    );
  }
}

function ensureServerPortAvailable(options: LauncherOptions): void {
  let listener: Deno.Listener | undefined;
  try {
    listener = Deno.listen({
      hostname: options.hostname,
      port: options.port,
    });
  } catch (error) {
    if (error instanceof Deno.errors.AddrInUse) {
      throw new Error(
        `Port ${options.port} is already in use on ${options.hostname}. ` +
          `Stop the process using it, or start Nodebook with --port ${
            options.port + 1
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

    if (result === "ready") {
      return;
    }

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

  if (!output || output.success) {
    return;
  }

  const stderr = new TextDecoder().decode(output.stderr).trim();
  console.warn(
    `Could not open browser automatically${stderr ? `: ${stderr}` : ""}`,
  );
}

await main();
