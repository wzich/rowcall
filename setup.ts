const venvDirectory = ".venv";
const requirementsPath = "requirements-alpha.txt";

type SetupOptions = {
  pythonCommand?: string;
};

async function main(): Promise<void> {
  let options: SetupOptions;
  try {
    options = parseSetupOptions(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }

  const basePython = options.pythonCommand ?? await findBasePythonCommand();
  await ensureCompatiblePython(basePython);

  const venvPython = getLocalVenvPythonCommand();
  if (!await commandExists(venvPython)) {
    console.info(`Creating ${venvDirectory} with ${basePython}...`);
    await runChecked([basePython, "-m", "venv", venvDirectory]);
  } else {
    console.info(`Using existing ${venvDirectory}.`);
  }

  console.info(
    `Installing alpha Python dependencies from ${requirementsPath}...`,
  );
  await runChecked([
    venvPython,
    "-m",
    "pip",
    "install",
    "-r",
    requirementsPath,
  ]);

  console.info("");
  console.info("Nodebook Python environment is ready.");
  console.info(`Run: deno task start`);
}

function parseSetupOptions(args: string[]): SetupOptions {
  let pythonCommand: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--python") {
      pythonCommand = readFlagValue(args, index, "--python");
      index += 1;
      continue;
    }

    throw new Error(`Unknown setup option: ${arg}`);
  }

  return {
    ...(pythonCommand ? { pythonCommand } : {}),
  };
}

function readFlagValue(
  args: string[],
  index: number,
  flagName: string,
): string {
  const value = args[index + 1];
  if (!value || value === "--" || value.startsWith("--")) {
    throw new Error(`Missing value after ${flagName}`);
  }
  return value;
}

async function findBasePythonCommand(): Promise<string> {
  for (const command of ["python3", "python"]) {
    if (await commandExists(command)) {
      return command;
    }
  }

  throw new Error(
    "Could not find Python. Install Python 3.10 or newer, then rerun `deno task setup`.",
  );
}

async function ensureCompatiblePython(command: string): Promise<void> {
  const output = await new Deno.Command(command, {
    args: [
      "-c",
      "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)",
    ],
    stdout: "null",
    stderr: "null",
  }).output().catch(() => null);

  if (!output?.success) {
    throw new Error(
      `${command} is not Python 3.10 or newer. Pass a compatible interpreter with ` +
        "`deno task setup --python /path/to/python`.",
    );
  }
}

async function commandExists(command: string): Promise<boolean> {
  const output = await new Deno.Command(command, {
    args: ["--version"],
    stdout: "null",
    stderr: "null",
  }).output().catch(() => null);
  return output?.success ?? false;
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

function getLocalVenvPythonCommand(): string {
  if (Deno.build.os === "windows") {
    return `${venvDirectory}\\Scripts\\python.exe`;
  }

  return `${venvDirectory}/bin/python`;
}

await main();
