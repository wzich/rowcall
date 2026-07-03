import { Hono } from "@hono/hono";
import {
  assertNodeExists,
  buildDownstreamAdjacency,
  buildUpstreamAdjacency,
  decodeGraph,
  getSinkNodes,
  getSourceNodes,
  validateGraph,
} from "./graph.ts";
import type { ExecutionStreamEvent, Graph, ValidationIssue } from "./types.ts";
import { decodeNodebookDocument, type NodebookDocumentV1 } from "./document.ts";
import {
  loadPythonDocument,
  renderPythonDocumentSource,
  savePythonDocument,
} from "./python_document.ts";
import {
  clearRuntimeSessionCache,
  clearSourceRuntimeSessionCache,
  getPythonEnvironmentInfo,
  runGraph,
  runSingleNode,
  runSourceGraph,
  runSourceSingleNode,
  runSourceToNode,
  runToNode,
  streamRunGraph,
  streamRunSingleNode,
  streamRunToNode,
  streamSourceRunGraph,
  streamSourceRunSingleNode,
  streamSourceRunToNode,
} from "./executor.ts";
import { configurePythonCommand } from "./runtime_config.ts";
import { hasExplicitRunInputs } from "./run_inputs.ts";
import { parseStartupOptions } from "./startup_args.ts";

const app = new Hono();
let uiDistPath: string | URL = "app/ui/dist";
let activeDocumentPath = "";
let serverSecurity: NodebookServerSecurity = {
  hostname: "127.0.0.1",
  port: 8000,
  authToken: "",
};
const defaultNewDocumentSource = `from nodebook import node


@node(id="n_start", outputs=["message"])
def start():
    message = "hello"
    return {"message": message}
`;
export type NodebookServerOptions = {
  uiDistPath?: string | URL;
  authToken?: string;
};

export type NodebookServerSecurity = {
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

export async function startNodebookServer(
  args = Deno.args,
  options: NodebookServerOptions = {},
): Promise<void> {
  const startupOptions = getStartupOptions(args);
  configurePythonCommand(startupOptions.pythonCommand);
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
  activeDocumentPath = await Deno.realPath(startupOptions.documentPath);
  console.info(`Nodebook document: ${activeDocumentPath}`);
  console.info(
    `Nodebook URL: ${
      buildNodebookUrl(
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
    | "runtime_inspection_error"
    | "document_decode_error"
    | "document_write_error"
    | "validation_error";
  message: string;
  issues?: ValidationIssue[];
  nodeId?: string;
};

type ApiErrorResponse = {
  ok: false;
  error: ApiError;
};

type GraphResolutionResult =
  | { ok: true; graph: Graph }
  | ApiErrorResponse;

function errorResponse(error: ApiError): ApiErrorResponse {
  return { ok: false, error };
}

function graphValidationError(issues: ValidationIssue[]): ApiErrorResponse {
  return errorResponse({
    kind: "validation_error",
    message: "Graph validation failed",
    issues,
  });
}

function nodeNotFoundError(nodeId: unknown): ApiErrorResponse {
  const nodeIdString = String(nodeId);
  return errorResponse({
    kind: "node_not_found",
    message: `Failed to find node ${nodeIdString} in provided graph.`,
    nodeId: nodeIdString,
  });
}

function decodeAndValidateGraph(graph: unknown): GraphResolutionResult {
  const decoded = decodeGraph(graph);
  if (!decoded.ok) {
    return graphValidationError(decoded.issues);
  }
  const validated = validateGraph(decoded.graph);
  if (!validated.ok) {
    return graphValidationError(validated.issues);
  }

  return { ok: true, graph: decoded.graph };
}

function documentDecodeError(issues: ValidationIssue[]): ApiErrorResponse {
  return errorResponse({
    kind: "document_decode_error",
    message: "Nodebook document decoding failed",
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

export function buildNodebookUrl(
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
  security: NodebookServerSecurity,
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

  const requestToken = request.headers.get("x-nodebook-token") ??
    url.searchParams.get("token");
  if (!security.authToken || requestToken !== security.authToken) {
    return {
      ok: false,
      status: 401,
      message: "Missing or invalid Nodebook authorization token.",
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
    "/inspect",
    "/run-node",
    "/run-to-node",
    "/run-graph",
    "/runtime/python",
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
      console.error(`Nodebook document path is not a file: ${path}`);
      Deno.exit(1);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.error(`Unable to inspect Nodebook document path: ${path}`);
      console.error(error);
      Deno.exit(1);
    }

    if (options.createIfMissing) {
      await createNodebookDocument(path);
      console.info(`Created Nodebook Python document: ${path}`);
      return;
    }

    console.error(`Nodebook Python document does not exist: ${path}`);
    console.error(`Pass --create to initialize it.`);
    Deno.exit(1);
  }
}

async function createNodebookDocument(path: string): Promise<void> {
  const directory = getParentDirectory(path);
  if (directory) {
    await Deno.mkdir(directory, { recursive: true });
  }

  await Deno.writeTextFile(path, defaultNewDocumentSource);
}

async function readActiveDocumentSource(): Promise<string> {
  return await Deno.readTextFile(activeDocumentPath);
}

async function getRunRequestSource(
  body: { source?: unknown; document?: unknown },
): Promise<{ ok: true; source: string } | ApiErrorResponse> {
  if (typeof body.source === "string") {
    return { ok: true, source: body.source };
  }

  if (body.document !== undefined) {
    const decoded = decodeNodebookDocument(body.document);
    if (!decoded.ok) {
      return documentDecodeError(decoded.issues);
    }

    const rendered = await renderPythonDocumentSource(
      activeDocumentPath,
      decoded.document,
    );
    if (!rendered.ok) {
      return documentDecodeError(rendered.issues);
    }

    return { ok: true, source: rendered.source };
  }

  return { ok: true, source: await readActiveDocumentSource() };
}

function hasRunRequestSource(body: { source?: unknown }): body is {
  source: string;
} {
  return typeof body.source === "string";
}

function hasRunRequestDocument(body: { document?: unknown }): boolean {
  return body.document !== undefined;
}

function sourceBackedInputsError(): ApiErrorResponse {
  return errorResponse({
    kind: "invalid_request",
    message:
      "Source-backed runs do not accept explicit inputs. Put root data in the Python document.",
  });
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

function wantsExecutionStream(
  c: { req: { header: (name: string) => string | undefined } },
): boolean {
  return c.req.header("accept")?.includes("text/event-stream") ?? false;
}

function formatStreamEvent(event: ExecutionStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function formatDocument(document: NodebookDocumentV1): NodebookDocumentV1 {
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
      toNode: edge.toNode,
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
        "React UI build not found. Run `deno task ui:build` first, or use `deno task ui:dev` during development.",
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

function streamExecutionEvents(
  runId: string,
  runType: ExecutionStreamEvent["runType"],
  events: AsyncIterable<ExecutionStreamEvent>,
  targetNodeId?: string,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(encoder.encode(formatStreamEvent(event)));
        }
        controller.close();
      } catch (error) {
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
        controller.enqueue(encoder.encode(formatStreamEvent(event)));
        controller.close();
      }
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

app.post("/inspect", async (c) => {
  const body = await c.req.json();

  const resolved = decodeAndValidateGraph(body.graph);
  if (!resolved.ok) {
    return c.json(
      resolved,
      422,
    );
  }
  const graph = resolved.graph;

  const upstream = buildUpstreamAdjacency(graph);
  const downstream = buildDownstreamAdjacency(graph);
  const sourceNodes = getSourceNodes(graph);
  const sinkNodes = getSinkNodes(graph);

  return c.json({
    ok: true,
    graph,
    summary: {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      sourceNodeIds: [...sourceNodes],
      sinkNodeIds: [...sinkNodes],
    },
    nodeDetails: graph.nodes.map((node) => ({
      id: node.id,
      outputs: node.outputs,
      upstreamDependencies: upstream.get(node.id),
      downstreamDependencies: downstream.get(node.id),
      isSourceNode: sourceNodes.has(node.id),
      isSinkNode: sinkNodes.has(node.id),
    })),
  });
});

app.get("/document", async (c) => {
  try {
    const decoded = await loadPythonDocument(activeDocumentPath);

    if (!decoded.ok) {
      return c.json(documentDecodeError(decoded.issues), 422);
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
        message: `Unable to read Nodebook document: ${activeDocumentPath}`,
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
        message: "Unable to inspect the Python runtime Nodebook will use.",
      }),
      500,
    );
  }
});

app.put("/document", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      errorResponse({
        kind: "invalid_json",
        message: "Unable to parse provided Nodebook document",
        issues: [{
          kind: "invalid_json",
          message: "Unable to parse provided Nodebook document",
        }],
      }),
      400,
    );
  }

  const decoded = decodeNodebookDocument(body);
  if (!decoded.ok) {
    return c.json(documentDecodeError(decoded.issues), 422);
  }

  try {
    const saved = await savePythonDocument(
      activeDocumentPath,
      decoded.document,
    );
    if (!saved.ok) {
      return c.json(documentDecodeError(saved.issues), 409);
    }

    return c.json({
      ok: true,
      document: formatDocument(saved.document),
      path: activeDocumentPath,
    });
  } catch (error) {
    console.error(
      `Failed to write Python Nodebook document at ${activeDocumentPath}:`,
    );
    console.error(error);
    return c.json(
      errorResponse({
        kind: "document_write_error",
        message: `Unable to write Nodebook document: ${activeDocumentPath}`,
      }),
      500,
    );
  }
});

app.post("/run-node", async (c) => {
  const body = await c.req.json();
  const hasSourceInput = hasRunRequestSource(body) ||
    hasRunRequestDocument(body);
  let graph: Graph | null = null;

  const nodeId = body.nodeId;

  if (hasSourceInput) {
    if (typeof nodeId !== "string") {
      return c.json(
        errorResponse({
          kind: "invalid_request",
          message: "Run-node requests require a string nodeId.",
        }),
        422,
      );
    }
  } else {
    const resolved = decodeAndValidateGraph(body.graph);
    if (!resolved.ok) {
      return c.json(
        resolved,
        422,
      );
    }
    graph = resolved.graph;

    try {
      assertNodeExists(graph, nodeId);
    } catch {
      return c.json(nodeNotFoundError(nodeId), 422);
    }
  }

  const inputs = body.inputs || {};
  const trace = body.trace || false;
  if (hasSourceInput && hasExplicitRunInputs(body.inputs)) {
    return c.json(sourceBackedInputsError(), 422);
  }

  // TODO: Add scoped API-level concurrency and resource controls once the
  // product has a runtime/session/document model. The UI keeps one active run
  // at a time for now, but direct API callers can still start concurrent runs.
  if (wantsExecutionStream(c)) {
    const runId = crypto.randomUUID();
    if (!hasSourceInput && graph) {
      return streamExecutionEvents(
        runId,
        "run_node",
        streamRunSingleNode(runId, graph, nodeId, inputs, trace),
        nodeId,
      );
    }

    const sourceResult = await getRunRequestSource(body);
    if (!sourceResult.ok) {
      return c.json(sourceResult, 422);
    }
    return streamExecutionEvents(
      runId,
      "run_node",
      streamSourceRunSingleNode(
        runId,
        sourceResult.source,
        activeDocumentPath,
        nodeId,
        inputs,
        trace,
      ),
      nodeId,
    );
  }

  if (!hasSourceInput && graph) {
    const result = await runSingleNode(graph, nodeId, inputs, trace);
    return c.json(result);
  }

  const sourceResult = await getRunRequestSource(body);
  if (!sourceResult.ok) {
    return c.json(sourceResult, 422);
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
  const body = await c.req.json();
  const hasSourceInput = hasRunRequestSource(body) ||
    hasRunRequestDocument(body);
  let graph: Graph | null = null;

  const nodeId = body.nodeId;

  if (hasSourceInput) {
    if (typeof nodeId !== "string") {
      return c.json(
        errorResponse({
          kind: "invalid_request",
          message: "Run-to-node requests require a string nodeId.",
        }),
        422,
      );
    }
  } else {
    const resolved = decodeAndValidateGraph(body.graph);
    if (!resolved.ok) {
      return c.json(
        resolved,
        422,
      );
    }
    graph = resolved.graph;

    try {
      assertNodeExists(graph, nodeId);
    } catch {
      return c.json(nodeNotFoundError(nodeId), 422);
    }
  }

  const inputs = body.inputs || {};
  const trace = body.trace || false;
  if (hasSourceInput && hasExplicitRunInputs(body.inputs)) {
    return c.json(sourceBackedInputsError(), 422);
  }

  if (wantsExecutionStream(c)) {
    const runId = crypto.randomUUID();
    if (!hasSourceInput && graph) {
      return streamExecutionEvents(
        runId,
        "run_to_node",
        streamRunToNode(runId, graph, nodeId, inputs, trace),
        nodeId,
      );
    }

    const sourceResult = await getRunRequestSource(body);
    if (!sourceResult.ok) {
      return c.json(sourceResult, 422);
    }
    return streamExecutionEvents(
      runId,
      "run_to_node",
      streamSourceRunToNode(
        runId,
        sourceResult.source,
        activeDocumentPath,
        nodeId,
        inputs,
        trace,
      ),
      nodeId,
    );
  }

  if (!hasSourceInput && graph) {
    const result = await runToNode(graph, nodeId, inputs, trace);
    return c.json(result);
  }

  const sourceResult = await getRunRequestSource(body);
  if (!sourceResult.ok) {
    return c.json(sourceResult, 422);
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
  const body = await c.req.json();
  const hasSourceInput = hasRunRequestSource(body) ||
    hasRunRequestDocument(body);
  let graph: Graph | null = null;

  if (!hasSourceInput) {
    const resolved = decodeAndValidateGraph(body.graph);
    if (!resolved.ok) {
      return c.json(
        resolved,
        422,
      );
    }
    graph = resolved.graph;
  }

  const inputs = body.inputs || {};
  const trace = body.trace || false;
  if (hasSourceInput && hasExplicitRunInputs(body.inputs)) {
    return c.json(sourceBackedInputsError(), 422);
  }

  if (wantsExecutionStream(c)) {
    const runId = crypto.randomUUID();
    if (!hasSourceInput && graph) {
      return streamExecutionEvents(
        runId,
        "run_graph",
        streamRunGraph(runId, graph, inputs, trace),
      );
    }

    const sourceResult = await getRunRequestSource(body);
    if (!sourceResult.ok) {
      return c.json(sourceResult, 422);
    }
    return streamExecutionEvents(
      runId,
      "run_graph",
      streamSourceRunGraph(
        runId,
        sourceResult.source,
        activeDocumentPath,
        inputs,
        trace,
      ),
    );
  }

  if (!hasSourceInput && graph) {
    const result = await runGraph(graph, inputs, trace);
    return c.json(result);
  }

  const sourceResult = await getRunRequestSource(body);
  if (!sourceResult.ok) {
    return c.json(sourceResult, 422);
  }
  const result = await runSourceGraph(
    sourceResult.source,
    activeDocumentPath,
    inputs,
    trace,
  );

  return c.json(result);
});

app.post("/runtime-session/clear-cache", async (c) => {
  await Promise.all([
    clearRuntimeSessionCache(),
    clearSourceRuntimeSessionCache(),
  ]);
  return c.json({ ok: true });
});

app.get("/assets/*", (c) => {
  const path = c.req.path.slice(1);
  return serveBuiltUiAsset(path);
});

app.get("*", () => serveBuiltUiIndex());

if (import.meta.main) {
  await startNodebookServer();
}
