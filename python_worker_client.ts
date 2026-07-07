import {
  getPythonCommandEnvironment,
  resolvePythonCommand,
} from "./runtime_config.ts";
import type { DocumentOperation, NodebookDocumentV1 } from "./document.ts";
import type { ExecutionResponse, ValidationIssue } from "./types.ts";

export const pythonWorkerOperations = [
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
] as const;

export type PythonWorkerOperation = typeof pythonWorkerOperations[number];

export type PythonWorkerSourcePayload = {
  source: string;
  documentPath: string;
};

export type PythonWorkerSourceRunPayload = PythonWorkerSourcePayload & {
  trace?: boolean;
  inputs?: Record<string, unknown>;
};

export type PythonWorkerDocumentPayload = {
  documentPath: string;
};

export type PythonWorkerDocumentOperationsPayload = {
  source: string;
  documentPath: string;
  operations: DocumentOperation[];
  sidecarMetadata?: unknown;
};

export type PythonWorkerPayloadByOperation = {
  validate_source: PythonWorkerSourcePayload;
  inspect_source: PythonWorkerSourcePayload;
  render_source: PythonWorkerSourcePayload;
  validate_candidate_source: PythonWorkerSourcePayload;
  plan_run: PythonWorkerSourcePayload & { target?: string };
  run_graph: PythonWorkerSourceRunPayload;
  run_to_node: PythonWorkerSourceRunPayload & { target: string };
  run_node: PythonWorkerSourceRunPayload & { target: string };
  load_document: PythonWorkerDocumentPayload;
  apply_operations: PythonWorkerDocumentOperationsPayload;
  clear_session_cache: Record<string, never>;
  shutdown: Record<string, never>;
};

export type PythonWorkerExecutionEvent = PythonWorkerEvent & {
  type:
    | "run_started"
    | "run_plan"
    | "node_started"
    | "node_completed"
    | "node_failed"
    | "run_completed"
    | "run_failed";
  response?: ExecutionResponse;
};

export type PythonWorkerDocumentEvent = PythonWorkerEvent & {
  type:
    | "load_document_completed"
    | "apply_operations_completed"
    | "render_source_completed"
    | "validate_candidate_source_completed";
  document?: NodebookDocumentV1;
  source?: string;
  sidecarMetadata?: unknown;
  issues?: ValidationIssue[];
};

export const pythonWorkerTerminalEventTypes = [
  "error",
  "validate_source_completed",
  "inspect_source_completed",
  "render_source_completed",
  "validate_candidate_source_completed",
  "plan_run_completed",
  "run_completed",
  "run_failed",
  "load_document_completed",
  "apply_operations_completed",
  "session_cache_cleared",
  "shutdown",
] as const;

export type PythonWorkerTerminalEventType =
  typeof pythonWorkerTerminalEventTypes[number];

export const pythonWorkerTerminalEventsByOperation = {
  validate_source: ["validate_source_completed", "error"],
  inspect_source: ["inspect_source_completed", "error"],
  render_source: ["render_source_completed", "error"],
  validate_candidate_source: ["validate_candidate_source_completed", "error"],
  plan_run: ["plan_run_completed", "error"],
  run_graph: ["run_completed", "run_failed", "error"],
  run_to_node: ["run_completed", "run_failed", "error"],
  run_node: ["run_completed", "run_failed", "error"],
  load_document: ["load_document_completed", "error"],
  apply_operations: ["apply_operations_completed", "error"],
  clear_session_cache: ["session_cache_cleared", "error"],
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
      env: getPythonCommandEnvironment(),
    });

    this.child = command.spawn();
    this.writer = this.child.stdin.getWriter();
    this.stderrText = "";
    this.stdoutDone = this.readStdout(this.child, this.child.stdout);
    this.stderrDone = this.readStderr(this.child.stderr);
  }

  private async readStdout(
    child: Deno.ChildProcess,
    stream: ReadableStream<Uint8Array>,
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
      if (this.child === child) {
        this.child = null;
        this.writer = null;
      }
    } catch (error) {
      this.failActiveOperation(error);
      if (this.child === child) {
        this.child = null;
        this.writer = null;
      }
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
    this.stderrText = "";

    if (writer) {
      await writer.close().catch(() => {});
    }
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // The worker may already have exited after stdin closed.
      }
      await child.status.catch(() => {});
    }

    await Promise.allSettled([
      stdoutDone ?? Promise.resolve(),
      stderrDone ?? Promise.resolve(),
    ]);
  }
}

function isTerminalWorkerEvent(event: PythonWorkerEvent): boolean {
  return pythonWorkerTerminalEventTypes.includes(
    event.type as PythonWorkerTerminalEventType,
  );
}
