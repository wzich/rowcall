import { assertEquals, assertExists } from "@std/assert";
import {
  loadPythonDocument,
  renderPythonDocumentSource,
  savePythonDocument,
  sidecarPathForPythonDocument,
} from "./python_document.ts";
import { toRuntimeGraph } from "./document.ts";
import {
  clearRuntimeSessionCache,
  runGraph,
  runSourceSingleNode,
  runSourceToNode,
  shutdownRuntimeSession,
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

Deno.test("Python document runtime code executes through worker runtime", async () => {
  const decoded = await loadPythonDocument("examples/hello_world.py");
  if (!decoded.ok) {
    throw new Error(decoded.issues.map((issue) => issue.message).join("; "));
  }

  await clearRuntimeSessionCache();
  try {
    const response = await runGraph(toRuntimeGraph(decoded.document));
    assertEquals(response.ok, true);
    assertEquals(
      response.finalOutputsByNode.n_shout.message.jsonValue,
      "HELLO!",
    );
  } finally {
    await shutdownRuntimeSession();
  }
});

Deno.test("Python document source-backed single node reuses source-backed cache", async () => {
  const path = "examples/hello_world.py";
  const source = await Deno.readTextFile(path);

  await clearRuntimeSessionCache();
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
    await shutdownRuntimeSession();
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

  const editedDocument = {
    ...decoded.document,
    nodes: decoded.document.nodes.map((node) =>
      node.id === "n_add"
        ? {
          ...node,
          code: "y = x + GLOBAL_OFFSET + 1",
          runtimeCode: undefined,
        }
        : node
    ),
  };

  await clearRuntimeSessionCache();
  try {
    const response = await runGraph(toRuntimeGraph(editedDocument));
    assertEquals(response.ok, true);
    assertEquals(response.finalOutputsByNode.n_add.y.jsonValue, 4);
  } finally {
    await shutdownRuntimeSession();
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

  const decoded = await loadPythonDocument(documentPath);
  if (!decoded.ok) {
    throw new Error(decoded.issues.map((issue) => issue.message).join("; "));
  }

  await clearRuntimeSessionCache();
  try {
    const response = await runGraph(toRuntimeGraph(decoded.document));
    assertEquals(response.ok, true);
    assertEquals(response.finalOutputsByNode.n_prepare.prepared.jsonValue, 2);
  } finally {
    await shutdownRuntimeSession();
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
  assertEquals(decoded.document.nodes[0].title, undefined);
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

Deno.test("renderPythonDocumentSource preserves literal return-only nodes", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/literal_return.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from nodebook import node",
      "",
      '@node(id="n_literal", outputs=["x"])',
      "def make_x():",
      '    return {"x": 1}',
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(loaded.document.nodes[0].customReturn, true);
  assertEquals(loaded.document.nodes[0].editable, false);

  const rendered = await renderPythonDocumentSource(
    documentPath,
    loaded.document,
  );
  if (!rendered.ok) {
    throw new Error(rendered.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(rendered.source, await Deno.readTextFile(documentPath));
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

Deno.test("savePythonDocument rewrites standard node body and sidecar metadata", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/editable.py`;

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
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const nextDocument = {
    ...loaded.document,
    nodes: loaded.document.nodes.map((node) =>
      node.id === "n_test"
        ? {
          ...node,
          code: "x = 2\nprint(x)",
          position: { x: 10, y: 20 },
          description: "Print and return the updated value.",
        }
        : node
    ),
  };

  const saved = await savePythonDocument(documentPath, nextDocument);
  if (!saved.ok) {
    throw new Error(saved.issues.map((issue) => issue.message).join("; "));
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
  assertEquals(saved.document.nodes[0].code, "x = 2\nprint(x)");
  assertEquals(saved.document.nodes[0].position, { x: 10, y: 20 });
  assertEquals(
    saved.document.nodes[0].description,
    "Print and return the updated value.",
  );

  const sidecar = JSON.parse(
    await Deno.readTextFile(sidecarPathForPythonDocument(documentPath)),
  );
  assertEquals(sidecar, {
    version: 1,
    nodes: [{
      id: "n_test",
      position: { x: 10, y: 20 },
      description: "Print and return the updated value.",
    }],
  });
});

Deno.test("savePythonDocument rewrites document globals", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/globals_save.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "GLOBAL_OFFSET = 1",
      "",
      "from nodebook import node",
      "",
      '@node(id="n_test", outputs=["x"])',
      "def make_x():",
      "    x = GLOBAL_OFFSET",
      '    return {"x": x}',
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const saved = await savePythonDocument(documentPath, {
    ...loaded.document,
    globalsCode: 'GLOBAL_OFFSET = 2\nGLOBAL_LABEL = "updated"',
  });
  if (!saved.ok) {
    throw new Error(saved.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(
    await Deno.readTextFile(documentPath),
    [
      "GLOBAL_OFFSET = 2",
      'GLOBAL_LABEL = "updated"',
      "",
      "from nodebook import node",
      "",
      '@node(id="n_test", outputs=["x"])',
      "def make_x():",
      "    x = GLOBAL_OFFSET",
      '    return {"x": x}',
      "",
    ].join("\n"),
  );
  assertEquals(
    saved.document.globalsCode,
    'GLOBAL_OFFSET = 2\nGLOBAL_LABEL = "updated"',
  );
});

Deno.test("savePythonDocument inserts new document globals before first node", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/globals_insert.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from nodebook import node",
      "",
      '@node(id="n_test", outputs=["x"])',
      "def make_x():",
      "    x = GLOBAL_OFFSET",
      '    return {"x": x}',
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const saved = await savePythonDocument(documentPath, {
    ...loaded.document,
    globalsCode: "GLOBAL_OFFSET = 3",
  });
  if (!saved.ok) {
    throw new Error(saved.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(
    await Deno.readTextFile(documentPath),
    [
      "from nodebook import node",
      "GLOBAL_OFFSET = 3",
      "",
      '@node(id="n_test", outputs=["x"])',
      "def make_x():",
      "    x = GLOBAL_OFFSET",
      '    return {"x": x}',
      "",
    ].join("\n"),
  );
  assertEquals(saved.document.globalsCode, "GLOBAL_OFFSET = 3");
});

Deno.test("savePythonDocument rewrites standard node declared outputs", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/outputs.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from nodebook import node",
      "",
      '@node(id="n_test", outputs=["x"])',
      "def make_x():",
      "    x = 1",
      "    y = x + 1",
      '    return {"x": x}',
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const saved = await savePythonDocument(documentPath, {
    ...loaded.document,
    nodes: loaded.document.nodes.map((node) =>
      node.id === "n_test" ? { ...node, outputs: ["x", "y"] } : node
    ),
  });
  if (!saved.ok) {
    throw new Error(saved.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(
    await Deno.readTextFile(documentPath),
    [
      "from nodebook import node",
      "",
      '@node(id="n_test", outputs=["x", "y"])',
      "def make_x():",
      "    x = 1",
      "    y = x + 1",
      '    return {"x": x, "y": y}',
      "",
    ].join("\n"),
  );
  assertEquals(saved.document.nodes[0].outputs, ["x", "y"]);
});

Deno.test("savePythonDocument rewrites body and outputs together", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/body_outputs.py`;

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
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const saved = await savePythonDocument(documentPath, {
    ...loaded.document,
    nodes: loaded.document.nodes.map((node) =>
      node.id === "n_test"
        ? { ...node, code: "x = 2\ny = x + 1", outputs: ["x", "y"] }
        : node
    ),
  });
  if (!saved.ok) {
    throw new Error(saved.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(
    await Deno.readTextFile(documentPath),
    [
      "from nodebook import node",
      "",
      '@node(id="n_test", outputs=["x", "y"])',
      "def make_x():",
      "    x = 2",
      "    y = x + 1",
      '    return {"x": x, "y": y}',
      "",
    ].join("\n"),
  );
});

Deno.test("savePythonDocument rejects invalid rendered Python without overwriting source", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/invalid_body.py`;
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

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const saved = await savePythonDocument(documentPath, {
    ...loaded.document,
    nodes: loaded.document.nodes.map((node) =>
      node.id === "n_test"
        ? {
          ...node,
          code: "def broken():\nx = 2",
        }
        : node
    ),
  });

  assertEquals(saved.ok, false);
  if (!saved.ok) {
    assertEquals(saved.issues[0].kind, "invalid_python");
  }
  assertEquals(await Deno.readTextFile(documentPath), originalSource);

  try {
    await Deno.stat(sidecarPathForPythonDocument(documentPath));
    throw new Error("Sidecar should not be written after invalid source");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
});

Deno.test("savePythonDocument preserves leading body comments when rewriting", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/leading_comment.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from nodebook import node",
      "",
      '@node(id="n_test", outputs=["x"])',
      "def make_x():",
      "    # Keep this note with the body.",
      "    x = 1",
      '    return {"x": x}',
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const saved = await savePythonDocument(documentPath, loaded.document);
  if (!saved.ok) {
    throw new Error(saved.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(
    await Deno.readTextFile(documentPath),
    [
      "from nodebook import node",
      "",
      '@node(id="n_test", outputs=["x"])',
      "def make_x():",
      "    # Keep this note with the body.",
      "    x = 1",
      '    return {"x": x}',
      "",
    ].join("\n"),
  );
});

Deno.test("savePythonDocument rewrites function parameters from direct upstream outputs", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/rewrite_parameters.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from nodebook import node",
      "",
      '@node(id="n_load", outputs=["trips_raw"])',
      "def load_trips():",
      "    trips_raw = 1",
      '    return {"trips_raw": trips_raw}',
      "",
      '@node(id="n_prepare", outputs=["prepared"])',
      "def prepare_trips(trips_raw):",
      "    prepared = trips_raw + 1",
      '    return {"prepared": prepared}',
      "",
      "# NodeBook graph",
      "prepare_trips.depends_on(load_trips)",
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const nextDocument = {
    ...loaded.document,
    nodes: loaded.document.nodes.map((node) => {
      if (node.id === "n_load") {
        return {
          ...node,
          code: "trips = 1",
          outputs: ["trips"],
          runtimeCode: undefined,
        };
      }

      if (node.id === "n_prepare") {
        return {
          ...node,
          code: "prepared = trips + 1",
          runtimeCode: undefined,
        };
      }

      return node;
    }),
  };

  const saved = await savePythonDocument(documentPath, nextDocument);
  if (!saved.ok) {
    throw new Error(saved.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(
    await Deno.readTextFile(documentPath),
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
});

Deno.test("savePythonDocument rejects stale document revisions", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/stale.py`;

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
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  await Deno.writeTextFile(
    documentPath,
    [
      "from nodebook import node",
      "",
      '@node(id="n_test", outputs=["x"])',
      "def make_x():",
      "    x = 3",
      '    return {"x": x}',
      "",
    ].join("\n"),
  );

  const saved = await savePythonDocument(documentPath, loaded.document);
  assertEquals(saved.ok, false);
  if (!saved.ok) {
    assertEquals(saved.issues[0].kind, "stale_document");
  }
});

Deno.test("savePythonDocument rejects custom-return body edits", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/custom_save.py`;

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

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const nextDocument = {
    ...loaded.document,
    nodes: loaded.document.nodes.map((node) =>
      node.id === "n_custom" ? { ...node, code: 'return {"x": 4}' } : node
    ),
  };

  const saved = await savePythonDocument(documentPath, nextDocument);
  assertEquals(saved.ok, false);
  if (!saved.ok) {
    assertEquals(saved.issues[0].kind, "unsupported_python");
  }
});

Deno.test("savePythonDocument rejects custom-return output edits", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/custom_outputs.py`;

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

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const nextDocument = {
    ...loaded.document,
    nodes: loaded.document.nodes.map((node) =>
      node.id === "n_custom" ? { ...node, outputs: ["x", "y"] } : node
    ),
  };

  const saved = await savePythonDocument(documentPath, nextDocument);
  assertEquals(saved.ok, false);
  if (!saved.ok) {
    assertEquals(saved.issues[0].kind, "unsupported_python");
  }
});

Deno.test("savePythonDocument appends added Python node blocks", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/add_node.py`;

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
      "# NodeBook graph",
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const nextDocument = {
    ...loaded.document,
    nodes: [
      ...loaded.document.nodes,
      {
        id: "n_new",
        functionName: "new_node_2",
        parameters: [],
        code: "pass",
        outputs: [],
        customReturn: false,
        editable: true,
        position: { x: 10, y: 300 },
      },
    ],
  };

  const saved = await savePythonDocument(documentPath, nextDocument);
  if (!saved.ok) {
    throw new Error(saved.issues.map((issue) => issue.message).join("; "));
  }

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
      '@node(id="n_new", outputs=[])',
      "def new_node_2():",
      "    pass",
      "    return {}",
      "",
      "# NodeBook graph",
      "",
    ].join("\n"),
  );
  assertEquals(saved.document.nodes.map((node) => node.id), [
    "n_test",
    "n_new",
  ]);
});

Deno.test("savePythonDocument appends child edge for added node", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/add_child.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from nodebook import node",
      "",
      '@node(id="n_parent", outputs=["x"])',
      "def make_x():",
      "    x = 1",
      '    return {"x": x}',
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const nextDocument = {
    ...loaded.document,
    nodes: [
      ...loaded.document.nodes,
      {
        id: "n_child",
        functionName: "new_node_2",
        parameters: [],
        code: "pass",
        outputs: [],
        customReturn: false,
        editable: true,
      },
    ],
    edges: [
      ...loaded.document.edges,
      { fromNode: "n_parent", toNode: "n_child" },
    ],
  };

  const saved = await savePythonDocument(documentPath, nextDocument);
  if (!saved.ok) {
    throw new Error(saved.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(
    await Deno.readTextFile(documentPath),
    [
      "from nodebook import node",
      "",
      '@node(id="n_parent", outputs=["x"])',
      "def make_x():",
      "    x = 1",
      '    return {"x": x}',
      "",
      '@node(id="n_child", outputs=[])',
      "def new_node_2(x):",
      "    pass",
      "    return {}",
      "",
      "# NodeBook graph",
      "new_node_2.depends_on(make_x)",
      "",
    ].join("\n"),
  );
  assertEquals(saved.document.edges, [
    { fromNode: "n_parent", toNode: "n_child" },
  ]);
});

Deno.test("savePythonDocument renames Python node functions and graph references", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/rename_node.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from nodebook import node",
      "",
      '@node(id="n_load", outputs=["x"])',
      "def read_data():",
      "    x = 1",
      '    return {"x": x}',
      "",
      '@node(id="n_use", outputs=[])',
      "def use_data(x):",
      "    pass",
      "    return {}",
      "",
      "# NodeBook graph",
      "use_data.depends_on(read_data)",
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const nextDocument = {
    ...loaded.document,
    nodes: loaded.document.nodes.map((node) =>
      node.id === "n_load"
        ? { ...node, functionName: "read_and_transform_data" }
        : node
    ),
  };

  const saved = await savePythonDocument(documentPath, nextDocument);
  if (!saved.ok) {
    throw new Error(saved.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(
    await Deno.readTextFile(documentPath),
    [
      "from nodebook import node",
      "",
      '@node(id="n_load", outputs=["x"])',
      "def read_and_transform_data():",
      "    x = 1",
      '    return {"x": x}',
      "",
      '@node(id="n_use", outputs=[])',
      "def use_data(x):",
      "    pass",
      "    return {}",
      "",
      "# NodeBook graph",
      "use_data.depends_on(read_and_transform_data)",
      "",
    ].join("\n"),
  );
  assertEquals(saved.document.nodes[0].functionName, "read_and_transform_data");
});

Deno.test("savePythonDocument removes deleted nodes and incident edges", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/delete_node.py`;

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
      '@node(id="n_b", outputs=[])',
      "def use_x():",
      "    pass",
      "    return {}",
      "",
      "# NodeBook graph",
      "use_x.depends_on(make_x)",
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const nextDocument = {
    ...loaded.document,
    nodes: loaded.document.nodes
      .filter((node) => node.id !== "n_b")
      .map((node) => node.id === "n_a" ? { ...node, code: "x = 2" } : node),
    edges: loaded.document.edges.filter((edge) =>
      edge.fromNode !== "n_b" && edge.toNode !== "n_b"
    ),
  };

  const saved = await savePythonDocument(documentPath, nextDocument);
  if (!saved.ok) {
    throw new Error(saved.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(
    await Deno.readTextFile(documentPath),
    [
      "from nodebook import node",
      "",
      '@node(id="n_a", outputs=["x"])',
      "def make_x():",
      "    x = 2",
      '    return {"x": x}',
      "",
      "# NodeBook graph",
      "",
    ].join("\n"),
  );
  assertEquals(saved.document.nodes.map((node) => node.id), ["n_a"]);
  assertEquals(saved.document.edges, []);
});

Deno.test("savePythonDocument adds edge between existing nodes", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/add_existing_edge.py`;

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
      '@node(id="n_b", outputs=[])',
      "def use_x():",
      "    pass",
      "    return {}",
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const saved = await savePythonDocument(documentPath, {
    ...loaded.document,
    edges: [{ fromNode: "n_a", toNode: "n_b" }],
  });

  if (!saved.ok) {
    throw new Error(saved.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(
    await Deno.readTextFile(documentPath),
    [
      "from nodebook import node",
      "",
      '@node(id="n_a", outputs=["x"])',
      "def make_x():",
      "    x = 1",
      '    return {"x": x}',
      "",
      '@node(id="n_b", outputs=[])',
      "def use_x(x):",
      "    pass",
      "    return {}",
      "",
      "# NodeBook graph",
      "use_x.depends_on(make_x)",
      "",
    ].join("\n"),
  );
  assertEquals(saved.document.edges, [{ fromNode: "n_a", toNode: "n_b" }]);
});

Deno.test("savePythonDocument removes edge between existing nodes", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/remove_existing_edge.py`;

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
      '@node(id="n_b", outputs=[])',
      "def use_x(x):",
      "    pass",
      "    return {}",
      "",
      "# NodeBook graph",
      "use_x.depends_on(make_x)",
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const saved = await savePythonDocument(documentPath, {
    ...loaded.document,
    edges: [],
  });

  if (!saved.ok) {
    throw new Error(saved.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals(
    await Deno.readTextFile(documentPath),
    [
      "from nodebook import node",
      "",
      '@node(id="n_a", outputs=["x"])',
      "def make_x():",
      "    x = 1",
      '    return {"x": x}',
      "",
      '@node(id="n_b", outputs=[])',
      "def use_x():",
      "    pass",
      "    return {}",
      "",
      "# NodeBook graph",
      "",
    ].join("\n"),
  );
  assertEquals(saved.document.edges, []);
});

Deno.test("savePythonDocument rejects edge edits into custom-return nodes", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/custom_edge_edit.py`;

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
      '@node(id="n_custom", outputs=["y"])',
      "def use_x():",
      "    if True:",
      '        return {"y": 2}',
      '    return {"y": 3}',
      "",
    ].join("\n"),
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }

  const saved = await savePythonDocument(documentPath, {
    ...loaded.document,
    edges: [{ fromNode: "n_a", toNode: "n_custom" }],
  });

  assertEquals(saved.ok, false);
  if (!saved.ok) {
    assertEquals(saved.issues[0].kind, "unsupported_python");
  }
});
