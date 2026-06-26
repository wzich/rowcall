import { resolvePythonCommand } from "./runtime_config.ts";

export type PythonWorkerOperation =
  | "validate_source"
  | "inspect_source"
  | "plan_run"
  | "run_graph"
  | "run_to_node"
  | "clear_session_cache"
  | "shutdown";

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
  private stderrText = "";
  private operationChain: Promise<void> = Promise.resolve();
  private readonly encoder = new TextEncoder();

  async *request(
    operation: PythonWorkerOperation,
    payload: Record<string, unknown> = {},
  ): AsyncGenerator<PythonWorkerEvent> {
    const release = await this.acquire();

    try {
      const queue = await this.startOperation({
        protocolVersion: 1,
        id: crypto.randomUUID(),
        operation,
        payload,
      });
      for await (const event of queue) {
        yield event;
      }
    } finally {
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
      if (this.activeQueue) {
        this.activeQueue.fail(new Error("Python worker was shut down"));
        this.activeQueue = null;
      }

      const child = this.child;
      const writer = this.writer;
      this.child = null;
      this.writer = null;

      if (writer) {
        await writer.close().catch(() => {});
      }
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Process may already have exited after stdin closed.
        }
        await child.status.catch(() => {});
      }

      await Promise.allSettled([
        this.stdoutDone ?? Promise.resolve(),
        this.stderrDone ?? Promise.resolve(),
      ]);
      this.stdoutDone = null;
      this.stderrDone = null;
      this.stderrText = "";
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
      args: ["-m", "nodebook.runtime.worker"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });

    this.child = command.spawn();
    this.writer = this.child.stdin.getWriter();
    this.stderrText = "";
    this.stdoutDone = this.readStdout(this.child.stdout);
    this.stderrDone = this.readStderr(this.child.stderr);
  }

  private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
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
          this.handleLine(line);
        }

        if (done) break;
      }

      if (buffer.trim().length > 0) {
        this.handleLine(buffer);
      }

      this.failActiveOperation(
        new Error(
          `Python worker ended unexpectedly. stderr: ${this.stderrText}`,
        ),
      );
      this.child = null;
      this.writer = null;
    } catch (error) {
      this.failActiveOperation(error);
      this.child = null;
      this.writer = null;
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      this.stderrText += decoder.decode(value, { stream: !done });
      if (this.stderrText.length > 8_000) {
        this.stderrText = this.stderrText.slice(-8_000);
      }
      if (done) break;
    }
  }

  private handleLine(line: string): void {
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
}

function isTerminalWorkerEvent(event: PythonWorkerEvent): boolean {
  return [
    "error",
    "validate_source_completed",
    "inspect_source_completed",
    "plan_run_completed",
    "run_completed",
    "run_failed",
    "session_cache_cleared",
    "shutdown",
  ].includes(event.type);
}
