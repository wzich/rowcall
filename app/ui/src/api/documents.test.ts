import { assertEquals } from "@std/assert";
import { applyDocumentOperations, importDocumentFile } from "./documents.ts";

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

Deno.test("file imports send raw bytes and preserve the filename", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestInit: RequestInit | undefined;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    requestInit = init;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          file: {
            originalName: "Customer Orders.csv",
            storedName: "Customer Orders.csv",
            relativePath: "data/Customer Orders.csv",
            size: 8,
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  const file = new File(["a,b\n1,2\n"], "Customer Orders.csv", {
    type: "text/csv",
  });
  try {
    assertEquals(await importDocumentFile(file), {
      originalName: "Customer Orders.csv",
      storedName: "Customer Orders.csv",
      relativePath: "data/Customer Orders.csv",
      size: 8,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(
    requestedUrl,
    "/document/files?name=Customer+Orders.csv",
  );
  assertEquals(requestInit?.method, "POST");
  assertEquals(requestInit?.body, file);
  assertEquals(requestInit?.headers, {
    "Content-Type": "application/octet-stream",
  });
});
