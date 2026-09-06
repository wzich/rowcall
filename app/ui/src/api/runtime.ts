import { rowcallFetch } from "./auth.ts";

const pythonRuntimePath = "/runtime/python";
const environmentRuntimePath = "/runtime/environment";

export type PythonRuntimeInfo = {
  command: string;
  executable: string;
  version: string;
  implementation: string;
  runtimeMode: "user" | "managed";
  condaPrefix?: string;
  virtualEnv?: string;
  rowcallImport: {
    ok: boolean;
    path?: string;
    error?: string;
  };
};

export type LoadPythonRuntimeSuccess = {
  ok: true;
  python: PythonRuntimeInfo;
};

export type ProjectEnvironmentInfo = {
  ownership: "rowcall" | "user";
  requirementsPath: string;
  requirementsPresent: boolean;
  requirementsStatus: "current" | "changed" | "unknown";
  canSync: boolean;
};

export type LoadProjectEnvironmentSuccess = {
  ok: true;
  environment: ProjectEnvironmentInfo;
};

export type RestartPythonRuntimeSuccess = {
  ok: true;
};

export type RuntimeApiError = {
  ok: false;
  error: {
    kind: string;
    message: string;
  };
};

type LoadPythonRuntimeResult = LoadPythonRuntimeSuccess | RuntimeApiError;
type LoadProjectEnvironmentResult =
  | LoadProjectEnvironmentSuccess
  | RuntimeApiError;
type RestartPythonRuntimeResult =
  | RestartPythonRuntimeSuccess
  | RuntimeApiError;

export class RuntimeApiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeApiRequestError";
  }
}

export async function loadPythonRuntime(): Promise<LoadPythonRuntimeSuccess> {
  const response = await rowcallFetch(pythonRuntimePath);
  const result = await response.json() as LoadPythonRuntimeResult;

  if (!result.ok) {
    throw new RuntimeApiRequestError(result.error.message);
  }

  return result;
}

export async function loadProjectEnvironment(): Promise<
  LoadProjectEnvironmentSuccess
> {
  const response = await rowcallFetch(environmentRuntimePath);
  return await decodeRuntimeResponse<LoadProjectEnvironmentResult>(response);
}

export async function syncProjectEnvironment(): Promise<
  LoadProjectEnvironmentSuccess
> {
  const response = await rowcallFetch(`${environmentRuntimePath}/sync`, {
    method: "POST",
  });
  return await decodeRuntimeResponse<LoadProjectEnvironmentResult>(response);
}

export async function restartPythonRuntime(): Promise<
  RestartPythonRuntimeSuccess
> {
  const response = await rowcallFetch(`${pythonRuntimePath}/restart`, {
    method: "POST",
  });
  return await decodeRuntimeResponse<RestartPythonRuntimeResult>(response);
}

async function decodeRuntimeResponse<
  TResult extends { ok: true } | RuntimeApiError,
>(response: Response): Promise<Extract<TResult, { ok: true }>> {
  const result = await response.json() as TResult;
  if (!result.ok) {
    throw new RuntimeApiRequestError(result.error.message);
  }
  return result as Extract<TResult, { ok: true }>;
}
