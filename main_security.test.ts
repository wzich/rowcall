import { assertEquals, assertExists, assertNotEquals } from "@std/assert";
import {
  app,
  buildNodebookUrl,
  type NodebookServerSecurity,
  setActiveDocumentPathForTests,
  validateLocalRequest,
} from "./main.ts";
import {
  loadPythonDocument,
  setBeforeDocumentWriteForTests,
  sidecarPathForPythonDocument,
} from "./python_document.ts";

const security: NodebookServerSecurity = {
  hostname: "127.0.0.1",
  port: 8000,
  authToken: "secret-token",
};

Deno.test("buildNodebookUrl includes the server auth token", () => {
  assertEquals(
    buildNodebookUrl("127.0.0.1", 8000, "secret-token"),
    "http://127.0.0.1:8000/?token=secret-token",
  );
});

Deno.test("validateLocalRequest allows static UI requests without a token", () => {
  assertEquals(
    validateLocalRequest(request("/", { host: "127.0.0.1:8000" }), security),
    { ok: true },
  );
});

Deno.test("validateLocalRequest requires a token for API requests", () => {
  assertEquals(
    validateLocalRequest(
      request("/document", { host: "127.0.0.1:8000" }),
      security,
    ),
    {
      ok: false,
      status: 401,
      message: "Missing or invalid Nodebook authorization token.",
    },
  );
  assertEquals(
    validateLocalRequest(
      request("/document", {
        host: "127.0.0.1:8000",
        token: "secret-token",
      }),
      security,
    ),
    { ok: true },
  );
});

Deno.test("validateLocalRequest requires a token for document operations", () => {
  assertEquals(
    validateLocalRequest(
      request("/document/operations", {
        method: "POST",
        host: "127.0.0.1:8000",
      }),
      security,
    ),
    {
      ok: false,
      status: 401,
      message: "Missing or invalid Nodebook authorization token.",
    },
  );
  assertEquals(
    validateLocalRequest(
      request("/document/operations", {
        method: "POST",
        host: "127.0.0.1:8000",
        token: "secret-token",
      }),
      security,
    ),
    { ok: true },
  );
});

Deno.test("PUT /document is no longer a document write route", async () => {
  const response = await app.fetch(
    request("/document", {
      method: "PUT",
      host: "127.0.0.1:8000",
      token: "secret-token",
    }),
  );

  assertEquals(response.status === 404 || response.status === 405, true);
});

Deno.test("cache compatibility route explicitly reports caching disabled", async () => {
  const response = await app.fetch(
    request("/runtime-session/clear-cache", {
      method: "POST",
      host: "127.0.0.1:8000",
      token: "secret-token",
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    ok: true,
    clearedEntries: 0,
    cachingDisabled: true,
  });
});

Deno.test("GET /document/status returns document status revisions", async () => {
  const documentPath = await writeRouteTestDocument("status_success.py");
  setActiveDocumentPathForTests(documentPath);

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const response = await app.fetch(
    request("/document/status", {
      host: "127.0.0.1:8000",
      token: "secret-token",
    }),
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ok, true);
  assertEquals(body.status.path, documentPath);
  assertEquals(body.status.valid, true);
  assertEquals(body.status.revision, loaded.document.revision);
  assertExists(body.status.sourceRevision);
  assertExists(body.status.sidecarRevision);
  assertEquals(body.status.issues, []);
});

Deno.test("GET /document/status includes sidecar-only revision changes", async () => {
  const documentPath = await writeRouteTestDocument("status_sidecar.py");
  setActiveDocumentPathForTests(documentPath);

  const firstResponse = await app.fetch(
    request("/document/status", {
      host: "127.0.0.1:8000",
      token: "secret-token",
    }),
  );
  const first = await firstResponse.json();

  await Deno.writeTextFile(
    sidecarPathForPythonDocument(documentPath),
    `${
      JSON.stringify({
        version: 1,
        nodes: [{ id: "n_test", position: { x: 20, y: 30 } }],
      })
    }\n`,
  );

  const secondResponse = await app.fetch(
    request("/document/status", {
      host: "127.0.0.1:8000",
      token: "secret-token",
    }),
  );
  const second = await secondResponse.json();

  assertEquals(second.status.valid, true);
  assertEquals(second.status.sourceRevision, first.status.sourceRevision);
  assertNotEquals(second.status.sidecarRevision, first.status.sidecarRevision);
  assertNotEquals(second.status.revision, first.status.revision);
});

Deno.test("GET /document/status reports invalid external Python without a 422", async () => {
  const documentPath = await writeRouteTestDocument("status_invalid.py");
  setActiveDocumentPathForTests(documentPath);

  await Deno.writeTextFile(documentPath, "def broken(:\n");

  const response = await app.fetch(
    request("/document/status", {
      host: "127.0.0.1:8000",
      token: "secret-token",
    }),
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ok, true);
  assertEquals(body.status.valid, false);
  assertEquals(body.status.revision, undefined);
  assertExists(body.status.sourceRevision);
  assertEquals(body.status.issues[0].kind, "invalid_python");
});

Deno.test("run requests reject a document revision changed after UI freshness", async () => {
  const documentPath = await writeRouteTestDocument("run_stale.py");
  setActiveDocumentPathForTests(documentPath);
  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load stale run route test document.");
  }

  await Deno.writeTextFile(
    documentPath,
    (await Deno.readTextFile(documentPath)).replace("x = 1", "x = 2"),
  );
  const response = await app.fetch(
    jsonRequest("/run-to-node", {
      nodeId: "n_test",
      expectedRevision: loaded.document.revision,
    }),
  );

  assertEquals(response.status, 409);
  const body = await response.json();
  assertEquals(body.ok, false);
  assertEquals(body.error.kind, "stale_document");
});

Deno.test("disk-backed run requests require an expected revision", async () => {
  const documentPath = await writeRouteTestDocument("run_unbound.py");
  setActiveDocumentPathForTests(documentPath);

  const response = await app.fetch(
    jsonRequest("/run-graph", {}),
  );

  assertEquals(response.status, 422);
  const body = await response.json();
  assertEquals(body.ok, false);
  assertEquals(body.error.kind, "invalid_request");
});

Deno.test("POST /document/operations applies operations", async () => {
  const documentPath = await writeRouteTestDocument("operations_success.py");
  setActiveDocumentPathForTests(documentPath);

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }
  assertExists(loaded.document.revision);

  const response = await app.fetch(
    jsonRequest("/document/operations", {
      baseRevision: loaded.document.revision,
      operations: [
        {
          type: "update_node_body",
          nodeId: "n_test",
          code: "x = 2",
        },
        {
          type: "move_node",
          nodeId: "n_test",
          position: { x: 12, y: 34 },
        },
      ],
    }),
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ok, true);
  assertEquals(body.path, documentPath);
  assertEquals(body.document.nodes[0].id, "n_test");
  assertEquals(body.document.nodes[0].code, "x = 2");
  assertEquals(body.document.nodes[0].position, { x: 12, y: 34 });
  assertExists(body.document.revision);

  assertEquals(
    await Deno.readTextFile(documentPath),
    [
      "from nodebook import node",
      "",
      '@node(id="n_test", outputs=["x"])',
      "def make_x():",
      "    x = 2",
      '    return {"x": x}',
      "",
    ].join("\n"),
  );
  const sidecar = JSON.parse(
    await Deno.readTextFile(sidecarPathForPythonDocument(documentPath)),
  );
  assertEquals(sidecar.nodes[0].position, { x: 12, y: 34 });
});

Deno.test("document reads wait for an already-enqueued save outcome", async () => {
  const documentPath = await writeRouteTestDocument(
    "operations_read_barrier.py",
  );
  setActiveDocumentPathForTests(documentPath);
  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load document read barrier test document.");
  }

  // Prime status so an unbarriered status request would return the old cached
  // snapshot promptly while the save is paused before acquiring its file lock.
  const primedStatus = await app.fetch(
    request("/document/status", {
      host: "127.0.0.1:8000",
      token: "secret-token",
    }),
  );
  assertEquals(primedStatus.status, 200);

  let enteredWrite!: () => void;
  const writeWasEntered = new Promise<void>((resolve) => {
    enteredWrite = resolve;
  });
  let releaseWrite!: () => void;
  const writeMayContinue = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  setBeforeDocumentWriteForTests(() => {
    enteredWrite();
    return writeMayContinue;
  });

  try {
    const savePromise = app.fetch(
      jsonRequest("/document/operations", {
        baseRevision: loaded.document.revision,
        operations: [{
          type: "update_node_body",
          nodeId: "n_test",
          code: "x = 2",
        }],
      }),
    );
    await writeWasEntered;

    let documentReadSettled = false;
    let statusReadSettled = false;
    const documentReadPromise = Promise.resolve(app.fetch(
      request("/document", {
        host: "127.0.0.1:8000",
        token: "secret-token",
      }),
    )).then((response) => {
      documentReadSettled = true;
      return response;
    });
    const statusReadPromise = Promise.resolve(app.fetch(
      request("/document/status", {
        host: "127.0.0.1:8000",
        token: "secret-token",
      }),
    )).then((response) => {
      statusReadSettled = true;
      return response;
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    assertEquals(documentReadSettled, false);
    assertEquals(statusReadSettled, false);

    releaseWrite();
    const [saveResponse, documentResponse, statusResponse] = await Promise.all([
      savePromise,
      documentReadPromise,
      statusReadPromise,
    ]);
    assertEquals(saveResponse.status, 200);
    assertEquals(documentResponse.status, 200);
    assertEquals(statusResponse.status, 200);

    const saved = await saveResponse.json();
    const read = await documentResponse.json();
    const status = await statusResponse.json();
    assertEquals(saved.document.nodes[0].code, "x = 2");
    assertEquals(read.document.nodes[0].code, "x = 2");
    assertEquals(read.document.revision, saved.document.revision);
    assertEquals(status.status.revision, saved.document.revision);
  } finally {
    releaseWrite?.();
    setBeforeDocumentWriteForTests(null);
  }
});

Deno.test("POST /document/operations maps stale base revisions to 409", async () => {
  const documentPath = await writeRouteTestDocument("operations_stale.py");
  setActiveDocumentPathForTests(documentPath);

  const response = await app.fetch(
    jsonRequest("/document/operations", {
      baseRevision: "stale-revision",
      operations: [
        {
          type: "update_node_body",
          nodeId: "n_test",
          code: "x = 2",
        },
      ],
    }),
  );

  assertEquals(response.status, 409);
  const body = await response.json();
  assertEquals(body.ok, false);
  assertEquals(body.error.kind, "stale_document");
  assertEquals(body.error.issues[0].kind, "stale_document");
});

Deno.test("POST /document/operations returns validation issues for invalid operations", async () => {
  const documentPath = await writeRouteTestDocument("operations_invalid.py");
  setActiveDocumentPathForTests(documentPath);

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }
  assertExists(loaded.document.revision);

  const response = await app.fetch(
    jsonRequest("/document/operations", {
      baseRevision: loaded.document.revision,
      operations: [{ type: "update_node_body", nodeId: "n_test" }],
    }),
  );

  assertEquals(response.status, 422);
  const body = await response.json();
  assertEquals(body.ok, false);
  assertEquals(body.error.kind, "document_decode_error");
  assertEquals(body.error.issues[0].path, "operations[0].code");
});

Deno.test("HTTP run routes reject graph-only payloads", async () => {
  const graph = {
    nodes: [{ id: "n_test", code: "x = 1", outputs: ["x"] }],
    edges: [],
  };

  for (const route of ["/run-node", "/run-to-node", "/run-graph"]) {
    const response = await app.fetch(
      jsonRequest(route, {
        graph,
        ...(route === "/run-graph" ? {} : { nodeId: "n_test" }),
      }),
    );

    assertEquals(response.status, 422);
    const body = await response.json();
    assertEquals(body.ok, false);
    assertEquals(body.error.kind, "invalid_request");
    assertEquals(
      body.error.message,
      "Run routes are source-backed and do not accept graph payloads. Save document operations before running the active document.",
    );
  }
});

Deno.test("validateLocalRequest accepts token query params for non-browser agents", () => {
  assertEquals(
    validateLocalRequest(
      request("/runtime/python?token=secret-token", {
        host: "localhost:8000",
      }),
      security,
    ),
    { ok: true },
  );
});

Deno.test("validateLocalRequest rejects unexpected Host and Origin headers", () => {
  assertEquals(
    statusOf(
      validateLocalRequest(
        request("/document", {
          host: "attacker.example:8000",
          token: "secret-token",
        }),
        security,
      ),
    ),
    403,
  );
  assertEquals(
    statusOf(
      validateLocalRequest(
        request("/document", {
          host: "127.0.0.1:8000",
          origin: "https://attacker.example",
          token: "secret-token",
        }),
        security,
      ),
    ),
    403,
  );
});

Deno.test("validateLocalRequest allows loopback dev-server origins", () => {
  assertEquals(
    validateLocalRequest(
      request("/run-graph", {
        method: "POST",
        host: "localhost:8000",
        origin: "http://127.0.0.1:5173",
        token: "secret-token",
      }),
      security,
    ),
    { ok: true },
  );
});

function statusOf(
  result: ReturnType<typeof validateLocalRequest>,
): number | null {
  return result.ok ? null : result.status;
}

function request(
  path: string,
  options: {
    method?: string;
    host: string;
    origin?: string;
    token?: string;
  },
): Request {
  const headers = new Headers({ host: options.host });
  if (options.origin) headers.set("origin", options.origin);
  if (options.token) headers.set("x-nodebook-token", options.token);
  return new Request(`http://${options.host}${path}`, {
    method: options.method ?? "GET",
    headers,
  });
}

function jsonRequest(path: string, body: unknown): Request {
  const headers = new Headers({
    host: "127.0.0.1:8000",
    "content-type": "application/json",
    "x-nodebook-token": "secret-token",
  });
  return new Request(`http://127.0.0.1:8000${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function writeRouteTestDocument(filename: string): Promise<string> {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/${filename}`;
  await Deno.writeTextFile(
    documentPath,
    [
      "from nodebook import node",
      "",
      '@node(id="n_test", outputs=["x"])',
      "def make_x():",
      "    x = 1",
      '    return {"x": x}',
      "",
    ].join("\n"),
  );
  return documentPath;
}
