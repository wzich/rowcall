const hostname = "127.0.0.1";
const smokeTimeoutMs = 60_000;
const shutdownTimeoutMs = 10_000;

type CapturedOutput = {
  text: () => string;
  done: Promise<void>;
};

async function main(): Promise<void> {
  console.info("Building the compiled Rowcall launcher...");
  await runChecked(Deno.execPath(), ["task", "launcher:compile"]);

  const temporaryRoot = await Deno.makeTempDir({
    prefix: "rowcall-binary-smoke-",
  });
  const isolatedHome = `${temporaryRoot}/home`;
  const projectDirectory = `${temporaryRoot}/project`;
  let launcher: Deno.ChildProcess | undefined;
  let launcherStatus: Promise<Deno.CommandStatus> | undefined;
  let stdout: CapturedOutput | undefined;
  let stderr: CapturedOutput | undefined;

  try {
    await Deno.mkdir(isolatedHome, { recursive: true });
    await Deno.mkdir(projectDirectory, { recursive: true });
    await Deno.writeTextFile(
      `${projectDirectory}/graph.py`,
      `from rowcall import node


@node(id="n_start", outputs=[])
def start():
    return {}
`,
    );

    const binaryPath = await Deno.realPath(
      Deno.build.os === "windows" ? "dist/rowcall.exe" : "dist/rowcall",
    );
    const port = reserveAvailablePort();
    const origin = `http://${hostname}:${port}`;

    console.info("Launching the compiled binary against an isolated folder...");
    launcher = new Deno.Command(binaryPath, {
      args: [
        projectDirectory,
        "--no-open",
        "--hostname",
        hostname,
        "--port",
        String(port),
      ],
      env: {
        HOME: isolatedHome,
        PYTHONPATH: "",
      },
      cwd: temporaryRoot,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    launcherStatus = launcher.status;
    stdout = captureAndForward(launcher.stdout, Deno.stdout);
    stderr = captureAndForward(launcher.stderr, Deno.stderr);

    const indexResponse = await waitForHttpResponse(
      origin,
      launcherStatus,
      () => `${stdout?.text() ?? ""}${stderr?.text() ?? ""}`,
    );
    const indexHtml = await indexResponse.text();
    if (!indexHtml.includes('id="root"')) {
      throw new Error("Compiled launcher did not serve the Rowcall UI index.");
    }

    const assetPath = indexHtml.match(
      /(?:src|href)="([^"]*\/assets\/[^"]+)"/u,
    )?.[1];
    if (!assetPath) {
      throw new Error("Compiled UI index did not reference a built asset.");
    }
    const assetResponse = await fetch(new URL(assetPath, origin));
    if (!assetResponse.ok) {
      throw new Error(
        `Compiled UI asset request failed with status ${assetResponse.status}.`,
      );
    }
    await assetResponse.body?.cancel();

    const authToken = await waitForAuthToken(
      () => stdout?.text() ?? "",
      launcherStatus,
    );
    const documentResponse = await fetch(`${origin}/document`, {
      headers: { "X-Rowcall-Token": authToken },
    });
    const documentPayload = await documentResponse.json() as {
      ok?: unknown;
      path?: unknown;
    };
    if (
      !documentResponse.ok || documentPayload.ok !== true ||
      typeof documentPayload.path !== "string" ||
      !documentPayload.path.endsWith("/graph.py")
    ) {
      throw new Error(
        `Compiled launcher document request failed: ${
          JSON.stringify(documentPayload)
        }`,
      );
    }

    console.info(
      "Compiled binary smoke test passed: folder resolution, bundled Python, authentication, and built UI are working.",
    );
  } finally {
    try {
      if (launcher && launcherStatus) {
        await stopLauncher(launcher, launcherStatus);
      }
    } finally {
      await Promise.allSettled([stdout?.done, stderr?.done].filter(Boolean));
      await Deno.remove(temporaryRoot, { recursive: true });
    }
  }
}

function reserveAvailablePort(): number {
  const listener = Deno.listen({ hostname, port: 0 });
  try {
    return (listener.addr as Deno.NetAddr).port;
  } finally {
    listener.close();
  }
}

function captureAndForward(
  stream: ReadableStream<Uint8Array>,
  destination: { write(data: Uint8Array): Promise<number> },
): CapturedOutput {
  let text = "";
  const decoder = new TextDecoder();
  const done = (async () => {
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
      await destination.write(chunk);
    }
    text += decoder.decode();
  })();
  return { text: () => text, done };
}

async function waitForHttpResponse(
  origin: string,
  status: Promise<Deno.CommandStatus>,
  diagnostics: () => string,
): Promise<Response> {
  const deadline = Date.now() + smokeTimeoutMs;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      fetch(origin).catch(() => null),
      status.then((processStatus) => ({ processStatus })),
      delay(150).then(() => null),
    ]);
    if (result instanceof Response) {
      if (result.ok) return result;
      await result.body?.cancel();
    } else if (result && "processStatus" in result) {
      throw new Error(
        `Compiled launcher exited before serving the UI (code ${result.processStatus.code}).\n${diagnostics()}`,
      );
    }
  }
  throw new Error(
    `Timed out waiting for the compiled launcher at ${origin}.\n${diagnostics()}`,
  );
}

async function waitForAuthToken(
  output: () => string,
  status: Promise<Deno.CommandStatus>,
): Promise<string> {
  const deadline = Date.now() + smokeTimeoutMs;
  while (Date.now() < deadline) {
    const match = output().match(/[?&]token=([^\s&]+)/u);
    if (match?.[1]) return decodeURIComponent(match[1]);

    const result = await Promise.race([
      status.then((processStatus) => ({ processStatus })),
      delay(50).then(() => null),
    ]);
    if (result) {
      throw new Error(
        `Compiled launcher exited before reporting its auth token (code ${result.processStatus.code}).`,
      );
    }
  }
  throw new Error("Timed out waiting for the compiled launcher auth token.");
}

async function stopLauncher(
  launcher: Deno.ChildProcess,
  status: Promise<Deno.CommandStatus>,
): Promise<void> {
  try {
    launcher.kill(Deno.build.os === "windows" ? "SIGINT" : "SIGTERM");
  } catch {
    return;
  }

  const stopped = await Promise.race([
    status.then(() => true),
    delay(shutdownTimeoutMs).then(() => false),
  ]);
  if (stopped) return;

  launcher.kill("SIGKILL");
  await status;
  throw new Error(
    "Compiled launcher did not stop cleanly after the smoke test.",
  );
}

async function runChecked(command: string, args: string[]): Promise<void> {
  const status = await new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${status.code}.`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.main) {
  await main();
}
