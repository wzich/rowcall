import { assertEquals, assertExists } from "@std/assert";
import {
  applyPythonDocumentOperations,
  loadPythonDocument,
  sidecarPathForPythonDocument,
} from "./python_document.ts";
import {
  clearSourceRuntimeSessionCache,
  runSourceGraph,
  runSourceSingleNode,
  runSourceToNode,
  shutdownSourceRuntimeSession,
} from "./executor.ts";

Deno.test("loadPythonDocument decodes function-shaped node document", async () => {
  const decoded = await loadPythonDocument("examples/hello_world.py");

  if (!decoded.ok) {
    throw new Error(decoded.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(decoded.document.readOnly, false);
  assertEquals(decoded.document.nodes.map((node) => node.id), [
    "n_load",
    "n_shout",
  ]);
  assertEquals(decoded.document.nodes.map((node) => node.functionName), [
    "read_message",
    "shout_message",
  ]);
  assertEquals(decoded.document.edges, [
    { fromNode: "n_load", toNode: "n_shout" },
  ]);
  assertEquals(
    decoded.document.nodes[1].code,
    [
      'message = message.upper() + "!"',
    ].join("\n"),
  );
  assertExists(decoded.document.nodes[1].runtimeCode);
});

Deno.test("Python document source executes through worker runtime", async () => {
  const path = "examples/hello_world.py";
  const source = await Deno.readTextFile(path);

  await clearSourceRuntimeSessionCache();
  try {
    const response = await runSourceGraph(source, path);
    assertEquals(response.ok, true);
    assertEquals(
      response.finalOutputsByNode.n_shout.message.jsonValue,
      "HELLO!",
    );
  } finally {
    await shutdownSourceRuntimeSession();
  }
});

Deno.test("Python document source-backed single node reuses source-backed cache", async () => {
  const path = "examples/hello_world.py";
  const source = await Deno.readTextFile(path);

  await clearSourceRuntimeSessionCache();
  try {
    const seed = await runSourceToNode(source, path, "n_shout");
    const single = await runSourceSingleNode(source, path, "n_shout");

    assertEquals(seed.ok, true);
    assertEquals(single.ok, true);
    assertEquals(single.executedNodeIds, ["n_shout"]);
    assertEquals(
      single.finalOutputsByNode.n_shout.message.jsonValue,
      "HELLO!",
    );
  } finally {
    await shutdownSourceRuntimeSession();
  }
});

Deno.test("edited Python document nodes execute with document globals", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/globals.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "GLOBAL_OFFSET = 2",
      "",
      "from nodebook import node",
      "",
      '@node(id="n_load", outputs=["x"])',
      "def load_x():",
      "    x = 1",
      '    return {"x": x}',
      "",
      '@node(id="n_add", outputs=["y"])',
      "def add_offset(x):",
      "    y = x + GLOBAL_OFFSET",
      '    return {"y": y}',
      "",
      "add_offset.depends_on(load_x)",
      "",
    ].join("\n"),
  );

  const decoded = await loadPythonDocument(documentPath);
  if (!decoded.ok) {
    throw new Error(decoded.issues.map((issue) => issue.message).join("; "));
  }

  const edited = await applyPythonDocumentOperations(
    documentPath,
    decoded.document.revision ?? "",
    [{
      type: "update_node_body",
      nodeId: "n_add",
      code: "y = x + GLOBAL_OFFSET + 1",
    }],
  );
  if (!edited.ok) {
    throw new Error(edited.issues.map((issue) => issue.message).join("; "));
  }
  const editedSource = await Deno.readTextFile(documentPath);

  await clearSourceRuntimeSessionCache();
  try {
    const response = await runSourceGraph(editedSource, documentPath);
    assertEquals(response.ok, true);
    assertEquals(response.finalOutputsByNode.n_add.y.jsonValue, 4);
  } finally {
    await shutdownSourceRuntimeSession();
  }
});

Deno.test("Python document runtime inputs follow direct upstream outputs", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/renamed_input.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from nodebook import node",
      "",
      '@node(id="n_load", outputs=["trips"])',
      "def load_trips():",
      "    trips = 1",
      '    return {"trips": trips}',
      "",
      '@node(id="n_prepare", outputs=["prepared"])',
      "def prepare_trips(trips):",
      "    prepared = trips + 1",
      '    return {"prepared": prepared}',
      "",
      "# NodeBook graph",
      "prepare_trips.depends_on(load_trips)",
      "",
    ].join("\n"),
  );

  const source = await Deno.readTextFile(documentPath);

  await clearSourceRuntimeSessionCache();
  try {
    const response = await runSourceGraph(source, documentPath);
    assertEquals(response.ok, true);
    assertEquals(response.finalOutputsByNode.n_prepare.prepared.jsonValue, 2);
  } finally {
    await shutdownSourceRuntimeSession();
  }
});

Deno.test("loadPythonDocument applies optional sidecar node metadata", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/analysis.py`;
  const sidecarPath = sidecarPathForPythonDocument(documentPath);

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
  await Deno.writeTextFile(
    sidecarPath,
    JSON.stringify({
      version: 1,
      nodes: [{
        id: "n_test",
        position: { x: 100, y: 200 },
        title: "Make X",
        description: "Create the first value.",
      }],
    }),
  );

  const decoded = await loadPythonDocument(documentPath);
  if (!decoded.ok) {
    throw new Error(decoded.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(decoded.document.nodes[0].position, { x: 100, y: 200 });
  assertEquals(decoded.document.nodes[0].title, "Make X");
  assertEquals(
    decoded.document.nodes[0].description,
    "Create the first value.",
  );
});

Deno.test("loadPythonDocument applies map-shaped sidecar node metadata", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/analysis.py`;
  const sidecarPath = sidecarPathForPythonDocument(documentPath);

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
  await Deno.writeTextFile(
    sidecarPath,
    JSON.stringify({
      version: 1,
      nodes: {
        n_test: {
          position: { x: 100, y: 200 },
          title: "Make X",
          description: "Create the first value.",
        },
      },
    }),
  );

  const decoded = await loadPythonDocument(documentPath);
  if (!decoded.ok) {
    throw new Error(decoded.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(decoded.document.nodes[0].position, { x: 100, y: 200 });
  assertEquals(decoded.document.nodes[0].title, "Make X");
  assertEquals(
    decoded.document.nodes[0].description,
    "Create the first value.",
  );
});

Deno.test("loadPythonDocument preserves custom return nodes", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/custom.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from nodebook import node",
      "",
      '@node(id="n_custom", outputs=["x"])',
      "def make_x():",
      "    if True:",
      '        return {"x": 1}',
      '    return {"x": 0}',
      "",
    ].join("\n"),
  );

  const decoded = await loadPythonDocument(documentPath);
  if (!decoded.ok) {
    throw new Error(decoded.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(decoded.document.nodes[0].customReturn, true);
  assertEquals(
    decoded.document.nodes[0].code,
    [
      "if True:",
      '    return {"x": 1}',
      'return {"x": 0}',
    ].join("\n"),
  );
});

Deno.test("loadPythonDocument rejects direct node-to-node calls", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/direct_call.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from nodebook import node",
      "",
      '@node(id="n_a", outputs=["x"])',
      "def make_x():",
      '    return {"x": 1}',
      "",
      '@node(id="n_b", outputs=["y"])',
      "def make_y():",
      "    result = make_x()",
      '    return {"y": result["x"]}',
      "",
    ].join("\n"),
  );

  const decoded = await loadPythonDocument(documentPath);

  assertEquals(decoded.ok, false);
  if (!decoded.ok) {
    assertEquals(decoded.issues[0].kind, "unsupported_python");
  }
});

Deno.test("applyPythonDocumentOperations rejects stale document revisions", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/stale_operations.py`;
  const originalSource = [
    "from nodebook import node",
    "",
    '@node(id="n_test", outputs=["x"])',
    "def make_x():",
    "    x = 1",
    '    return {"x": x}',
    "",
  ].join("\n");

  await Deno.writeTextFile(documentPath, originalSource);

  const applied = await applyPythonDocumentOperations(
    documentPath,
    "not-the-current-revision",
    [{ type: "update_node_body", nodeId: "n_test", code: "x = 2" }],
  );

  assertEquals(applied.ok, false);
  if (!applied.ok) {
    assertEquals(applied.issues[0].kind, "stale_document");
  }
  assertEquals(await Deno.readTextFile(documentPath), originalSource);
});

Deno.test("applyPythonDocumentOperations rejects stale sidecar revisions", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/stale_sidecar.py`;
  const sidecarPath = sidecarPathForPythonDocument(documentPath);

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

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load operation test document.");
  }

  await Deno.writeTextFile(
    sidecarPath,
    JSON.stringify({
      version: 1,
      nodes: [{ id: "n_test", position: { x: 1, y: 2 } }],
    }),
  );

  const applied = await applyPythonDocumentOperations(
    documentPath,
    loaded.document.revision,
    [{
      type: "move_node",
      nodeId: "n_test",
      position: { x: 30, y: 40 },
    }],
  );

  assertEquals(applied.ok, false);
  if (!applied.ok) {
    assertEquals(applied.issues[0].kind, "stale_document");
  }
});

Deno.test("applyPythonDocumentOperations updates a standard node body", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/body_operation.py`;

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

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load operation test document.");
  }

  const applied = await applyPythonDocumentOperations(
    documentPath,
    loaded.document.revision,
    [{ type: "update_node_body", nodeId: "n_test", code: "x = 2\nprint(x)" }],
  );
  if (!applied.ok) {
    throw new Error(applied.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(
    await Deno.readTextFile(documentPath),
    [
      "from nodebook import node",
      "",
      '@node(id="n_test", outputs=["x"])',
      "def make_x():",
      "    x = 2",
      "    print(x)",
      '    return {"x": x}',
      "",
    ].join("\n"),
  );
  assertEquals(applied.document.nodes[0].code, "x = 2\nprint(x)");
});

Deno.test("applyPythonDocumentOperations removes deleted node incident edges", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/delete_operation.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from nodebook import node",
      "",
      '@node(id="n_a", outputs=["x"])',
      "def make_x():",
      "    x = 1",
      '    return {"x": x}',
      "",
      '@node(id="n_b", outputs=["y"])',
      "def make_y(x):",
      "    y = x + 1",
      '    return {"y": y}',
      "",
      "# NodeBook graph",
      "make_y.depends_on(make_x)",
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load operation test document.");
  }

  const applied = await applyPythonDocumentOperations(
    documentPath,
    loaded.document.revision,
    [{ type: "delete_node", nodeId: "n_b" }],
  );
  if (!applied.ok) {
    throw new Error(applied.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(applied.document.nodes.map((node) => node.id), ["n_a"]);
  assertEquals(applied.document.edges, []);
});

Deno.test("applyPythonDocumentOperations appends added Python node blocks", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/add_node_operation.py`;

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

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load operation test document.");
  }

  const applied = await applyPythonDocumentOperations(
    documentPath,
    loaded.document.revision,
    [{
      type: "add_node",
      node: {
        id: "n_new",
        functionName: "new_step",
        code: "value = 2",
        outputs: ["value"],
        position: { x: 10, y: 20 },
      },
    }],
  );
  if (!applied.ok) {
    throw new Error(applied.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(applied.document.nodes.map((node) => node.id), [
    "n_test",
    "n_new",
  ]);
  assertEquals(applied.document.nodes[1].position, { x: 10, y: 20 });
  assertEquals(
    await Deno.readTextFile(documentPath),
    [
      "from nodebook import node",
      "",
      '@node(id="n_test", outputs=["x"])',
      "def make_x():",
      "    x = 1",
      '    return {"x": x}',
      "",
      '@node(id="n_new", outputs=["value"])',
      "def new_step():",
      "    value = 2",
      '    return {"value": value}',
      "",
    ].join("\n"),
  );
});

Deno.test("applyPythonDocumentOperations writes sidecar metadata", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/sidecar_operation.py`;

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

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load operation test document.");
  }

  const applied = await applyPythonDocumentOperations(
    documentPath,
    loaded.document.revision,
    [
      {
        type: "move_node",
        nodeId: "n_test",
        position: { x: 30, y: 40 },
      },
      { type: "update_node_title", nodeId: "n_test", title: "Make X" },
      {
        type: "update_node_description",
        nodeId: "n_test",
        description: "Create a value.",
      },
    ],
  );
  if (!applied.ok) {
    throw new Error(applied.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(applied.document.nodes[0].position, { x: 30, y: 40 });
  assertEquals(applied.document.nodes[0].title, "Make X");
  assertEquals(applied.document.nodes[0].description, "Create a value.");

  const sidecar = JSON.parse(
    await Deno.readTextFile(sidecarPathForPythonDocument(documentPath)),
  );
  assertEquals(sidecar, {
    version: 1,
    nodes: [{
      id: "n_test",
      position: { x: 30, y: 40 },
      title: "Make X",
      description: "Create a value.",
    }],
  });
});

Deno.test("applyPythonDocumentOperations preserves source file mode", async () => {
  if (Deno.build.os === "windows") {
    return;
  }

  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/mode_operation.py`;

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
  await Deno.chmod(documentPath, 0o744);

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load operation test document.");
  }

  const applied = await applyPythonDocumentOperations(
    documentPath,
    loaded.document.revision,
    [{ type: "update_node_body", nodeId: "n_test", code: "x = 2" }],
  );
  if (!applied.ok) {
    throw new Error(applied.issues.map((issue) => issue.message).join("; "));
  }

  const mode = (await Deno.stat(documentPath)).mode;
  assertEquals(typeof mode === "number" ? mode & 0o777 : mode, 0o744);
});
