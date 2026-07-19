import { assertEquals } from "@std/assert";
import { runGraph, runToNode } from "./execution.ts";

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
