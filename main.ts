import { Hono } from "@hono/hono";
import type {
  ExecutionStreamEvent,
  TableQueryRequest,
  ValidationIssue,
} from "./types.ts";
import {
  decodeDocumentOperationsRequest,
  type RowcallDocumentV1,
} from "./document.ts";
import {
  applyPythonDocumentOperations,
  loadPythonDocumentAfterPendingOperations,
  loadPythonDocumentStatusAfterPendingOperations,
  readPythonDocumentSourceAtRevision,
} from "./python_document.ts";
import {
  clearSourceRuntimeSessionCache,
  getPythonEnvironmentInfo,
  querySourceRuntimeTable,
  resolvePythonCommand,
  runSourceGraph,
  runSourceSingleNode,
  runSourceToNode,
  shutdownSourceRuntimeSession,
  streamSourceRunGraph,
  streamSourceRunSingleNode,
  streamSourceRunToNode,
  withStoppedSourceRuntimeSession,
} from "./executor.ts";
import {
  inspectProjectEnvironment,
  ProjectEnvironmentSyncError,
  syncProjectEnvironment,
} from "./project_environment.ts";
import { configurePythonRuntime } from "./runtime_config.ts";
import { hasExplicitRunInputs } from "./run_inputs.ts";
import { parseStartupOptions } from "./startup_args.ts";

export const app = new Hono();
let uiDistPath: string | URL = "app/ui/dist";
let activeDocumentPath = "";
let activeEnvironmentDocumentPath = "";
let activeEnvironmentSync: Promise<unknown> | null = null;
let serverSecurity: RowcallServerSecurity = {
  hostname: "127.0.0.1",
  port: 8000,
  authToken: "secret-token",
};
// Padded SSE comments keep small fetch-stream chunks moving through browsers
// and intermediaries while a long-running node is not producing real events.
const executionStreamInitialPaddingBytes = 2048;
const executionStreamHeartbeatPaddingBytes = 1024;
const executionStreamHeartbeatIntervalMs = 750;
const defaultNewDocumentSource = `from rowcall import node


@node(id="n_start", outputs=[])
def start():
    pass
    return {}
`;

export function setActiveDocumentPathForTests(
  path: string,
  environmentPath = path,
): void {
  activeDocumentPath = path;
  activeEnvironmentDocumentPath = environmentPath;
}
export type RowcallServerOptions = {
  uiDistPath?: string | URL;
  authToken?: string;
};

export type RowcallServerSecurity = {
  hostname: string;
  port: number;
  authToken: string;
};

type RequestSecurityFailure = {
  ok: false;
  status: 401 | 403;
  message: string;
};

type RequestSecurityResult = { ok: true } | RequestSecurityFailure;

export async function startRowcallServer(
  args = Deno.args,
  options: RowcallServerOptions = {},
): Promise<void> {
  const startupOptions = getStartupOptions(args);
  configurePythonRuntime({
    command: startupOptions.pythonCommand,
    pythonPathEntries: startupOptions.rowcallPythonPackagePath
      ? [startupOptions.rowcallPythonPackagePath]
      : [],
    runtimeMode: startupOptions.runtimeMode,
  });
  uiDistPath = options.uiDistPath ?? startupOptions.uiDistPath ??
    "app/ui/dist";
  serverSecurity = {
    hostname: startupOptions.hostname,
    port: startupOptions.port,
    authToken: options.authToken ?? startupOptions.authToken ??
      crypto.randomUUID(),
  };
  const createActiveDocumentIfMissing = startupOptions.create;
  await ensureActiveDocumentExists(startupOptions.documentPath, {
    createIfMissing: createActiveDocumentIfMissing,
  });
  activeEnvironmentDocumentPath = await resolveDocumentLaunchPath(
    startupOptions.documentPath,
  );
  activeDocumentPath = await Deno.realPath(startupOptions.documentPath);
  console.info(`Rowcall document: ${activeDocumentPath}`);
  console.info(
    `Rowcall URL: ${
      buildRowcallUrl(
        startupOptions.hostname,
        startupOptions.port,
        serverSecurity.authToken,
      )
    }`,
  );

  const server = Deno.serve(
    { hostname: startupOptions.hostname, port: startupOptions.port },
    app.fetch,
  );
  await server.finished;
}

app.use("*", async (c, next) => {
  const result = validateLocalRequest(c.req.raw, serverSecurity);
  if (!result.ok) {
    return c.json(
      errorResponse({
        kind: "invalid_request",
        message: result.message,
      }),
      result.status,
    );
  }
  await next();
});

type ApiError = {
  kind:
    | "file_read_error"
    | "invalid_json"
    | "invalid_request"
    | "node_not_found"
    | "environment_not_managed"
    | "environment_sync_error"
    | "environment_sync_in_progress"
    | "runtime_restart_error"
    | "runtime_inspection_error"
    | "document_decode_error"
    | "document_write_error"
    | "stale_document"
    | "validation_error";
  message: string;
  issues?: ValidationIssue[];
  nodeId?: string;
};

type ApiErrorResponse = {
  ok: false;
  error: ApiError;
};

function errorResponse(error: ApiError): ApiErrorResponse {
  return { ok: false, error };
}

function documentDecodeError(issues: ValidationIssue[]): ApiErrorResponse {
  return errorResponse({
    kind: "document_decode_error",
    message: "Rowcall document decoding failed",
    issues,
  });
}

function getStartupOptions(args: string[]) {
  try {
    return parseStartupOptions(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}

export function buildRowcallUrl(
  hostname: string,
  port: number,
  authToken: string,
): string {
  const url = new URL(`http://${formatUrlHost(hostname)}:${port}/`);
  url.searchParams.set("token", authToken);
  return url.toString();
}

function formatUrlHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
}

export function validateLocalRequest(
  request: Request,
  security: RowcallServerSecurity,
): RequestSecurityResult {
  if (!isAllowedHostHeader(request.headers.get("host"), security.hostname)) {
    return {
      ok: false,
      status: 403,
      message: "Blocked request with unexpected Host header.",
    };
  }

  if (
    !isAllowedOriginHeader(request.headers.get("origin"), security.hostname)
  ) {
    return {
      ok: false,
      status: 403,
      message: "Blocked request with unexpected Origin header.",
    };
  }

  const url = new URL(request.url);
  if (!requiresAuthToken(request.method, url.pathname)) {
    return { ok: true };
  }

  const requestToken = request.headers.get("x-rowcall-token") ??
    url.searchParams.get("token");
  if (!security.authToken || requestToken !== security.authToken) {
    return {
      ok: false,
      status: 401,
      message: "Missing or invalid Rowcall authorization token.",
    };
  }

  return { ok: true };
}

function requiresAuthToken(method: string, pathname: string): boolean {
  if (
    method === "GET" && (pathname === "/" || pathname.startsWith("/assets/"))
  ) {
    return false;
  }

  return [
    "/document",
    "/run-node",
    "/run-to-node",
    "/run-graph",
    "/results",
    "/runtime/python",
    "/runtime/environment",
    "/runtime-session/clear-cache",
  ].some((apiPath) =>
    pathname === apiPath || pathname.startsWith(`${apiPath}/`)
  );
}

export function isAllowedHostHeader(
  hostHeader: string | null,
  configuredHostname: string,
): boolean {
  if (!hostHeader) return false;
  const hostname = parseHostHeaderHostname(hostHeader);
  return hostname !== null &&
    isAllowedLocalHostname(hostname, configuredHostname);
}

export function isAllowedOriginHeader(
  originHeader: string | null,
  configuredHostname: string,
): boolean {
  if (!originHeader) return true;
  try {
    const origin = new URL(originHeader);
    return isAllowedLocalHostname(origin.hostname, configuredHostname);
  } catch {
    return false;
  }
}

function parseHostHeaderHostname(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

function isAllowedLocalHostname(
  hostname: string,
  configuredHostname: string,
): boolean {
  const normalized = normalizeHostname(hostname);
  const configured = normalizeHostname(configuredHostname);
  return normalized === configured || [
    "localhost",
    "127.0.0.1",
    "::1",
    "0.0.0.0",
  ].includes(normalized);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

async function ensureActiveDocumentExists(
  path: string,
  options: { createIfMissing: boolean },
): Promise<void> {
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile) {
      console.error(`Rowcall document path is not a file: ${path}`);
      Deno.exit(1);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.error(`Unable to inspect Rowcall document path: ${path}`);
      console.error(error);
      Deno.exit(1);
    }

    if (options.createIfMissing) {
      await createRowcallDocument(path);
      console.info(`Created Rowcall Python document: ${path}`);
      return;
    }

    console.error(`Rowcall Python document does not exist: ${path}`);
    console.error(`Pass --create to initialize it.`);
    Deno.exit(1);
  }
}

async function createRowcallDocument(path: string): Promise<void> {
  const directory = getParentDirectory(path);
  if (directory) {
    await Deno.mkdir(directory, { recursive: true });
  }

  await Deno.writeTextFile(path, defaultNewDocumentSource);
}

async function getRunRequestSource(
  body: { source?: unknown; expectedRevision?: unknown },
): Promise<{ ok: true; source: string } | ApiErrorResponse> {
  if (
    body.expectedRevision !== undefined &&
    typeof body.expectedRevision !== "string"
  ) {
    return errorResponse({
      kind: "invalid_request",
      message: "expectedRevision must be a string when provided.",
    });
  }
  if (typeof body.source === "string") {
    return { ok: true, source: body.source };
  }

  if (typeof body.expectedRevision === "string") {
    const result = await readPythonDocumentSourceAtRevision(
      activeDocumentPath,
      body.expectedRevision,
    );
    if (!result.ok) {
      return errorResponse({
        kind: "stale_document",
        message:
          "The Python document changed on disk before execution started. Reload before running it.",
      });
    }
    return result;
  }

  return errorResponse({
    kind: "invalid_request",
    message:
      "Disk-backed run requests require expectedRevision. Load the document and bind the run to its displayed revision, or provide explicit source.",
  });
}

function runSourceErrorStatus(result: ApiErrorResponse): 409 | 422 {
  return result.error.kind === "stale_document" ? 409 : 422;
}

function sourceBackedInputsError(): ApiErrorResponse {
  return errorResponse({
    kind: "invalid_request",
    message:
      "Source-backed runs do not accept explicit inputs. Put root data in the Python document.",
  });
}

function graphPayloadWithoutSourceError(): ApiErrorResponse {
  return errorResponse({
    kind: "invalid_request",
    message:
      "Run routes are source-backed and do not accept graph payloads. Save document operations before running the active document.",
  });
}

function environmentSyncInProgressError(): ApiErrorResponse {
  return errorResponse({
    kind: "environment_sync_in_progress",
    message:
      "The project environment is being updated. Try again when the update finishes.",
  });
}

function hasGraphPayloadWithoutSource(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }

  const request = body as Record<string, unknown>;
  return "graph" in request && typeof request.source !== "string";
}

function getParentDirectory(path: string): string | undefined {
  const normalizedPath = path.replaceAll("\\", "/");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex < 0) {
    return undefined;
  }
  if (separatorIndex === 0) {
    return "/";
  }
  return path.slice(0, separatorIndex);
}

export async function resolveDocumentLaunchPath(path: string): Promise<string> {
  const normalizedPath = path.replaceAll("\\", "/");
  const filename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  const parent = getParentDirectory(path) ?? ".";
  const parentPath = /^[A-Za-z]:$/u.test(parent) ? `${parent}/` : parent;
  const resolvedParent = (await Deno.realPath(parentPath)).replace(
    /[\\/]+$/u,
    "",
  );
  return `${resolvedParent}/${filename}`;
}

function wantsExecutionStream(
  c: { req: { header: (name: string) => string | undefined } },
): boolean {
  return c.req.header("accept")?.includes("text/event-stream") ?? false;
}

function formatStreamEvent(event: ExecutionStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function formatStreamComment(comment: string, paddingBytes = 0): string {
  return `: ${comment}${" ".repeat(paddingBytes)}\n\n`;
}

function formatDocument(document: RowcallDocumentV1): RowcallDocumentV1 {
  return {
    version: document.version,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      code: node.code,
      outputs: node.outputs,
      ...(node.position ? { position: node.position } : {}),
      ...(node.title ? { title: node.title } : {}),
      ...(node.description ? { description: node.description } : {}),
      ...(node.runtimeCode ? { runtimeCode: node.runtimeCode } : {}),
      ...(node.functionName ? { functionName: node.functionName } : {}),
      ...(node.parameters ? { parameters: node.parameters } : {}),
      ...(node.customReturn !== undefined
        ? { customReturn: node.customReturn }
        : {}),
      ...(node.editable !== undefined ? { editable: node.editable } : {}),
    })),
    edges: document.edges.map((edge) => ({
      fromNode: edge.fromNode,
      fromOutput: edge.fromOutput,
      toNode: edge.toNode,
      toInput: edge.toInput,
    })),
    ...(document.globalsCode ? { globalsCode: document.globalsCode } : {}),
    ...(document.readOnly !== undefined ? { readOnly: document.readOnly } : {}),
    ...(document.revision ? { revision: document.revision } : {}),
  };
}

function getStaticContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

async function serveBuiltUiAsset(path: string): Promise<Response> {
  if (path.includes("..") || path.includes("\\")) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const file = await Deno.readFile(resolveUiDistPath(path));
    return new Response(file, {
      headers: {
        "Content-Type": getStaticContentType(path),
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
}

async function serveBuiltUiIndex(): Promise<Response> {
  try {
    const file = await Deno.readFile(resolveUiDistPath("index.html"));
    return new Response(file, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response(
        "React UI build not found. Run `deno task dev` for active development, or `deno task build` before starting the API directly.",
        {
          status: 404,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        },
      );
    }
    throw error;
  }
}

function resolveUiDistPath(path: string): string | URL {
  if (typeof uiDistPath === "string") {
    return `${uiDistPath}/${path}`;
  }
  return new URL(path, ensureTrailingSlash(uiDistPath));
}

function ensureTrailingSlash(url: URL): URL {
  return new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
}

export function streamExecutionEvents(
  runId: string,
  runType: ExecutionStreamEvent["runType"],
  events:
    | AsyncIterable<ExecutionStreamEvent>
    | ((signal: AbortSignal) => AsyncIterable<ExecutionStreamEvent>),
  targetNodeId?: string,
): Response {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let canceled = false;
  let iterator: AsyncIterator<ExecutionStreamEvent> | undefined;
  let cancelStream!: () => void;
  const canceledResult = new Promise<{ kind: "canceled" }>((resolve) => {
    cancelStream = () => resolve({ kind: "canceled" });
  });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueueFrame = (frame: string) => {
        if (!canceled) {
          controller.enqueue(encoder.encode(frame));
        }
      };

      try {
        enqueueFrame(
          formatStreamComment(
            "rowcall stream padding",
            executionStreamInitialPaddingBytes,
          ),
        );

        const eventSource = typeof events === "function"
          ? events(abortController.signal)
          : events;
        iterator = eventSource[Symbol.asyncIterator]();
        let nextEvent = waitForNextExecutionEvent(iterator);

        while (!canceled) {
          const heartbeat = waitForExecutionStreamHeartbeat();
          const result = await Promise.race([
            nextEvent,
            heartbeat.promise,
            canceledResult,
          ]);
          heartbeat.cancel();

          if (canceled || result.kind === "canceled") {
            return;
          }

          if (result.kind === "heartbeat") {
            enqueueFrame(
              formatStreamComment(
                "rowcall keep-alive",
                executionStreamHeartbeatPaddingBytes,
              ),
            );
            continue;
          }

          if (result.event.done) {
            break;
          }

          enqueueFrame(formatStreamEvent(result.event.value));
          nextEvent = waitForNextExecutionEvent(iterator);
        }

        if (!canceled) {
          controller.close();
        }
      } catch (error) {
        if (canceled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const event: ExecutionStreamEvent = {
          type: "run_failed",
          runId,
          runType,
          targetNodeId,
          response: {
            ok: false,
            runType,
            targetNodeId,
            finalNodeIds: [],
            executedNodeIds: [],
            resultsByNode: {},
            finalOutputsByNode: {},
            trace: null,
            error: {
              kind: "internal_error",
              message,
            },
          },
        };
        enqueueFrame(formatStreamEvent(event));
        controller.close();
      }
    },
    async cancel() {
      canceled = true;
      abortController.abort();
      cancelStream();
      await iterator?.return?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

function waitForNextExecutionEvent(
  iterator: AsyncIterator<ExecutionStreamEvent>,
) {
  return iterator.next().then((event) => ({
    kind: "event" as const,
    event,
  }));
}

function waitForExecutionStreamHeartbeat() {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<{ kind: "heartbeat" }>((resolve) => {
    timeoutId = setTimeout(
      () => resolve({ kind: "heartbeat" }),
      executionStreamHeartbeatIntervalMs,
    );
  });

  return {
    promise,
    cancel() {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    },
  };
}

app.get("/document", async (c) => {
  try {
    const decoded = await loadPythonDocumentAfterPendingOperations(
      activeDocumentPath,
    );

    if (!decoded.ok) {
      const readFailed = decoded.issues.some((issue) =>
        issue.kind === "document_read_error"
      );
      return c.json(
        readFailed
          ? errorResponse({
            kind: "file_read_error",
            message: decoded.issues[0]?.message ??
              `Unable to read Rowcall document: ${activeDocumentPath}`,
            issues: decoded.issues,
          })
          : documentDecodeError(decoded.issues),
        readFailed ? 500 : 422,
      );
    }

    return c.json({
      ok: true,
      document: formatDocument(decoded.document),
      path: activeDocumentPath,
    });
  } catch (_error) {
    return c.json(
      errorResponse({
        kind: "file_read_error",
        message: `Unable to read Rowcall document: ${activeDocumentPath}`,
      }),
      500,
    );
  }
});

app.get("/document/status", async (c) => {
  try {
    const status = await loadPythonDocumentStatusAfterPendingOperations(
      activeDocumentPath,
    );

    return c.json({
      ok: true,
      status,
    });
  } catch (_error) {
    return c.json(
      errorResponse({
        kind: "file_read_error",
        message: `Unable to read Rowcall document: ${activeDocumentPath}`,
      }),
      500,
    );
  }
});

app.get("/runtime/python", async (c) => {
  try {
    return c.json({
      ok: true,
      python: await getPythonEnvironmentInfo(),
    });
  } catch (error) {
    console.error("Failed to inspect Python runtime:");
    console.error(error);
    return c.json(
      errorResponse({
        kind: "runtime_inspection_error",
        message: "Unable to inspect the Python runtime Rowcall will use.",
      }),
      500,
    );
  }
});

app.get("/runtime/environment", async (c) => {
  try {
    const environment = await inspectProjectEnvironment(
      activeEnvironmentDocumentPath,
      await resolvePythonCommand(),
    );
    return c.json({
      ok: true,
      environment,
    });
  } catch (error) {
    console.error("Failed to inspect the project environment:");
    console.error(error);
    return c.json(
      errorResponse({
        kind: "runtime_inspection_error",
        message: "Unable to inspect the project Python environment.",
      }),
      500,
    );
  }
});

app.post("/runtime/environment/sync", async (c) => {
  if (activeEnvironmentSync) {
    return c.json(environmentSyncInProgressError(), 409);
  }

  const sync = (async () => {
    const pythonCommand = await resolvePythonCommand();
    const environment = await inspectProjectEnvironment(
      activeEnvironmentDocumentPath,
      pythonCommand,
    );
    if (!environment.canSync) {
      throw new ProjectEnvironmentSyncError(
        "not_managed",
        "Rowcall only installs dependencies into project environments it created.",
      );
    }
    if (environment.requirementsStatus === "current") {
      return { environment, updated: false };
    }

    return await withStoppedSourceRuntimeSession(() =>
      syncProjectEnvironment(activeEnvironmentDocumentPath, pythonCommand)
    );
  })();
  activeEnvironmentSync = sync;
  try {
    const result = await sync;
    return c.json({
      ok: true,
      environment: result.environment,
    });
  } catch (error) {
    if (error instanceof ProjectEnvironmentSyncError) {
      return c.json(
        errorResponse({
          kind: error.kind === "install_failed"
            ? "environment_sync_error"
            : "environment_not_managed",
          message: [error.message, error.output].filter(Boolean).join("\n\n"),
        }),
        error.kind === "install_failed" ? 422 : 409,
      );
    }
    console.error("Failed to update the project environment:");
    console.error(error);
    return c.json(
      errorResponse({
        kind: "environment_sync_error",
        message: "Unable to update the project Python environment.",
      }),
      500,
    );
  } finally {
    if (activeEnvironmentSync === sync) {
      activeEnvironmentSync = null;
    }
  }
});

app.post("/runtime/python/restart", async (c) => {
  if (activeEnvironmentSync) {
    return c.json(environmentSyncInProgressError(), 409);
  }
  try {
    await shutdownSourceRuntimeSession();
    return c.json({ ok: true });
  } catch (error) {
    console.error("Failed to restart the Python runtime:");
    console.error(error);
    return c.json(
      errorResponse({
        kind: "runtime_restart_error",
        message: "Unable to restart the Python runtime.",
      }),
      500,
    );
  }
});

app.post("/document/operations", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      errorResponse({
        kind: "invalid_json",
        message: "Unable to parse provided Rowcall document",
        issues: [{
          kind: "invalid_json",
          message: "Unable to parse provided Rowcall document",
        }],
      }),
      400,
    );
  }

  const decoded = decodeDocumentOperationsRequest(body);
  if (!decoded.ok) {
    return c.json(documentDecodeError(decoded.issues), 422);
  }

  try {
    const saved = await applyPythonDocumentOperations(
      activeDocumentPath,
      decoded.request.baseRevision,
      decoded.request.operations,
    );
    if (!saved.ok) {
      const stale = saved.issues.some((issue) =>
        issue.kind === "stale_document"
      );
      const writeFailed = saved.issues.some((issue) =>
        issue.kind === "document_write_error"
      );
      const readFailed = saved.issues.some((issue) =>
        issue.kind === "document_read_error"
      );
      return c.json(
        errorResponse({
          kind: stale
            ? "stale_document"
            : readFailed
            ? "file_read_error"
            : writeFailed
            ? "document_write_error"
            : "validation_error",
          message: stale
            ? "The Python document changed on disk after it was loaded. Reload before applying edits."
            : readFailed
            ? "Unable to read the Rowcall document before applying edits."
            : writeFailed
            ? "Unable to write Rowcall document."
            : "Document operation validation failed",
          issues: saved.issues,
        }),
        stale ? 409 : readFailed || writeFailed ? 500 : 422,
      );
    }

    return c.json({
      ok: true,
      document: formatDocument(saved.document),
      path: activeDocumentPath,
    });
  } catch (error) {
    console.error(
      `Failed to apply Python Rowcall document operations at ${activeDocumentPath}:`,
    );
    console.error(error);
    return c.json(
      errorResponse({
        kind: "document_write_error",
        message: `Unable to write Rowcall document: ${activeDocumentPath}`,
      }),
      500,
    );
  }
});

app.post("/run-node", async (c) => {
  if (activeEnvironmentSync) {
    return c.json(environmentSyncInProgressError(), 409);
  }
  const body = await c.req.json();
  if (hasGraphPayloadWithoutSource(body)) {
    return c.json(graphPayloadWithoutSourceError(), 422);
  }

  const nodeId = body.nodeId;

  if (typeof nodeId !== "string") {
    return c.json(
      errorResponse({
        kind: "invalid_request",
        message: "Run-node requests require a string nodeId.",
      }),
      422,
    );
  }

  const inputs = body.inputs || {};
  const trace = body.trace || false;
  if (hasExplicitRunInputs(body.inputs)) {
    return c.json(sourceBackedInputsError(), 422);
  }

  // TODO: Add scoped API-level concurrency and resource controls once the
  // product has a runtime/session/document model. The UI keeps one active run
  // at a time for now, but direct API callers can still start concurrent runs.
  if (wantsExecutionStream(c)) {
    const runId = crypto.randomUUID();
    const sourceResult = await getRunRequestSource(body);
    if (!sourceResult.ok) {
      return c.json(sourceResult, runSourceErrorStatus(sourceResult));
    }
    return streamExecutionEvents(
      runId,
      "run_node",
      (signal) =>
        streamSourceRunSingleNode(
          runId,
          sourceResult.source,
          activeDocumentPath,
          nodeId,
          inputs,
          trace,
          signal,
        ),
      nodeId,
    );
  }

  const sourceResult = await getRunRequestSource(body);
  if (!sourceResult.ok) {
    return c.json(sourceResult, runSourceErrorStatus(sourceResult));
  }
  const result = await runSourceSingleNode(
    sourceResult.source,
    activeDocumentPath,
    nodeId,
    inputs,
    trace,
  );

  return c.json(result);
});

app.post("/run-to-node", async (c) => {
  if (activeEnvironmentSync) {
    return c.json(environmentSyncInProgressError(), 409);
  }
  const body = await c.req.json();
  if (hasGraphPayloadWithoutSource(body)) {
    return c.json(graphPayloadWithoutSourceError(), 422);
  }

  const nodeId = body.nodeId;

  if (typeof nodeId !== "string") {
    return c.json(
      errorResponse({
        kind: "invalid_request",
        message: "Run-to-node requests require a string nodeId.",
      }),
      422,
    );
  }

  const inputs = body.inputs || {};
  const trace = body.trace || false;
  if (hasExplicitRunInputs(body.inputs)) {
    return c.json(sourceBackedInputsError(), 422);
  }

  if (wantsExecutionStream(c)) {
    const runId = crypto.randomUUID();
    const sourceResult = await getRunRequestSource(body);
    if (!sourceResult.ok) {
      return c.json(sourceResult, runSourceErrorStatus(sourceResult));
    }
    return streamExecutionEvents(
      runId,
      "run_to_node",
      (signal) =>
        streamSourceRunToNode(
          runId,
          sourceResult.source,
          activeDocumentPath,
          nodeId,
          inputs,
          trace,
          signal,
        ),
      nodeId,
    );
  }

  const sourceResult = await getRunRequestSource(body);
  if (!sourceResult.ok) {
    return c.json(sourceResult, runSourceErrorStatus(sourceResult));
  }
  const result = await runSourceToNode(
    sourceResult.source,
    activeDocumentPath,
    nodeId,
    inputs,
    trace,
  );

  return c.json(result);
});

app.post("/run-graph", async (c) => {
  if (activeEnvironmentSync) {
    return c.json(environmentSyncInProgressError(), 409);
  }
  const body = await c.req.json();
  if (hasGraphPayloadWithoutSource(body)) {
    return c.json(graphPayloadWithoutSourceError(), 422);
  }

  const inputs = body.inputs || {};
  const trace = body.trace || false;
  if (hasExplicitRunInputs(body.inputs)) {
    return c.json(sourceBackedInputsError(), 422);
  }

  if (wantsExecutionStream(c)) {
    const runId = crypto.randomUUID();
    const sourceResult = await getRunRequestSource(body);
    if (!sourceResult.ok) {
      return c.json(sourceResult, runSourceErrorStatus(sourceResult));
    }
    return streamExecutionEvents(
      runId,
      "run_graph",
      (signal) =>
        streamSourceRunGraph(
          runId,
          sourceResult.source,
          activeDocumentPath,
          inputs,
          trace,
          signal,
        ),
    );
  }

  const sourceResult = await getRunRequestSource(body);
  if (!sourceResult.ok) {
    return c.json(sourceResult, runSourceErrorStatus(sourceResult));
  }
  const result = await runSourceGraph(
    sourceResult.source,
    activeDocumentPath,
    inputs,
    trace,
  );

  return c.json(result);
});

app.post("/results/table", async (c) => {
  if (activeEnvironmentSync) {
    return c.json(environmentSyncInProgressError(), 409);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      errorResponse({
        kind: "invalid_json",
        message: "Unable to parse the table query.",
      }),
      400,
    );
  }

  const request = decodeTableQueryRequest(body);
  if (!request) {
    return c.json(
      errorResponse({
        kind: "invalid_request",
        message: "The table query is invalid.",
      }),
      422,
    );
  }

  try {
    const status = await loadPythonDocumentStatusAfterPendingOperations(
      activeDocumentPath,
    );
    if (status.sourceRevision !== request.documentRevision) {
      return c.json({
        ok: false,
        error: {
          kind: "stale_result",
          message:
            "These interactive results were produced by an older document. Run again to refresh them.",
        },
      }, 409);
    }

    const result = await querySourceRuntimeTable(request);
    if (result.ok) return c.json(result);
    if (result.error.kind === "stale_result") return c.json(result, 409);
    if (result.error.kind === "missing_output") return c.json(result, 404);
    return c.json(result, 422);
  } catch (error) {
    return c.json({
      ok: false,
      error: {
        kind: "table_query_failed",
        message: error instanceof Error
          ? error.message
          : "The interactive table query failed.",
      },
    }, 500);
  }
});

app.post("/runtime-session/clear-cache", async (c) => {
  if (activeEnvironmentSync) {
    return c.json(environmentSyncInProgressError(), 409);
  }
  return c.json(await clearSourceRuntimeSessionCache());
});

function decodeTableQueryRequest(value: unknown): TableQueryRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  for (
    const field of [
      "runId",
      "documentRevision",
      "nodeId",
      "outputName",
    ]
  ) {
    if (typeof body[field] !== "string" || body[field] === "") return null;
  }
  if (
    typeof body.offset !== "number" || !Number.isInteger(body.offset) ||
    body.offset < 0
  ) {
    return null;
  }
  let sort: TableQueryRequest["sort"] = null;
  if (body.sort !== null && body.sort !== undefined) {
    if (
      !body.sort || typeof body.sort !== "object" || Array.isArray(body.sort)
    ) {
      return null;
    }
    const candidate = body.sort as Record<string, unknown>;
    if (typeof candidate.descending !== "boolean") return null;
    if (candidate.kind === "index") {
      sort = { kind: "index", descending: candidate.descending };
    } else if (
      candidate.kind === "column" &&
      typeof candidate.columnIndex === "number" &&
      Number.isInteger(candidate.columnIndex) && candidate.columnIndex >= 0
    ) {
      sort = {
        kind: "column",
        columnIndex: candidate.columnIndex,
        descending: candidate.descending,
      };
    } else {
      return null;
    }
  }
  return {
    runId: body.runId as string,
    documentRevision: body.documentRevision as string,
    nodeId: body.nodeId as string,
    outputName: body.outputName as string,
    offset: body.offset,
    sort,
  };
}

app.get("/assets/*", (c) => {
  const path = c.req.path.slice(1);
  return serveBuiltUiAsset(path);
});

app.get("*", () => serveBuiltUiIndex());

if (import.meta.main) {
  await startRowcallServer();
}
