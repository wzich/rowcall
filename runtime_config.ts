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
  condaPrefix?: string;
  virtualEnv?: string;
  nodebookImport: PythonImportStatus;
};

let configuredPythonCommand: string | undefined;

export function configurePythonCommand(command: string | undefined): void {
  configuredPythonCommand = command && command.length > 0 ? command : undefined;
}

export async function resolvePythonCommand(): Promise<string> {
  if (configuredPythonCommand) {
    return configuredPythonCommand;
  }

  for (const command of ["python3", "python"]) {
    const output = await probePythonCommand(command);
    if (output?.success) {
      return command;
    }
  }

  return "python3";
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

async function probePythonCommand(
  command: string,
): Promise<Deno.CommandOutput | null> {
  const probe = new Deno.Command(command, {
    args: ["--version"],
    stdout: "null",
    stderr: "null",
  });
  return await probe.output().catch(() => null);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
