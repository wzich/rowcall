import { parseStartupOptions } from "./startup_args.ts";

type LauncherOptions = ReturnType<typeof parseLauncherOptions>;

const serverUrl = (options: LauncherOptions) =>
  `http://${options.hostname}:${options.port}/`;

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

  console.info(`Starting Nodebook for ${options.documentPath}`);
  if (options.pythonCommand) {
    console.info(`Using Python: ${options.pythonCommand}`);
  }

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
    ...(options.create ? ["--create"] : []),
    ...(options.pythonCommand ? ["--python", options.pythonCommand] : []),
  ];
  const server = new Deno.Command(Deno.execPath(), {
    args: serverArgs,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const serverStatus = server.status;

  const url = serverUrl(options);
  await waitForServer(url, serverStatus);
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

async function waitForServer(
  url: string,
  status: Promise<Deno.CommandStatus>,
): Promise<void> {
  const deadline = Date.now() + 15_000;

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
