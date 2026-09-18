export type PythonImportStatus = {
  ok: boolean;
  path?: string;
  error?: string;
};

export type PythonEnvironmentInfo = {
  command: string;
  executable: string;
  version: string;
  implementation: string;
  runtimeMode: PythonRuntimeMode;
  condaPrefix?: string;
  virtualEnv?: string;
  rowcallImport: PythonImportStatus;
};

export type PythonRuntimeMode = "user" | "managed";

let configuredPythonCommand: string | undefined;
let configuredPythonPathEntries: string[] = [];
let configuredRuntimeMode: PythonRuntimeMode = "user";
export const localVirtualEnvDirectory = ".venv";

export function configurePythonCommand(command: string | undefined): void {
  configuredPythonCommand = command && command.length > 0 ? command : undefined;
}

export function configurePythonRuntime(options: {
  command?: string;
  pythonPathEntries?: string[];
  runtimeMode?: PythonRuntimeMode;
}): void {
  configurePythonCommand(options.command);
  configuredPythonPathEntries = options.pythonPathEntries ?? [];
  configuredRuntimeMode = options.runtimeMode ?? "user";
}

export async function resolvePythonCommand(): Promise<string> {
  if (configuredPythonCommand) {
    return configuredPythonCommand;
  }

  for (
    const command of [
      ...getLocalVirtualEnvPythonCandidates(),
      "python3",
      "python",
    ]
  ) {
    const output = await probePythonCommand(command);
    if (output?.success) {
      return command;
    }
  }

  return "python3";
}

export function getActiveEnvironmentPythonCandidates(): string[] {
  const candidates: string[] = [];
  const virtualEnv = Deno.env.get("VIRTUAL_ENV");
  const condaPrefix = Deno.env.get("CONDA_PREFIX");
  if (virtualEnv) {
    candidates.push(...getEnvironmentPythonCandidates(virtualEnv));
  }
  if (condaPrefix) {
    candidates.push(...getEnvironmentPythonCandidates(condaPrefix));
  }
  return candidates;
}

export function getLocalVirtualEnvPythonCandidates(
  cwd = ".",
): string[] {
  const prefix = cwd === "." || cwd.length === 0
    ? localVirtualEnvDirectory
    : `${cwd}/${localVirtualEnvDirectory}`;
  return [
    `${prefix}/bin/python`,
    `${prefix}/Scripts/python.exe`,
  ];
}

export function getPythonCommandEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    // Rowcall workers are headless. Prevent plotting libraries from selecting a
    // native GUI backend that can open windows and block the worker process.
    MPLBACKEND: "Agg",
    // The worker JSON protocol is UTF-8, regardless of the Windows code page.
    PYTHONIOENCODING: "utf-8",
  };
  if (configuredPythonPathEntries.length === 0) return environment;
  const existingPythonPath = Deno.env.get("PYTHONPATH");
  environment.PYTHONPATH = [
    ...configuredPythonPathEntries,
    ...(existingPythonPath ? [existingPythonPath] : []),
  ].join(Deno.build.os === "windows" ? ";" : ":");
  return environment;
}

export async function getPythonEnvironmentInfo(): Promise<
  PythonEnvironmentInfo
> {
  const command = await resolvePythonCommand();
  const probe = new Deno.Command(command, {
    args: [
      "-c",
      [
        "import importlib.util, json, os, platform, sys",
        "spec = importlib.util.find_spec('rowcall')",
        "rowcall_import = {'ok': spec is not None}",
        "if spec is not None:",
        "    rowcall_import['path'] = spec.origin",
        "else:",
        "    rowcall_import['error'] = 'Python cannot import rowcall'",
        "print(json.dumps({",
        "    'executable': sys.executable,",
        "    'version': platform.python_version(),",
        "    'implementation': platform.python_implementation(),",
        "    'condaPrefix': os.environ.get('CONDA_PREFIX'),",
        "    'virtualEnv': sys.prefix if sys.prefix != sys.base_prefix else None,",
        "    'rowcallImport': rowcall_import,",
        "}))",
      ].join("\n"),
    ],
    stdout: "piped",
    stderr: "piped",
    env: getPythonCommandEnvironment(),
  });
  const output = await probe.output();

  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `Failed to inspect Python runtime with ${command}${
        stderr ? `: ${stderr}` : ""
      }`,
    );
  }

  const text = new TextDecoder().decode(output.stdout);
  const parsed = JSON.parse(text) as {
    executable?: unknown;
    version?: unknown;
    implementation?: unknown;
    condaPrefix?: unknown;
    virtualEnv?: unknown;
    rowcallImport?: unknown;
  };
  const rowcallImport = asRecord(parsed.rowcallImport);

  if (
    typeof parsed.executable !== "string" ||
    typeof parsed.version !== "string" ||
    typeof parsed.implementation !== "string" ||
    typeof rowcallImport?.["ok"] !== "boolean"
  ) {
    throw new Error(`Python runtime probe returned an invalid response`);
  }

  return {
    command,
    executable: parsed.executable,
    version: parsed.version,
    implementation: parsed.implementation,
    runtimeMode: configuredRuntimeMode,
    ...(typeof parsed.condaPrefix === "string" && parsed.condaPrefix.length > 0
      ? { condaPrefix: parsed.condaPrefix }
      : {}),
    ...(typeof parsed.virtualEnv === "string" && parsed.virtualEnv.length > 0
      ? { virtualEnv: parsed.virtualEnv }
      : {}),
    rowcallImport: {
      ok: rowcallImport["ok"],
      ...(typeof rowcallImport["path"] === "string"
        ? { path: rowcallImport["path"] }
        : {}),
      ...(typeof rowcallImport["error"] === "string"
        ? { error: rowcallImport["error"] }
        : {}),
    },
  };
}

function getEnvironmentPythonCandidates(prefix: string): string[] {
  return [
    `${prefix}/bin/python`,
    `${prefix}/Scripts/python.exe`,
    `${prefix}/python.exe`, // Windows Conda environments keep Python at the root.
  ];
}

async function probePythonCommand(
  command: string,
): Promise<Deno.CommandOutput | null> {
  try {
    const probe = new Deno.Command(command, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    return await probe.output();
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
