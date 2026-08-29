import { assertEquals } from "@std/assert";
import { applyDocumentOperations } from "./documents.ts";

Deno.test("document operation request contains no automatic replay identifier", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body ?? "{}"));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          path: "/tmp/example.py",
          sourceRevision: "source-next",
          document: {
            version: 1,
            revision: "next",
            globalsCode: "",
            nodes: [],
            edges: [],
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    await applyDocumentOperations("base", [
      { type: "update_globals", code: "value = 1" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(requestBody, {
    baseRevision: "base",
    operations: [{ type: "update_globals", code: "value = 1" }],
  });
});
