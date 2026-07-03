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
  nodebookImport: PythonImportStatus;
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
  if (configuredPythonPathEntries.length === 0) return {};
  const existingPythonPath = Deno.env.get("PYTHONPATH");
  return {
    PYTHONPATH: [
      ...configuredPythonPathEntries,
      ...(existingPythonPath ? [existingPythonPath] : []),
    ].join(Deno.build.os === "windows" ? ";" : ":"),
  };
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
        "spec = importlib.util.find_spec('nodebook')",
        "nodebook_import = {'ok': spec is not None}",
        "if spec is not None:",
        "    nodebook_import['path'] = spec.origin",
        "else:",
        "    nodebook_import['error'] = 'Python cannot import nodebook'",
        "print(json.dumps({",
        "    'executable': sys.executable,",
        "    'version': platform.python_version(),",
        "    'implementation': platform.python_implementation(),",
        "    'condaPrefix': os.environ.get('CONDA_PREFIX'),",
        "    'virtualEnv': os.environ.get('VIRTUAL_ENV'),",
        "    'nodebookImport': nodebook_import,",
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
    nodebookImport?: unknown;
  };
  const nodebookImport = asRecord(parsed.nodebookImport);

  if (
    typeof parsed.executable !== "string" ||
    typeof parsed.version !== "string" ||
    typeof parsed.implementation !== "string" ||
    typeof nodebookImport?.["ok"] !== "boolean"
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
    nodebookImport: {
      ok: nodebookImport["ok"],
      ...(typeof nodebookImport["path"] === "string"
        ? { path: nodebookImport["path"] }
        : {}),
      ...(typeof nodebookImport["error"] === "string"
        ? { error: nodebookImport["error"] }
        : {}),
    },
  };
}

function getEnvironmentPythonCandidates(prefix: string): string[] {
  return [
    `${prefix}/bin/python`,
    `${prefix}/Scripts/python.exe`,
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
