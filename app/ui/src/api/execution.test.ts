import { assertEquals } from "@std/assert";
import type { NodebookDocumentV1 } from "../../../../document.ts";
import type { Graph } from "../../../../types.ts";
import { runGraph, runNode, runToNode } from "./execution.ts";

const graph: Graph = {
  nodes: [{ id: "n", code: "value = 1", outputs: ["value"] }],
  edges: [],
};
const document: NodebookDocumentV1 = {
  version: 1,
  nodes: [{
    id: "n",
    code: "value = 1",
    outputs: ["value"],
    functionName: "make_value",
    parameters: [],
  }],
  edges: [],
};

Deno.test("runGraph sends optional source in the request body", async () => {
  const requests = await captureExecutionRequests(() =>
    runGraph({
      graph,
      source: "from nodebook import node\n",
      trace: true,
    })
  );

  assertEquals(requests.length, 1);
  assertEquals(requests[0].path, "/run-graph");
  assertEquals(requests[0].body.source, "from nodebook import node\n");
  assertEquals(requests[0].body.trace, true);
});

Deno.test("runGraph sends optional document in the request body", async () => {
  const requests = await captureExecutionRequests(() =>
    runGraph({
      graph,
      document,
    })
  );

  assertEquals(requests.length, 1);
  assertEquals(requests[0].path, "/run-graph");
  assertEquals(requests[0].body.document, document);
});

Deno.test("runToNode sends optional source in the request body", async () => {
  const requests = await captureExecutionRequests(() =>
    runToNode({
      graph,
      nodeId: "n",
      source: "from nodebook import node\n",
    })
  );

  assertEquals(requests.length, 1);
  assertEquals(requests[0].path, "/run-to-node");
  assertEquals(requests[0].body.nodeId, "n");
  assertEquals(requests[0].body.source, "from nodebook import node\n");
});

Deno.test("runToNode sends optional document in the request body", async () => {
  const requests = await captureExecutionRequests(() =>
    runToNode({
      graph,
      nodeId: "n",
      document,
    })
  );

  assertEquals(requests.length, 1);
  assertEquals(requests[0].path, "/run-to-node");
  assertEquals(requests[0].body.document, document);
});

Deno.test("runNode sends optional source in the request body", async () => {
  const requests = await captureExecutionRequests(() =>
    runNode({
      graph,
      nodeId: "n",
      source: "from nodebook import node\n",
    })
  );

  assertEquals(requests.length, 1);
  assertEquals(requests[0].path, "/run-node");
  assertEquals(requests[0].body.source, "from nodebook import node\n");
});

Deno.test("runNode sends optional document in the request body", async () => {
  const requests = await captureExecutionRequests(() =>
    runNode({
      graph,
      nodeId: "n",
      document,
    })
  );

  assertEquals(requests.length, 1);
  assertEquals(requests[0].path, "/run-node");
  assertEquals(requests[0].body.document, document);
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
