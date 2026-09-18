import { assertEquals, assertRejects } from "@std/assert";
import {
  configurePythonRuntime,
  resolvePythonCommand,
} from "./runtime_config.ts";
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
    "inspect_source",
    "run_graph",
    "run_to_node",
    "query_table",
    "apply_operations",
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
    const cleanup = await fakeWorker(`
import json
import sys
import time
for line in sys.stdin:
    request = json.loads(line)
    if request["operation"] == "run_graph":
        print(json.dumps({"type": "run_started"}), flush=True)
        time.sleep(60)
    print(json.dumps({"type": "inspect_source_completed", "ok": True}), flush=True)
`);
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

      const finalEvent = await client.requestFinalEvent("inspect_source", {
        source: "",
        documentPath: "/tmp/cancel.py",
      });
      assertEquals(finalEvent.type, "inspect_source_completed");
    } finally {
      await client.shutdown();
      await cleanup();
    }
  },
);

Deno.test({
  name:
    "PythonWorkerClient cancellation kills spawned process-group descendants",
  fn: async () => {
    const cleanup = await fakeWorker(`

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
`);
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
      await cleanup();
    }
  },
});

Deno.test({
  name: "stale worker readers cannot fail a replacement worker request",
  fn: async () => {
    const cleanup = await fakeWorker(`

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
    print(json.dumps({"type": "inspect_source_completed", "ok": True}), flush=True)
`);
    const client = new PythonWorkerClient();
    try {
      const stream = client.request("run_graph", {
        source: "",
        documentPath: "/tmp/old-reader.py",
      });
      assertEquals((await stream.next()).value?.type, "run_started");
      await stream.return(undefined);

      const replacement = await client.requestFinalEvent("inspect_source", {
        source: "",
        documentPath: "/tmp/replacement.py",
      });
      assertEquals(replacement.type, "inspect_source_completed");
    } finally {
      await client.shutdown();
      await cleanup();
    }
  },
});

async function processExists(pid: number): Promise<boolean> {
  if (Deno.build.os === "windows") {
    const result = await new Deno.Command("tasklist.exe", {
      args: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(result.stdout).includes(`"${pid}"`);
  }
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
    const cleanup = await fakeWorker(`
import json
import sys
import time
for line in sys.stdin:
    request = json.loads(line)
    if request["operation"] == "run_graph":
        print(json.dumps({"type": "run_started"}), flush=True)
        time.sleep(60)
    print(json.dumps({"type": "inspect_source_completed", "ok": True}), flush=True)
`);
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

      const finalEvent = await client.requestFinalEvent("inspect_source", {
        source: "",
        documentPath: "/tmp/cancel.py",
      });
      assertEquals(finalEvent.type, "inspect_source_completed");
    } finally {
      await client.shutdown();
      await cleanup();
    }
  },
);

Deno.test(
  "PythonWorkerClient keeps requests queued while maintenance holds the stopped worker",
  async () => {
    const cleanup = await fakeWorker(`
import json
import sys
import time
for line in sys.stdin:
    request = json.loads(line)
    print(json.dumps({"type": "inspect_source_completed", "ok": True}), flush=True)
`);
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
      await client.requestFinalEvent("inspect_source", {
        source: "",
        documentPath: "/tmp/before-maintenance.py",
      });

      const maintenance = client.withWorkerStopped(async () => {
        maintenanceStarted();
        await maintenanceReleased;
      });
      await maintenanceStart;

      let requestSettled = false;
      const queuedRequest = client.requestFinalEvent("inspect_source", {
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
        "inspect_source_completed",
      );
    } finally {
      releaseMaintenance();
      await client.shutdown();
      await cleanup();
    }
  },
);

// Use a real Python interpreter and isolated package instead of shell wrappers.
async function fakeWorker(source: string): Promise<() => Promise<void>> {
  const probe = await new Deno.Command(await resolvePythonCommand(), {
    args: ["-c", "import sys; print(sys.executable)"],
    stdout: "piped",
  }).output();
  if (!probe.success) throw new Error("Cannot resolve test Python");
  const python = new TextDecoder().decode(probe.stdout).trim();
  const directory = await Deno.makeTempDir({ prefix: "rowcall worker ü " });
  await Deno.mkdir(`${directory}/rowcall/runtime`, { recursive: true });
  await Deno.writeTextFile(`${directory}/rowcall/__init__.py`, "");
  await Deno.writeTextFile(`${directory}/rowcall/runtime/__init__.py`, "");
  await Deno.writeTextFile(`${directory}/rowcall/runtime/worker.py`, source);
  const previous = Deno.cwd();
  Deno.chdir(directory);
  configurePythonRuntime({ command: python, pythonPathEntries: [directory] });
  return async () => {
    configurePythonRuntime({});
    Deno.chdir(previous);
    await Deno.remove(directory, { recursive: true });
  };
}
