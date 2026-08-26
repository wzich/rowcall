import { assertEquals, assertRejects } from "@std/assert";
import { configurePythonRuntime } from "./runtime_config.ts";
import {
  PythonWorkerClient,
  pythonWorkerCommandArgs,
  pythonWorkerOperations,
  pythonWorkerTerminalEventsByOperation,
  pythonWorkerTerminalEventTypes,
} from "./python_worker_client.ts";

Deno.test("Python worker bootstrap creates a POSIX process group", () => {
  assertEquals(pythonWorkerCommandArgs("windows"), [
    "-m",
    "rowcall.runtime.worker",
  ]);
  const args = pythonWorkerCommandArgs("darwin");
  assertEquals(args[0], "-c");
  assertEquals(args[1].includes("os.setsid()"), true);
});

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
    "query_table",
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

Deno.test({
  name:
    "PythonWorkerClient cancellation kills spawned process-group descendants",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const directory = await Deno.makeTempDir();
    const packageDirectory = `${directory}/rowcall/runtime`;
    await Deno.mkdir(packageDirectory, { recursive: true });
    await Deno.writeTextFile(`${directory}/rowcall/__init__.py`, "");
    await Deno.writeTextFile(`${packageDirectory}/__init__.py`, "");
    await Deno.writeTextFile(
      `${packageDirectory}/worker.py`,
      `
import json
import subprocess
import sys
import time

json.loads(sys.stdin.readline())
child = subprocess.Popen([
    sys.executable,
    "-c",
    "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)",
])
print(json.dumps({"type": "run_started", "childPid": child.pid}), flush=True)
time.sleep(60)
`,
    );
    const wrapper = `${directory}/python-worker-test`;
    const quotedDirectory = directory.replaceAll("'", `'"'"'`);
    await Deno.writeTextFile(
      wrapper,
      `#!/bin/sh\ncd -- '${quotedDirectory}'\nexec python3 "$@"\n`,
      { mode: 0o700 },
    );

    configurePythonRuntime({
      command: wrapper,
      pythonPathEntries: [directory],
    });
    const client = new PythonWorkerClient();

    try {
      const stream = client.request("run_graph", {
        source: "",
        documentPath: "/tmp/process-group.py",
      });
      const started = await stream.next();
      assertEquals(started.done, false);
      assertEquals(started.value?.type, "run_started");
      const childPid = Number(started.value?.childPid);
      assertEquals(Number.isInteger(childPid) && childPid > 0, true);

      await stream.return(undefined);

      assertEquals(await waitForProcessExit(childPid), true);
    } finally {
      await client.shutdown();
      configurePythonRuntime({});
    }
  },
});

Deno.test({
  name: "stale worker readers cannot fail a replacement worker request",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const directory = await Deno.makeTempDir();
    const packageDirectory = `${directory}/rowcall/runtime`;
    await Deno.mkdir(packageDirectory, { recursive: true });
    await Deno.writeTextFile(`${directory}/rowcall/__init__.py`, "");
    await Deno.writeTextFile(`${packageDirectory}/__init__.py`, "");
    await Deno.writeTextFile(
      `${packageDirectory}/worker.py`,
      `
import json
import subprocess
import sys
import time

request = json.loads(sys.stdin.readline())
if request["operation"] == "run_graph":
    subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(4)"],
        start_new_session=True,
    )
    print(json.dumps({"type": "run_started"}), flush=True)
    time.sleep(60)
else:
    time.sleep(3)
    print(json.dumps({"type": "validate_source_completed", "ok": True}), flush=True)
`,
    );
    const wrapper = `${directory}/python-worker-generation-test`;
    const quotedDirectory = directory.replaceAll("'", `'"'"'`);
    await Deno.writeTextFile(
      wrapper,
      `#!/bin/sh\ncd -- '${quotedDirectory}'\nexec python3 "$@"\n`,
      { mode: 0o700 },
    );

    configurePythonRuntime({
      command: wrapper,
      pythonPathEntries: [directory],
    });
    const client = new PythonWorkerClient();
    try {
      const stream = client.request("run_graph", {
        source: "",
        documentPath: "/tmp/old-reader.py",
      });
      assertEquals((await stream.next()).value?.type, "run_started");
      await stream.return(undefined);

      const replacement = await client.requestFinalEvent("validate_source", {
        source: "",
        documentPath: "/tmp/replacement.py",
      });
      assertEquals(replacement.type, "validate_source_completed");
    } finally {
      await client.shutdown();
      configurePythonRuntime({});
    }
  },
});

async function processExists(pid: number): Promise<boolean> {
  const status = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
  if (!status.success) return false;

  // Linux keeps a killed process visible to kill(2) while it is a zombie
  // awaiting reaping. A zombie is no longer executing, so it satisfies the
  // cancellation guarantee this test is intended to verify.
  if (Deno.build.os === "linux") {
    const processState = await new Deno.Command("ps", {
      args: ["-o", "stat=", "-p", String(pid)],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!processState.success) return false;
    if (new TextDecoder().decode(processState.stdout).trim().startsWith("Z")) {
      return false;
    }
  }

  return true;
}

async function waitForProcessExit(
  pid: number,
  timeoutMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await processExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

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

Deno.test(
  "PythonWorkerClient keeps requests queued while maintenance holds the stopped worker",
  async () => {
    const directory = await Deno.makeTempDir();
    const workerPath = `${directory}/fake_worker.ts`;
    const commandPath = `${directory}/fake_python_worker`;

    await Deno.writeTextFile(
      workerPath,
      `
const decoder = new TextDecoder();
let buffer = "";

for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk, { stream: true });
  const lineEnd = buffer.indexOf("\\n");
  if (lineEnd < 0) continue;
  buffer = buffer.slice(lineEnd + 1);
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
    let releaseMaintenance!: () => void;
    const maintenanceReleased = new Promise<void>((resolve) => {
      releaseMaintenance = resolve;
    });
    let maintenanceStarted!: () => void;
    const maintenanceStart = new Promise<void>((resolve) => {
      maintenanceStarted = resolve;
    });

    try {
      await client.requestFinalEvent("validate_source", {
        source: "",
        documentPath: "/tmp/before-maintenance.py",
      });

      const maintenance = client.withWorkerStopped(async () => {
        maintenanceStarted();
        await maintenanceReleased;
      });
      await maintenanceStart;

      let requestSettled = false;
      const queuedRequest = client.requestFinalEvent("validate_source", {
        source: "",
        documentPath: "/tmp/after-maintenance.py",
      }).finally(() => {
        requestSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assertEquals(requestSettled, false);

      releaseMaintenance();
      await maintenance;
      assertEquals(
        (await queuedRequest).type,
        "validate_source_completed",
      );
    } finally {
      releaseMaintenance();
      await client.shutdown();
      configurePythonRuntime({});
    }
  },
);
