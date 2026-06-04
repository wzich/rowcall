const pythonRuntimePath = "/runtime/python";

export type PythonRuntimeInfo = {
  command: string;
  executable: string;
  version: string;
  implementation: string;
};

export type LoadPythonRuntimeSuccess = {
  ok: true;
  python: PythonRuntimeInfo;
};

export type RuntimeApiError = {
  ok: false;
  error: {
    kind: string;
    message: string;
  };
};

type LoadPythonRuntimeResult = LoadPythonRuntimeSuccess | RuntimeApiError;

export class RuntimeApiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeApiRequestError";
  }
}

export async function loadPythonRuntime(): Promise<LoadPythonRuntimeSuccess> {
  const response = await fetch(pythonRuntimePath);
  const result = await response.json() as LoadPythonRuntimeResult;

  if (!result.ok) {
    throw new RuntimeApiRequestError(result.error.message);
  }

  return result;
}
