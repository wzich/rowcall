import { Hono } from "@hono/hono";
import { serveStatic } from "@hono/hono/deno";
import {
  assertNodeExists,
  buildDownstreamAdjacency,
  buildUpstreamAdjacency,
  decodeGraph,
  getNodeById,
  getSinkNodes,
  getSourceNodes,
  validateGraph,
} from "./graph.ts";
import { loadGraphFile } from "./utils.ts";
import type { ExecutionStreamEvent, Graph, ValidationIssue } from "./types.ts";
import { decodeNodebookDocument, type NodebookDocumentV1 } from "./document.ts";
import {
  runGraph,
  runSingleNode,
  runToNode,
  streamRunGraph,
  streamRunSingleNode,
  streamRunToNode,
} from "./executor.ts";

const app = new Hono();
const scratchDocumentPath = "examples/scratch.nodebook.json";

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
    })),
    edges: document.edges.map((edge) => ({
      fromNode: edge.fromNode,
      toNode: edge.toNode,
    })),
  };
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
  const sourceType = body.source.type;

  let graph: Graph = { nodes: [], edges: [] };

  if (sourceType === "path") {
    try {
      const rawGraph = await loadGraphFile(body.source.path);
      const resolved = decodeAndValidateGraph(rawGraph);
      if (!resolved.ok) {
        return c.json(
          resolved,
          422,
        );
      }

      graph = resolved.graph;
    } catch {
      return c.json(
        errorResponse({
          kind: "file_read_error",
          message: `Unable to read graph file: ${body.source.path}`,
        }),
        500,
      );
    }
  } else if (sourceType === "text") {
    try {
      const json = JSON.parse(body.source.text);
      const resolved = decodeAndValidateGraph(json);
      if (!resolved.ok) {
        return c.json(
          resolved,
          422,
        );
      }

      graph = resolved.graph;
    } catch {
      return c.json(
        errorResponse({
          kind: "invalid_json",
          message: "Unable to parse provided JSON text",
          issues: [{
            kind: "invalid_json",
            message: "Unable to parse provided JSON text",
          }],
        }),
        400,
      );
    }
  } else {
    return c.json(
      errorResponse({
        kind: "invalid_request",
        message: "Must provide graph with either path or text",
      }),
      400,
    );
  }

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

app.get("/documents/scratch", async (c) => {
  try {
    const text = await Deno.readTextFile(scratchDocumentPath);
    const json = JSON.parse(text);
    const decoded = decodeNodebookDocument(json);

    if (!decoded.ok) {
      return c.json(documentDecodeError(decoded.issues), 422);
    }

    return c.json({
      ok: true,
      document: decoded.document,
      path: scratchDocumentPath,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return c.json(
        errorResponse({
          kind: "invalid_json",
          message: "Unable to parse scratch Nodebook document",
          issues: [{
            kind: "invalid_json",
            message: "Unable to parse scratch Nodebook document",
          }],
        }),
        400,
      );
    }

    return c.json(
      errorResponse({
        kind: "file_read_error",
        message: `Unable to read Nodebook document: ${scratchDocumentPath}`,
      }),
      500,
    );
  }
});

app.put("/documents/scratch", async (c) => {
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
    await Deno.writeTextFile(
      scratchDocumentPath,
      `${JSON.stringify(formatDocument(decoded.document), null, 2)}\n`,
    );
  } catch (error) {
    console.error(
      `Failed to write Nodebook document at ${scratchDocumentPath}:`,
    );
    console.error(error);
    return c.json(
      errorResponse({
        kind: "document_write_error",
        message: `Unable to write Nodebook document: ${scratchDocumentPath}`,
      }),
      500,
    );
  }

  return c.json({
    ok: true,
    document: decoded.document,
    path: scratchDocumentPath,
  });
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

  const node = getNodeById(graph, nodeId);
  const inputs = body.inputs || {};

  // TODO: Add scoped API-level concurrency and resource controls once the
  // product has a runtime/session/document model. The UI keeps one active run
  // at a time for now, but direct API callers can still start concurrent runs.
  if (wantsExecutionStream(c)) {
    const runId = crypto.randomUUID();
    return streamExecutionEvents(
      runId,
      "run_node",
      streamRunSingleNode(runId, node, inputs, trace),
      node.id,
    );
  }

  const result = await runSingleNode(node, inputs, trace);
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

app.get("/", serveStatic({ path: "./static/index.html" }));
app.get("/index.js", serveStatic({ path: "./static/index.js" }));
app.get("/index.css", serveStatic({ path: "./static/index.css" }));

Deno.serve(app.fetch);
