import { getVenvPythonPath } from "./launcher_paths.ts";

export type ProjectEnvironmentSetupState = {
  status: "creating" | "incomplete" | "complete";
  requirementsFingerprint?: string;
};

export type ProjectEnvironmentStatus = {
  ownership: "rowcall" | "user";
  requirementsPath: string;
  requirementsPresent: boolean;
  requirementsStatus: "current" | "changed" | "unknown";
  canSync: boolean;
};

export type ProjectEnvironmentSyncResult = {
  environment: ProjectEnvironmentStatus;
  updated: boolean;
};

export class ProjectEnvironmentSyncError extends Error {
  readonly kind: "not_managed" | "install_failed";
  readonly output: string;

  constructor(
    kind: "not_managed" | "install_failed",
    message: string,
    output = "",
  ) {
    super(message);
    this.name = "ProjectEnvironmentSyncError";
    this.kind = kind;
    this.output = output;
  }
}

const installerDiagnosticLimit = 20_000;

export async function inspectProjectEnvironment(
  documentPath: string,
  pythonCommand: string,
): Promise<ProjectEnvironmentStatus> {
  const projectDirectory = getParentDirectory(documentPath) ?? ".";
  const venvDirectory = `${projectDirectory}/.venv`;
  const requirementsPath = `${projectDirectory}/requirements.txt`;
  const requirementsFingerprint = await projectRequirementsFingerprint(
    requirementsPath,
  );
  const setupState = await readProjectEnvironmentSetupState(
    projectEnvironmentSetupPath(venvDirectory),
  );
  const isSelectedProjectEnvironment = await pathsMatch(
    pythonCommand,
    getVenvPythonPath(venvDirectory),
  );

  if (!setupState || !isSelectedProjectEnvironment) {
    return {
      ownership: "user",
      requirementsPath,
      requirementsPresent: requirementsFingerprint !== "absent",
      requirementsStatus: "unknown",
      canSync: false,
    };
  }

  return {
    ownership: "rowcall",
    requirementsPath,
    requirementsPresent: requirementsFingerprint !== "absent",
    requirementsStatus: setupState.status === "complete" &&
        setupState.requirementsFingerprint === requirementsFingerprint
      ? "current"
      : "changed",
    canSync: true,
  };
}

export async function syncProjectEnvironment(
  documentPath: string,
  pythonCommand: string,
  options: {
    onInstall?: (requirementsPath: string) => void;
    installerOutput?: "capture" | "stderr";
  } = {},
): Promise<ProjectEnvironmentSyncResult> {
  const status = await inspectProjectEnvironment(documentPath, pythonCommand);
  if (!status.canSync) {
    throw new ProjectEnvironmentSyncError(
      "not_managed",
      "Rowcall only installs dependencies into project environments it created.",
    );
  }
  if (status.requirementsStatus === "current") {
    return { environment: status, updated: false };
  }

  const projectDirectory = getParentDirectory(documentPath) ?? ".";
  const venvDirectory = `${projectDirectory}/.venv`;
  const requirementsFingerprint = await projectRequirementsFingerprint(
    status.requirementsPath,
  );

  if (requirementsFingerprint !== "absent") {
    const absoluteProjectDirectory = await Deno.realPath(projectDirectory);
    const absoluteVenvDirectory = await Deno.realPath(venvDirectory);
    const absoluteRequirementsPath = await Deno.realPath(
      status.requirementsPath,
    );
    // pip can partly change an environment before failing. Invalidate the old
    // success marker first, even if requirements are later reverted.
    await Deno.writeTextFile(
      projectEnvironmentSetupPath(venvDirectory),
      "incomplete\n",
    );
    options.onInstall?.(absoluteRequirementsPath);
    const command = new Deno.Command(getVenvPythonPath(absoluteVenvDirectory), {
      args: ["-m", "pip", "install", "-r", absoluteRequirementsPath],
      cwd: absoluteProjectDirectory,
      stdout: "piped",
      stderr: "piped",
    });
    let output: BoundedCommandOutput;
    try {
      output = await runCommandWithBoundedOutput(
        command,
        options.installerOutput === "stderr",
      );
    } catch (error) {
      throw new ProjectEnvironmentSyncError(
        "install_failed",
        error instanceof Error
          ? error.message
          : "Could not start the Python package installer.",
      );
    }

    if (!output.success) {
      throw new ProjectEnvironmentSyncError(
        "install_failed",
        "Could not update the project environment. requirements.txt is still marked as needing an update.",
        output.detail,
      );
    }
  }

  await writeCompleteProjectEnvironmentSetup(
    projectEnvironmentSetupPath(venvDirectory),
    requirementsFingerprint,
  );
  return {
    environment: await inspectProjectEnvironment(documentPath, pythonCommand),
    updated: true,
  };
}

export function projectEnvironmentSetupPath(venvDirectory: string): string {
  return `${venvDirectory}/.rowcall-setup`;
}

export async function readProjectEnvironmentSetupState(
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

export async function writeCompleteProjectEnvironmentSetup(
  path: string,
  requirementsFingerprint: string,
): Promise<void> {
  await Deno.writeTextFile(
    path,
    `complete\nrequirements-sha256=${requirementsFingerprint}\n`,
  );
}

export async function projectRequirementsFingerprint(
  path: string,
): Promise<string> {
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

export async function readOptionalTextFile(
  path: string,
): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function pathsMatch(left: string, right: string): Promise<boolean> {
  return await normalizePath(left) === await normalizePath(right);
}

async function normalizePath(path: string): Promise<string> {
  const normalized = path.replaceAll("\\", "/").replace(/\/\.\//gu, "/");
  const absolute =
    normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)
      ? normalized
      : `${Deno.cwd().replaceAll("\\", "/")}/${normalized}`;
  const parent = getParentDirectory(absolute);
  const basename = absolute.slice(absolute.lastIndexOf("/") + 1);
  let canonical = absolute;
  if (parent) {
    try {
      canonical = `${await Deno.realPath(parent)}/${basename}`;
    } catch {
      // A missing interpreter will be reported by the runtime itself. Path
      // comparison can still use its normalized spelling here.
    }
  }
  canonical = canonical.replaceAll("\\", "/");
  return Deno.build.os === "windows" ? canonical.toLowerCase() : canonical;
}

type BoundedCommandOutput = {
  success: boolean;
  detail: string;
};

async function runCommandWithBoundedOutput(
  command: Deno.Command,
  forwardToStderr: boolean,
): Promise<BoundedCommandOutput> {
  const child = command.spawn();
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    readTextTail(child.stdout, installerDiagnosticLimit, forwardToStderr),
    readTextTail(child.stderr, installerDiagnosticLimit, forwardToStderr),
  ]);
  return {
    success: status.success,
    detail: [stdout, stderr]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n")
      .slice(-installerDiagnosticLimit),
  };
}

async function readTextTail(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  forwardToStderr: boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let tail = "";
  for await (const chunk of stream) {
    if (forwardToStderr) await Deno.stderr.write(chunk);
    tail = `${tail}${decoder.decode(chunk, { stream: true })}`.slice(-limit);
  }
  return `${tail}${decoder.decode()}`.slice(-limit);
}

function getParentDirectory(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  if (separator < 0) return undefined;
  if (separator === 0) return "/";
  return normalized.slice(
    0,
    separator === 2 && /^[A-Za-z]:/u.test(path) ? 3 : separator,
  );
}
