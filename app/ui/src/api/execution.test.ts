import { assertEquals } from "@std/assert";
import {
  queryResultTable,
  runGraph,
  runToNode,
  TableQueryRequestError,
} from "./execution.ts";

Deno.test("runGraph sends optional source in the request body", async () => {
  const requests = await captureExecutionRequests(() =>
    runGraph({
      source: "from nodebook import node\n",
      expectedRevision: "displayed-revision",
      trace: true,
    })
  );

  assertEquals(requests.length, 1);
  assertEquals(requests[0].path, "/run-graph");
  assertEquals("graph" in requests[0].body, false);
  assertEquals("inputs" in requests[0].body, false);
  assertEquals(requests[0].body.source, "from nodebook import node\n");
  assertEquals(requests[0].body.expectedRevision, "displayed-revision");
  assertEquals(requests[0].body.trace, true);
});

Deno.test("runToNode sends optional source in the request body", async () => {
  const requests = await captureExecutionRequests(() =>
    runToNode({
      nodeId: "n",
      source: "from nodebook import node\n",
      expectedRevision: "displayed-revision",
    })
  );

  assertEquals(requests.length, 1);
  assertEquals(requests[0].path, "/run-to-node");
  assertEquals("graph" in requests[0].body, false);
  assertEquals("inputs" in requests[0].body, false);
  assertEquals(requests[0].body.nodeId, "n");
  assertEquals(requests[0].body.source, "from nodebook import node\n");
  assertEquals(requests[0].body.expectedRevision, "displayed-revision");
});

Deno.test("queryResultTable sends result provenance and table controls", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = ((_input, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}"));
    return Promise.resolve(Response.json({
      ok: true,
      ...requestBody,
      table: {
        columns: [],
        rows: [],
        rowCount: 0,
        columnCount: 0,
        truncated: false,
      },
    }));
  }) as typeof fetch;

  try {
    await queryResultTable({
      runId: "run-1",
      documentRevision: "revision-1",
      nodeId: "players",
      outputName: "table",
      offset: 50,
      sort: { kind: "column", columnIndex: 2, descending: true },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(requestBody, {
    runId: "run-1",
    documentRevision: "revision-1",
    nodeId: "players",
    outputName: "table",
    offset: 50,
    sort: { kind: "column", columnIndex: 2, descending: true },
  });
});

Deno.test("queryResultTable preserves structured query errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(Response.json({
      ok: false,
      error: { kind: "stale_result", message: "Run again." },
    }, { status: 409 }))) as typeof fetch;

  try {
    await queryResultTable({
      runId: "old-run",
      documentRevision: "old-revision",
      nodeId: "players",
      outputName: "table",
      offset: 0,
      sort: null,
    });
    throw new Error("Expected queryResultTable to reject");
  } catch (error) {
    assertEquals(error instanceof TableQueryRequestError, true);
    assertEquals((error as TableQueryRequestError).kind, "stale_result");
    assertEquals((error as Error).message, "Run again.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("queryResultTable explains non-JSON endpoint responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("<!doctype html><title>Nodebook</title>", {
        headers: { "Content-Type": "text/html" },
        status: 200,
      }),
    )) as typeof fetch;

  try {
    await queryResultTable({
      runId: "run-1",
      documentRevision: "revision-1",
      nodeId: "players",
      outputName: "table",
      offset: 0,
      sort: null,
    });
    throw new Error("Expected queryResultTable to reject");
  } catch (error) {
    assertEquals(error instanceof TableQueryRequestError, true);
    assertEquals((error as TableQueryRequestError).kind, "invalid_response");
    assertEquals(
      (error as Error).message,
      "The interactive table endpoint returned an invalid response (HTTP 200).",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function captureExecutionRequests(
  callback: () => Promise<unknown>,
): Promise<Array<{ path: string; body: Record<string, unknown> }>> {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      path: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    });

    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          runType: "run_graph",
          executedNodeIds: [],
          resultsByNode: {},
          finalOutputsByNode: {},
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      ),
    );
  }) as typeof fetch;

  try {
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }

  return requests;
}
