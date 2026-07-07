import { assertEquals, assertRejects } from "@std/assert";
import { configurePythonRuntime } from "./runtime_config.ts";
import {
  PythonWorkerClient,
  pythonWorkerOperations,
  pythonWorkerTerminalEventsByOperation,
  pythonWorkerTerminalEventTypes,
} from "./python_worker_client.ts";

Deno.test("Python worker protocol declares document and run operations", () => {
  assertEquals([...pythonWorkerOperations], [
    "validate_source",
    "inspect_source",
    "render_source",
    "validate_candidate_source",
    "plan_run",
    "run_graph",
    "run_to_node",
    "run_node",
    "load_document",
    "apply_operations",
    "clear_session_cache",
    "shutdown",
  ]);
});

Deno.test("Python worker terminal event map covers every declared operation", () => {
  assertEquals(
    Object.keys(pythonWorkerTerminalEventsByOperation).sort(),
    [...pythonWorkerOperations].sort(),
  );

  const terminalTypes = new Set(pythonWorkerTerminalEventTypes);
  for (
    const eventTypes of Object.values(pythonWorkerTerminalEventsByOperation)
  ) {
    for (const eventType of eventTypes) {
      assertEquals(terminalTypes.has(eventType), true);
    }
  }
});

Deno.test(
  "PythonWorkerClient cancels a closed stream before the next operation",
  async () => {
    const directory = await Deno.makeTempDir();
    const workerPath = `${directory}/fake_worker.ts`;
    const commandPath = `${directory}/fake_python_worker`;

    await Deno.writeTextFile(
      workerPath,
      `
const decoder = new TextDecoder();
let buffer = "";
const pending = new Promise(() => {});

for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk, { stream: true });
  const lineEnd = buffer.indexOf("\\n");
  if (lineEnd < 0) continue;

  const line = buffer.slice(0, lineEnd);
  const request = JSON.parse(line);

  if (request.operation === "run_graph") {
    console.log(JSON.stringify({ type: "run_started" }));
    await pending;
  }

  console.log(JSON.stringify({ type: "validate_source_completed", ok: true }));
}
`,
    );
    await Deno.writeTextFile(
      commandPath,
      `#!/bin/sh
exec deno run --allow-read '${workerPath}' "$@"
`,
    );
    await Deno.chmod(commandPath, 0o755);

    configurePythonRuntime({ command: commandPath });
    const client = new PythonWorkerClient();

    try {
      const stream = client.request("run_graph", {
        source: "",
        documentPath: "/tmp/cancel.py",
      });
      assertEquals(await stream.next(), {
        value: { type: "run_started" },
        done: false,
      });

      await stream.return(undefined);

      const finalEvent = await client.requestFinalEvent("validate_source", {
        source: "",
        documentPath: "/tmp/cancel.py",
      });
      assertEquals(finalEvent.type, "validate_source_completed");
    } finally {
      await client.shutdown();
      configurePythonRuntime({});
    }
  },
);

Deno.test(
  "PythonWorkerClient aborts while next event is pending",
  async () => {
    const directory = await Deno.makeTempDir();
    const workerPath = `${directory}/fake_worker.ts`;
    const commandPath = `${directory}/fake_python_worker`;

    await Deno.writeTextFile(
      workerPath,
      `
const decoder = new TextDecoder();
let buffer = "";
const pending = new Promise(() => {});

for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk, { stream: true });
  const lineEnd = buffer.indexOf("\\n");
  if (lineEnd < 0) continue;

  const line = buffer.slice(0, lineEnd);
  const request = JSON.parse(line);

  if (request.operation === "run_graph") {
    console.log(JSON.stringify({ type: "run_started" }));
    await pending;
  }

  console.log(JSON.stringify({ type: "validate_source_completed", ok: true }));
}
`,
    );
    await Deno.writeTextFile(
      commandPath,
      `#!/bin/sh
exec deno run --allow-read '${workerPath}' "$@"
`,
    );
    await Deno.chmod(commandPath, 0o755);

    configurePythonRuntime({ command: commandPath });
    const client = new PythonWorkerClient();
    const abortController = new AbortController();

    try {
      const stream = client.request("run_graph", {
        source: "",
        documentPath: "/tmp/cancel.py",
      }, { signal: abortController.signal });
      assertEquals(await stream.next(), {
        value: { type: "run_started" },
        done: false,
      });

      const pendingNext = stream.next();
      abortController.abort();

      await assertRejects(
        () => pendingNext,
        Error,
        "Python worker operation was canceled",
      );

      const finalEvent = await client.requestFinalEvent("validate_source", {
        source: "",
        documentPath: "/tmp/cancel.py",
      });
      assertEquals(finalEvent.type, "validate_source_completed");
    } finally {
      await client.shutdown();
      configurePythonRuntime({});
    }
  },
);
