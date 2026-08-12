export type StartupOptions = {
  documentPath: string;
  create: boolean;
  pythonCommand?: string;
  rowcallPythonPackagePath?: string;
  runtimeMode?: "user" | "managed";
  uiDistPath?: string;
  authToken?: string;
  port: number;
  hostname: string;
};

export const defaultDocumentPath = "examples/ecommerce/analysis.py";
export const defaultPort = 8000;
export const defaultHostname = "127.0.0.1";

export function parseStartupOptions(args: string[]): StartupOptions {
  let documentPath: string | undefined;
  let create = false;
  let pythonCommand: string | undefined;
  let rowcallPythonPackagePath: string | undefined;
  let runtimeMode: "user" | "managed" | undefined;
  let uiDistPath: string | undefined;
  let authToken: string | undefined;
  let port = defaultPort;
  let hostname = defaultHostname;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "--create") {
      create = true;
      continue;
    }

    if (arg === "--document") {
      documentPath = readFlagValue(args, index, "--document");
      index += 1;
      continue;
    }

    if (arg === "--python") {
      pythonCommand = readFlagValue(args, index, "--python");
      index += 1;
      continue;
    }

    if (arg === "--rowcall-python-package") {
      rowcallPythonPackagePath = readFlagValue(
        args,
        index,
        "--rowcall-python-package",
      );
      index += 1;
      continue;
    }

    if (arg === "--runtime-mode") {
      runtimeMode = parseRuntimeMode(
        readFlagValue(args, index, "--runtime-mode"),
      );
      index += 1;
      continue;
    }

    if (arg === "--ui-dist") {
      uiDistPath = readFlagValue(args, index, "--ui-dist");
      index += 1;
      continue;
    }

    if (arg === "--auth-token") {
      authToken = readFlagValue(args, index, "--auth-token");
      index += 1;
      continue;
    }

    if (arg === "--port") {
      const rawPort = readFlagValue(args, index, "--port");
      port = parsePort(rawPort);
      index += 1;
      continue;
    }

    if (arg === "--hostname") {
      hostname = readFlagValue(args, index, "--hostname");
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown startup option: ${arg}`);
    }

    if (documentPath !== undefined) {
      throw new Error(
        `Unexpected extra document path: ${arg}. Pass only one .py document.`,
      );
    }
    documentPath = arg;
  }

  const resolvedDocumentPath = documentPath ?? defaultDocumentPath;
  if (!resolvedDocumentPath.endsWith(".py")) {
    throw new Error("Rowcall document path must end with .py");
  }

  return {
    documentPath: resolvedDocumentPath,
    create,
    ...(pythonCommand ? { pythonCommand } : {}),
    ...(rowcallPythonPackagePath ? { rowcallPythonPackagePath } : {}),
    ...(runtimeMode ? { runtimeMode } : {}),
    ...(uiDistPath ? { uiDistPath } : {}),
    ...(authToken ? { authToken } : {}),
    port,
    hostname,
  };
}

function parseRuntimeMode(value: string): "user" | "managed" {
  if (value === "user" || value === "managed") return value;
  throw new Error(`Invalid --runtime-mode value: ${value}`);
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

function parsePort(rawPort: string): number {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${rawPort}`);
  }
  return port;
}
