import {
  getPythonCommandEnvironment,
  resolvePythonCommand,
} from "./runtime_config.ts";
import type { DocumentOperation } from "./document.ts";
import type { TableQueryRequest } from "./types.ts";

export const pythonWorkerOperations = [
  "inspect_source",
  "run_graph",
  "run_to_node",
  "query_table",
  "apply_operations",
  "shutdown",
] as const;

export type PythonWorkerOperation = typeof pythonWorkerOperations[number];

export type PythonWorkerSourcePayload = {
  source: string;
  documentPath: string;
};

export type PythonWorkerSourceRunPayload = PythonWorkerSourcePayload & {
  runId?: string;
  trace?: boolean;
  inputs?: Record<string, unknown>;
};

export type PythonWorkerDocumentOperationsPayload = {
  source: string;
  documentPath: string;
  operations: DocumentOperation[];
  sidecarMetadata?: unknown;
};

export type PythonWorkerPayloadByOperation = {
  inspect_source: PythonWorkerSourcePayload;
  run_graph: PythonWorkerSourceRunPayload;
  run_to_node: PythonWorkerSourceRunPayload & { target: string };
  query_table: TableQueryRequest;
  apply_operations: PythonWorkerDocumentOperationsPayload;
  shutdown: Record<string, never>;
};

export const pythonWorkerTerminalEventTypes = [
  "error",
  "inspect_source_completed",
  "run_completed",
  "run_failed",
  "table_query_completed",
  "apply_operations_completed",
  "shutdown",
] as const;

export type PythonWorkerTerminalEventType =
  typeof pythonWorkerTerminalEventTypes[number];

export const pythonWorkerTerminalEventsByOperation = {
  inspect_source: ["inspect_source_completed", "error"],
  run_graph: ["run_completed", "run_failed", "error"],
  run_to_node: ["run_completed", "run_failed", "error"],
  query_table: ["table_query_completed", "error"],
  apply_operations: ["apply_operations_completed", "error"],
  shutdown: ["shutdown", "error"],
} as const satisfies Record<PythonWorkerOperation, readonly string[]>;

export type PythonWorkerEvent = {
  protocolVersion?: number;
  type: string;
  id?: string;
  ok?: boolean;
  error?: {
    kind: string;
    message: string;
  };
  [key: string]: unknown;
};

const WORKER_TERMINATION_GRACE_MS = 500;
const WORKER_EXIT_WAIT_MS = 2_000;
const POSIX_WORKER_BOOTSTRAP = [
  "import os, runpy",
  "os.setsid()",
  "runpy.run_module('rowcall.runtime.worker', run_name='__main__')",
].join(";");

export function pythonWorkerCommandArgs(
  os: typeof Deno.build.os = Deno.build.os,
): string[] {
  return os === "windows"
    ? ["-m", "rowcall.runtime.worker"]
    : ["-c", POSIX_WORKER_BOOTSTRAP];
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiting:
    | {
      resolve: (value: IteratorResult<T>) => void;
      reject: (error: unknown) => void;
    }
    | null = null;
  private closed = false;
  private error: unknown = null;

  push(value: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    this.error = error;
    this.closed = true;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift()!, done: false });
        }
        if (this.error) {
          return Promise.reject(this.error);
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
    };
  }
}

export class PythonWorkerClient {
  private child: Deno.ChildProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private activeQueue: AsyncEventQueue<PythonWorkerEvent> | null = null;
  private stdoutDone: Promise<void> | null = null;
  private stderrDone: Promise<void> | null = null;
  private workerGeneration = 0;
  private operationChain: Promise<void> = Promise.resolve();
  private readonly encoder = new TextEncoder();

  async *request(
    operation: PythonWorkerOperation,
    payload: Record<string, unknown> = {},
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<PythonWorkerEvent> {
    const release = await this.acquire();
    let queue: AsyncEventQueue<PythonWorkerEvent> | null = null;
    let cancelPromise: Promise<void> | null = null;

    try {
      if (options.signal?.aborted) {
        return;
      }
      queue = await this.startOperation({
        protocolVersion: 1,
        id: crypto.randomUUID(),
        operation,
        payload,
      });

      const cancelQueue = () => {
        if (queue && this.activeQueue === queue) {
          cancelPromise ??= this.cancelActiveOperation(queue);
        }
      };
      options.signal?.addEventListener("abort", cancelQueue, { once: true });
      try {
        if (options.signal?.aborted) {
          cancelQueue();
        }
        for await (const event of queue) {
          yield event;
        }
      } finally {
        options.signal?.removeEventListener("abort", cancelQueue);
      }
    } finally {
      if (queue && this.activeQueue === queue) {
        cancelPromise ??= this.cancelActiveOperation(queue);
      }
      if (cancelPromise) {
        await cancelPromise;
      }
      release();
    }
  }

  async requestFinalEvent(
    operation: PythonWorkerOperation,
    payload: Record<string, unknown> = {},
  ): Promise<PythonWorkerEvent> {
    let finalEvent: PythonWorkerEvent | null = null;
    for await (const event of this.request(operation, payload)) {
      finalEvent = event;
    }
    if (!finalEvent) {
      throw new Error(`Python worker ended before ${operation} completed`);
    }
    return finalEvent;
  }

  async shutdown(): Promise<void> {
    const release = await this.acquire();
    try {
      await this.shutdownAcquiredWorker();
    } finally {
      release();
    }
  }

  async withWorkerStopped<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      await this.shutdownAcquiredWorker();
      return await operation();
    } finally {
      release();
    }
  }

  private async acquire(): Promise<() => void> {
    const previous = this.operationChain;
    let release!: () => void;
    this.operationChain = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await previous;
    return release;
  }

  private async shutdownAcquiredWorker(): Promise<void> {
    if (this.activeQueue) {
      this.activeQueue.fail(new Error("Python worker was shut down"));
      this.activeQueue = null;
    }

    const child = this.child;
    const writer = this.writer;
    this.child = null;
    this.writer = null;

    const writerClosed = writer?.close().catch(() => {});
    if (child) {
      await terminateWorkerProcess(child);
    }
    if (writerClosed) await raceWithDelay(writerClosed, WORKER_EXIT_WAIT_MS);

    await settleWithDeadline([
      this.stdoutDone ?? Promise.resolve(),
      this.stderrDone ?? Promise.resolve(),
    ]);
    this.stdoutDone = null;
    this.stderrDone = null;
  }

  private async startOperation(
    request: Record<string, unknown>,
  ): Promise<AsyncEventQueue<PythonWorkerEvent>> {
    await this.ensureStarted();
    if (!this.writer) {
      throw new Error("Python worker stdin is unavailable");
    }
    if (this.activeQueue) {
      throw new Error("Python worker already has an active operation");
    }

    const queue = new AsyncEventQueue<PythonWorkerEvent>();
    this.activeQueue = queue;
    await this.writer.write(
      this.encoder.encode(`${JSON.stringify(request)}\n`),
    );
    return queue;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.writer) return;

    const command = new Deno.Command(await resolvePythonCommand(), {
      args: pythonWorkerCommandArgs(),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: getPythonCommandEnvironment(),
    });

    this.child = command.spawn();
    this.writer = this.child.stdin.getWriter();
    const child = this.child;
    const generation = ++this.workerGeneration;
    const diagnostics = { stderrText: "" };
    this.stdoutDone = this.readStdout(
      child,
      child.stdout,
      generation,
      diagnostics,
    );
    this.stderrDone = this.readStderr(child.stderr, diagnostics);
  }

  private async readStdout(
    child: Deno.ChildProcess,
    stream: ReadableStream<Uint8Array>,
    generation: number,
    diagnostics: { stderrText: string },
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          this.handleLine(line, child, generation);
        }

        if (done) break;
      }

      if (buffer.trim().length > 0) {
        this.handleLine(buffer, child, generation);
      }

      if (this.isCurrentWorker(child, generation)) {
        this.failActiveOperation(
          new Error(
            `Python worker ended unexpectedly. stderr: ${diagnostics.stderrText}`,
          ),
        );
        this.child = null;
        this.writer = null;
      }
    } catch (error) {
      if (this.isCurrentWorker(child, generation)) {
        this.failActiveOperation(error);
        this.child = null;
        this.writer = null;
      }
    }
  }

  private async readStderr(
    stream: ReadableStream<Uint8Array>,
    diagnostics: { stderrText: string },
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      diagnostics.stderrText += decoder.decode(value, { stream: !done });
      if (diagnostics.stderrText.length > 8_000) {
        diagnostics.stderrText = diagnostics.stderrText.slice(-8_000);
      }
      if (done) break;
    }
  }

  private handleLine(
    line: string,
    child: Deno.ChildProcess,
    generation: number,
  ): void {
    if (!this.isCurrentWorker(child, generation)) return;
    if (line.trim().length === 0) return;
    if (!this.activeQueue) {
      throw new Error(
        "Python worker emitted an event without an active operation",
      );
    }

    const event = JSON.parse(line) as PythonWorkerEvent;
    this.activeQueue.push(event);

    if (isTerminalWorkerEvent(event)) {
      this.activeQueue.close();
      this.activeQueue = null;
    }
  }

  private failActiveOperation(error: unknown): void {
    if (!this.activeQueue) return;
    this.activeQueue.fail(error);
    this.activeQueue = null;
  }

  private isCurrentWorker(
    child: Deno.ChildProcess,
    generation: number,
  ): boolean {
    return this.child === child && this.workerGeneration === generation;
  }

  private async cancelActiveOperation(
    queue: AsyncEventQueue<PythonWorkerEvent>,
  ): Promise<void> {
    if (this.activeQueue !== queue) return;

    queue.fail(new Error("Python worker operation was canceled"));
    this.activeQueue = null;

    const child = this.child;
    const writer = this.writer;
    const stdoutDone = this.stdoutDone;
    const stderrDone = this.stderrDone;

    this.child = null;
    this.writer = null;
    this.stdoutDone = null;
    this.stderrDone = null;

    const writerClosed = writer?.close().catch(() => {});
    if (child) {
      await terminateWorkerProcess(child);
    }
    if (writerClosed) await raceWithDelay(writerClosed, WORKER_EXIT_WAIT_MS);

    await settleWithDeadline([
      stdoutDone ?? Promise.resolve(),
      stderrDone ?? Promise.resolve(),
    ]);
  }
}

async function terminateWorkerProcess(child: Deno.ChildProcess): Promise<void> {
  const status = child.status.catch(() => null);
  if (Deno.build.os === "windows") {
    // Terminate the tree before the parent exits, while Windows can still
    // discover its descendants. SIGTERM only kills the immediate child.
    const result = await new Deno.Command("taskkill.exe", {
      args: ["/PID", String(child.pid), "/T", "/F"],
      stdout: "null",
      stderr: "null",
    }).output().catch(() => null);
    if (!result?.success) await signalWorker(child, "SIGKILL");
    await raceWithDelay(status, WORKER_EXIT_WAIT_MS);
    return;
  }
  await signalWorker(child, "SIGTERM");

  await raceWithDelay(status, WORKER_TERMINATION_GRACE_MS);

  // On POSIX, signal the group even if the worker already exited: a descendant
  // may have ignored SIGTERM while keeping the process group alive.
  await signalWorker(child, "SIGKILL");
  await raceWithDelay(status, WORKER_EXIT_WAIT_MS);
}

async function raceWithDelay(
  promise: Promise<unknown>,
  delayMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, delayMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleWithDeadline(promises: Promise<unknown>[]): Promise<void> {
  await raceWithDelay(Promise.allSettled(promises), WORKER_EXIT_WAIT_MS);
}

async function signalWorker(
  child: Deno.ChildProcess,
  signal: Deno.Signal,
): Promise<void> {
  if (Deno.build.os !== "windows") {
    try {
      const result = await new Deno.Command("/bin/kill", {
        // `--` is required by GNU kill to unambiguously treat the negative PID
        // as a process-group operand rather than another command-line option.
        args: [`-${signal.replace("SIG", "")}`, "--", `-${child.pid}`],
        stdout: "null",
        stderr: "null",
      }).output();
      if (result.success) return;
    } catch {
      // A custom test/development command may not have entered its own group.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The worker may already have exited after stdin closed.
  }
}

function isTerminalWorkerEvent(event: PythonWorkerEvent): boolean {
  return pythonWorkerTerminalEventTypes.includes(
    event.type as PythonWorkerTerminalEventType,
  );
}
