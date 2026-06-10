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
import { loadPythonDocument, savePythonDocument } from "./python_document.ts";
import {
  clearRuntimeSessionCache,
  getPythonEnvironmentInfo,
  runGraph,
  runSingleNode,
  runToNode,
  streamRunGraph,
  streamRunSingleNode,
  streamRunToNode,
} from "./executor.ts";

const app = new Hono();
const defaultDocumentPath = "examples/hello_world.py";
const uiDistPath = "app/ui/dist";
const activeDocumentPath = getActiveDocumentPath(Deno.args);
await ensureActiveDocumentExists(activeDocumentPath);

app.use("*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Accept");
});

app.options("*", (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Accept");
  return c.body(null, 204);
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

function getActiveDocumentPath(args: string[]): string {
  const documentFlagIndex = args.findIndex((arg) => arg === "--document");
  if (documentFlagIndex >= 0 && args[documentFlagIndex + 1] === undefined) {
    console.error("Missing path after --document");
    Deno.exit(1);
  }

  const path = documentFlagIndex >= 0
    ? args[documentFlagIndex + 1]
    : args.find((arg) => !arg.startsWith("-"));

  const documentPath = path ?? defaultDocumentPath;
  if (!documentPath.endsWith(".py")) {
    console.error("Nodebook document path must end with .py");
    Deno.exit(1);
  }

  return documentPath;
}

async function ensureActiveDocumentExists(path: string): Promise<void> {
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

    console.error(`Nodebook Python document does not exist: ${path}`);
    Deno.exit(1);
  }
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
    const file = await Deno.readFile(`${uiDistPath}/${path}`);
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
    const file = await Deno.readFile(`${uiDistPath}/index.html`);
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
  } catch (error) {
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

  const resolved = decodeAndValidateGraph(body.graph);
  if (!resolved.ok) {
    return c.json(
      resolved,
      422,
    );
  }
  const graph = resolved.graph;
  const nodeId = body.nodeId;
  const trace = body.trace;

  try {
    assertNodeExists(graph, nodeId);
  } catch {
    return c.json(nodeNotFoundError(nodeId), 422);
  }

  const inputs = body.inputs || {};

  // TODO: Add scoped API-level concurrency and resource controls once the
  // product has a runtime/session/document model. The UI keeps one active run
  // at a time for now, but direct API callers can still start concurrent runs.
  if (wantsExecutionStream(c)) {
    const runId = crypto.randomUUID();
    return streamExecutionEvents(
      runId,
      "run_node",
      streamRunSingleNode(runId, graph, nodeId, inputs, trace),
      nodeId,
    );
  }

  const result = await runSingleNode(graph, nodeId, inputs, trace);
  return c.json(result);
});

app.post("/run-to-node", async (c) => {
  const body = await c.req.json();

  const resolved = decodeAndValidateGraph(body.graph);
  if (!resolved.ok) {
    return c.json(
      resolved,
      422,
    );
  }
  const graph = resolved.graph;
  const nodeId = body.nodeId;

  try {
    assertNodeExists(graph, nodeId);
  } catch {
    return c.json(nodeNotFoundError(nodeId), 422);
  }

  const inputs = body.inputs || {};
  const trace = body.trace || false;

  if (wantsExecutionStream(c)) {
    const runId = crypto.randomUUID();
    return streamExecutionEvents(
      runId,
      "run_to_node",
      streamRunToNode(runId, graph, nodeId, inputs, trace),
      nodeId,
    );
  }

  const result = await runToNode(graph, nodeId, inputs, trace);

  return c.json(result);
});

app.post("/run-graph", async (c) => {
  const body = await c.req.json();

  const resolved = decodeAndValidateGraph(body.graph);
  if (!resolved.ok) {
    return c.json(
      resolved,
      422,
    );
  }

  const graph = resolved.graph;

  const inputs = body.inputs || {};
  const trace = body.trace || false;

  if (wantsExecutionStream(c)) {
    const runId = crypto.randomUUID();
    return streamExecutionEvents(
      runId,
      "run_graph",
      streamRunGraph(runId, graph, inputs, trace),
    );
  }

  const result = await runGraph(graph, inputs, trace);

  return c.json(result);
});

app.post("/runtime-session/clear-cache", async (c) => {
  await clearRuntimeSessionCache();
  return c.json({ ok: true });
});

app.get("/assets/*", (c) => {
  const path = c.req.path.slice(1);
  return serveBuiltUiAsset(path);
});

app.get("*", () => serveBuiltUiIndex());

Deno.serve(app.fetch);
