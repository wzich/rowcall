import { assertEquals, assertExists } from "@std/assert";
import {
  applyPythonDocumentOperations,
  loadPythonDocument,
  postCommitInspectionResult,
  readPythonDocumentSource,
  setBeforeDocumentPublishForTests,
  setBeforeSidecarPublishForTests,
  sidecarPathForPythonDocument,
} from "./python_document.ts";
import {
  clearSourceRuntimeSessionCache,
  runSourceGraph,
  runSourceSingleNode,
  shutdownSourceRuntimeSession,
} from "./executor.ts";

Deno.test("post-commit inspection failures report an unknown save outcome", () => {
  const result = postCommitInspectionResult({
    ok: false,
    issues: [{
      kind: "invalid_python",
      message: "inspection worker stopped",
    }],
  });

  assertEquals(result, {
    ok: false,
    issues: [{
      kind: "document_write_error",
      message:
        "The document files were committed, but Rowcall could not inspect the saved state. Reload from disk before editing. inspection worker stopped",
    }],
  });
});

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

Deno.test("Python document source-backed node run executes fresh upstream", async () => {
  const path = "examples/hello_world.py";
  const source = await Deno.readTextFile(path);

  await clearSourceRuntimeSessionCache();
  try {
    const single = await runSourceSingleNode(source, path, "n_shout");

    assertEquals(single.ok, true);
    assertEquals(single.executedNodeIds, ["n_load", "n_shout"]);
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
      "from rowcall import node",
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
      "from rowcall import node",
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
      "# Rowcall graph",
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
      "from rowcall import node",
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
      "from rowcall import node",
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

Deno.test("loadPythonDocument rejects custom return nodes", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/custom.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from rowcall import node",
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

  assertEquals(decoded.ok, false);
  if (!decoded.ok) {
    assertEquals(decoded.issues[0].kind, "invalid_node_return");
    assertEquals(decoded.issues[0].nodeId, "n_custom");
    assertEquals(
      decoded.issues[0].message.includes("exactly one return statement"),
      true,
    );
    assertEquals(
      decoded.issues[0].message.includes("rowcall help format"),
      true,
    );
  }
});

Deno.test("loadPythonDocument rejects direct node-to-node calls", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/direct_call.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from rowcall import node",
      "",
      '@node(id="n_a", outputs=["x"])',
      "def make_x():",
      "    x = 1",
      '    return {"x": x}',
      "",
      '@node(id="n_b", outputs=["y"])',
      "def make_y():",
      "    result = make_x()",
      '    y = result["x"]',
      '    return {"y": y}',
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
    "from rowcall import node",
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
      "from rowcall import node",
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

Deno.test("save revalidates both files immediately before publishing", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/publish_race.py`;
  const externalSource = operationTestSource(99);
  await Deno.writeTextFile(documentPath, operationTestSource(1));

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load publish race test document.");
  }

  setBeforeDocumentPublishForTests(async () => {
    await Deno.writeTextFile(documentPath, externalSource);
  });
  try {
    const applied = await applyPythonDocumentOperations(
      documentPath,
      loaded.document.revision,
      [
        { type: "update_node_body", nodeId: "n_test", code: "x = 2" },
        {
          type: "move_node",
          nodeId: "n_test",
          position: { x: 20, y: 30 },
        },
      ],
    );

    assertEquals(applied.ok, false);
    if (!applied.ok) {
      assertEquals(applied.issues[0].kind, "stale_document");
    }
    assertEquals(await Deno.readTextFile(documentPath), externalSource);
    await assertNotFound(transactionPath(await Deno.realPath(documentPath)));
    assertEquals(
      (await Array.fromAsync(Deno.readDir(directory))).some((entry) =>
        entry.name.startsWith(".rowcall-source-") ||
        entry.name.startsWith(".rowcall-sidecar-")
      ),
      false,
    );
  } finally {
    setBeforeDocumentPublishForTests(null);
  }
});

Deno.test("read-only document directories can still be loaded and read", async () => {
  if (Deno.build.os === "windows") return;

  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/read_only.py`;
  const source = operationTestSource(1);
  await Deno.writeTextFile(documentPath, source);
  await Deno.chmod(directory, 0o555);
  try {
    const loaded = await loadPythonDocument(documentPath);
    if (!loaded.ok) {
      throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
    }
    assertEquals(loaded.document.nodes[0].id, "n_test");
    assertEquals(await readPythonDocumentSource(documentPath), source);
    const run = await runSourceGraph(source, documentPath);
    assertEquals(run.ok, true);
    assertEquals(run.finalOutputsByNode.n_test.x.jsonValue, 1);
  } finally {
    await shutdownSourceRuntimeSession();
    await Deno.chmod(directory, 0o755);
  }
});

Deno.test("read-only recovery errors are not reported as invalid Python", async () => {
  if (Deno.build.os === "windows") return;

  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/read_only_pending.py`;
  await Deno.writeTextFile(documentPath, operationTestSource(1));
  const canonicalDocumentPath = await Deno.realPath(documentPath);
  await Deno.writeTextFile(
    transactionPath(canonicalDocumentPath),
    "pending transaction\n",
  );
  await Deno.chmod(directory, 0o555);
  try {
    const loaded = await loadPythonDocument(documentPath);
    assertEquals(loaded.ok, false);
    if (!loaded.ok) {
      assertEquals(loaded.issues[0].kind, "document_read_error");
    }
  } finally {
    await Deno.chmod(directory, 0o755);
  }
});

Deno.test("save preserves an external sidecar edit after the source commit", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/sidecar_commit_race.py`;
  const sidecarPath = sidecarPathForPythonDocument(documentPath);
  const originalSidecar = `${
    JSON.stringify({ version: 1, nodes: [] }, null, 2)
  }\n`;
  const externalSidecar = `${
    JSON.stringify(
      {
        version: 1,
        nodes: [{ id: "n_test", title: "External title" }],
      },
      null,
      2,
    )
  }\n`;
  await Deno.writeTextFile(documentPath, operationTestSource(1));
  await Deno.writeTextFile(sidecarPath, originalSidecar);

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load sidecar commit race test document.");
  }

  setBeforeSidecarPublishForTests(async () => {
    await Deno.writeTextFile(sidecarPath, externalSidecar);
  });
  try {
    const applied = await applyPythonDocumentOperations(
      documentPath,
      loaded.document.revision,
      [
        { type: "update_node_body", nodeId: "n_test", code: "x = 2" },
        {
          type: "move_node",
          nodeId: "n_test",
          position: { x: 20, y: 30 },
        },
      ],
    );

    assertEquals(applied.ok, false);
    if (!applied.ok) {
      assertEquals(applied.issues[0].kind, "document_write_error");
    }
    assertEquals(await Deno.readTextFile(documentPath), operationTestSource(2));
    assertEquals(await Deno.readTextFile(sidecarPath), externalSidecar);
    const canonicalDocumentPath = await Deno.realPath(documentPath);
    assertEquals(
      (await Deno.stat(transactionPath(canonicalDocumentPath))).isFile,
      true,
    );
  } finally {
    setBeforeSidecarPublishForTests(null);
  }
});

Deno.test("applyPythonDocumentOperations updates a standard node body", async () => {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/body_operation.py`;

  await Deno.writeTextFile(
    documentPath,
    [
      "from rowcall import node",
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
      "from rowcall import node",
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
      "from rowcall import node",
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
      "# Rowcall graph",
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
      "from rowcall import node",
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
      "from rowcall import node",
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
      "from rowcall import node",
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
      "from rowcall import node",
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

Deno.test("applyPythonDocumentOperations preserves document symlinks", async () => {
  if (Deno.build.os === "windows") return;

  const directory = await Deno.makeTempDir();
  const targetPath = `${directory}/target.py`;
  const linkPath = `${directory}/linked.py`;
  await Deno.writeTextFile(targetPath, operationTestSource(1));
  await Deno.symlink(targetPath, linkPath);

  const loaded = await loadPythonDocument(linkPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load symlink operation test document.");
  }
  const applied = await applyPythonDocumentOperations(
    linkPath,
    loaded.document.revision,
    [{ type: "update_node_body", nodeId: "n_test", code: "x = 2" }],
  );
  if (!applied.ok) {
    throw new Error(applied.issues.map((issue) => issue.message).join("; "));
  }

  assertEquals((await Deno.lstat(linkPath)).isSymlink, true);
  assertEquals(await Deno.readTextFile(targetPath), operationTestSource(2));
});

Deno.test("save rejects a document symlink retargeted before publish", async () => {
  if (Deno.build.os === "windows") return;

  const directory = await Deno.makeTempDir();
  const firstTarget = `${directory}/first.py`;
  const secondTarget = `${directory}/second.py`;
  const linkPath = `${directory}/active.py`;
  await Deno.writeTextFile(firstTarget, operationTestSource(1));
  await Deno.writeTextFile(secondTarget, operationTestSource(9));
  await Deno.symlink(firstTarget, linkPath);
  const loaded = await loadPythonDocument(linkPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load retarget test document.");
  }

  setBeforeDocumentPublishForTests(async () => {
    await Deno.remove(linkPath);
    await Deno.symlink(secondTarget, linkPath);
  });
  try {
    const applied = await applyPythonDocumentOperations(
      linkPath,
      loaded.document.revision,
      [{ type: "update_node_body", nodeId: "n_test", code: "x = 2" }],
    );
    assertEquals(applied.ok, false);
    if (!applied.ok) assertEquals(applied.issues[0].kind, "stale_document");
    assertEquals(await Deno.readTextFile(firstTarget), operationTestSource(1));
    assertEquals(await Deno.readTextFile(secondTarget), operationTestSource(9));
    assertEquals(
      await Deno.realPath(linkPath),
      await Deno.realPath(secondTarget),
    );
  } finally {
    setBeforeDocumentPublishForTests(null);
  }
});

Deno.test("save rejects a sidecar symlink retargeted before publish", async () => {
  if (Deno.build.os === "windows") return;

  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/active.py`;
  const sidecarPath = sidecarPathForPythonDocument(documentPath);
  const firstTarget = `${directory}/metadata-first.json`;
  const secondTarget = `${directory}/metadata-second.json`;
  const metadata = (x: number, y: number) =>
    `${
      JSON.stringify(
        {
          version: 1,
          nodes: [{ id: "n_test", position: { x, y } }],
        },
        null,
        2,
      )
    }\n`;
  await Deno.writeTextFile(documentPath, operationTestSource(1));
  await Deno.writeTextFile(firstTarget, metadata(1, 1));
  await Deno.writeTextFile(secondTarget, metadata(99, 99));
  await Deno.symlink(firstTarget, sidecarPath);
  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load retarget test sidecar.");
  }

  setBeforeDocumentPublishForTests(async () => {
    await Deno.remove(sidecarPath);
    await Deno.symlink(secondTarget, sidecarPath);
  });
  try {
    const applied = await applyPythonDocumentOperations(
      documentPath,
      loaded.document.revision,
      [{
        type: "move_node",
        nodeId: "n_test",
        position: { x: 2, y: 3 },
      }],
    );
    assertEquals(applied.ok, false);
    if (!applied.ok) assertEquals(applied.issues[0].kind, "stale_document");
    assertEquals(await Deno.readTextFile(firstTarget), metadata(1, 1));
    assertEquals(await Deno.readTextFile(secondTarget), metadata(99, 99));
    assertEquals(
      await Deno.realPath(sidecarPath),
      await Deno.realPath(secondTarget),
    );
  } finally {
    setBeforeDocumentPublishForTests(null);
  }
});

Deno.test("save rejects a dangling sidecar symlink created before publish", async () => {
  if (Deno.build.os === "windows") return;

  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/active.py`;
  const sidecarPath = sidecarPathForPythonDocument(documentPath);
  const missingTarget = `${directory}/metadata-not-created.json`;
  await Deno.writeTextFile(documentPath, operationTestSource(1));
  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok || !loaded.document.revision) {
    throw new Error("Failed to load dangling-sidecar test document.");
  }

  setBeforeDocumentPublishForTests(async () => {
    await Deno.symlink(missingTarget, sidecarPath);
  });
  try {
    const applied = await applyPythonDocumentOperations(
      documentPath,
      loaded.document.revision,
      [{
        type: "move_node",
        nodeId: "n_test",
        position: { x: 2, y: 3 },
      }],
    );
    assertEquals(applied.ok, false);
    if (!applied.ok) assertEquals(applied.issues[0].kind, "stale_document");
    assertEquals((await Deno.lstat(sidecarPath)).isSymlink, true);
    assertEquals(await Deno.readTextFile(documentPath), operationTestSource(1));
  } finally {
    setBeforeDocumentPublishForTests(null);
  }
});

Deno.test("loadPythonDocument completes a committed sidecar transaction", async () => {
  const directory = await Deno.makeTempDir();
  const requestedPath = `${directory}/recover.py`;
  const nextSource = operationTestSource(2);
  const oldSidecar = `${JSON.stringify({ version: 1, nodes: [] }, null, 2)}\n`;
  const nextSidecar = `${
    JSON.stringify(
      {
        version: 1,
        nodes: [{ id: "n_test", position: { x: 12, y: 34 } }],
      },
      null,
      2,
    )
  }\n`;
  await Deno.writeTextFile(requestedPath, nextSource);
  const documentPath = await Deno.realPath(requestedPath);
  const canonicalDirectory = documentPath.slice(
    0,
    documentPath.lastIndexOf("/"),
  );
  const sidecarPath = sidecarPathForPythonDocument(documentPath);
  await Deno.writeTextFile(sidecarPath, oldSidecar);

  const sourceTempPath = `${canonicalDirectory}/.rowcall-source-recovery`;
  const sidecarTempPath = `${canonicalDirectory}/.rowcall-sidecar-recovery`;
  await Deno.writeTextFile(sidecarTempPath, nextSidecar);
  await Deno.writeTextFile(
    transactionPath(documentPath),
    `${
      JSON.stringify(
        {
          version: 1,
          sourcePath: documentPath,
          sidecarPath,
          sourceTempPath,
          sidecarTempPath,
          newSourceRevision: await sha256(nextSource),
          oldSidecarRevision: await sha256(oldSidecar),
          newSidecarRevision: await sha256(nextSidecar),
        },
        null,
        2,
      )
    }\n`,
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }
  assertEquals(loaded.document.nodes[0].position, { x: 12, y: 34 });
  assertEquals(await Deno.readTextFile(sidecarPath), nextSidecar);
  await assertNotFound(transactionPath(documentPath));
  await assertNotFound(sidecarTempPath);
});

Deno.test("loadPythonDocument discards a transaction before its commit point", async () => {
  const directory = await Deno.makeTempDir();
  const requestedPath = `${directory}/recover.py`;
  const oldSource = operationTestSource(1);
  const nextSource = operationTestSource(2);
  const oldSidecar = `${JSON.stringify({ version: 1, nodes: [] }, null, 2)}\n`;
  const nextSidecar = `${
    JSON.stringify(
      {
        version: 1,
        nodes: [{ id: "n_test", position: { x: 12, y: 34 } }],
      },
      null,
      2,
    )
  }\n`;
  await Deno.writeTextFile(requestedPath, oldSource);
  const documentPath = await Deno.realPath(requestedPath);
  const canonicalDirectory = documentPath.slice(
    0,
    documentPath.lastIndexOf("/"),
  );
  const sidecarPath = sidecarPathForPythonDocument(documentPath);
  const sourceTempPath = `${canonicalDirectory}/.rowcall-source-recovery`;
  const sidecarTempPath = `${canonicalDirectory}/.rowcall-sidecar-recovery`;
  await Deno.writeTextFile(sidecarPath, oldSidecar);
  await Deno.writeTextFile(sourceTempPath, nextSource);
  await Deno.writeTextFile(sidecarTempPath, nextSidecar);
  await Deno.writeTextFile(
    transactionPath(documentPath),
    `${
      JSON.stringify(
        {
          version: 1,
          sourcePath: documentPath,
          sidecarPath,
          sourceTempPath,
          sidecarTempPath,
          newSourceRevision: await sha256(nextSource),
          oldSidecarRevision: await sha256(oldSidecar),
          newSidecarRevision: await sha256(nextSidecar),
        },
        null,
        2,
      )
    }\n`,
  );

  const loaded = await loadPythonDocument(documentPath);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  }
  assertEquals(loaded.document.nodes[0].position, undefined);
  assertEquals(await Deno.readTextFile(documentPath), oldSource);
  assertEquals(await Deno.readTextFile(sidecarPath), oldSidecar);
  await assertNotFound(transactionPath(documentPath));
  await assertNotFound(sourceTempPath);
  await assertNotFound(sidecarTempPath);
});

function operationTestSource(value: number): string {
  return [
    "from rowcall import node",
    "",
    '@node(id="n_test", outputs=["x"])',
    "def make_x():",
    `    x = ${value}`,
    '    return {"x": x}',
    "",
  ].join("\n");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function transactionPath(documentPath: string): string {
  const separator = documentPath.lastIndexOf("/");
  const directory = documentPath.slice(0, separator);
  const name = documentPath.slice(separator + 1);
  return `${directory}/.${name}.rowcall-transaction.json`;
}

async function assertNotFound(path: string): Promise<void> {
  try {
    await Deno.stat(path);
    throw new Error(`Expected path to be absent: ${path}`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
