import { assert, assertEquals } from "@std/assert";
import { streamExecutionEvents } from "./main.ts";
import type { ExecutionStreamEvent } from "./types.ts";

Deno.test("streamExecutionEvents emits padding and heartbeat comments around delayed events", async () => {
  const releaseEvent = deferred<void>();
  const event: ExecutionStreamEvent = {
    type: "run_started",
    runId: "run-1",
    runType: "run_graph",
  };

  async function* delayedEvents() {
    await releaseEvent.promise;
    yield event;
  }

  const response = streamExecutionEvents("run-1", "run_graph", delayedEvents());

  assertEquals(
    response.headers.get("Content-Type"),
    "text/event-stream; charset=utf-8",
  );
  assert(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    text = await readUntil(
      reader,
      decoder,
      text,
      (value) => value.includes(": nodebook stream padding"),
    );
    assert(!text.includes("data:"));

    text = await readUntil(
      reader,
      decoder,
      text,
      (value) => value.includes(": nodebook keep-alive"),
      1_200,
    );
    assert(!text.includes("data:"));

    releaseEvent.resolve();
    text = await readUntil(
      reader,
      decoder,
      text,
      (value) =>
        value.includes("event: run_started") &&
        value.includes('"type":"run_started"'),
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initialText: string,
  predicate: (value: string) => boolean,
  timeoutMs = 500,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = initialText;

  while (!predicate(text)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out waiting for stream content. Read:\n${text}`);
    }

    const result = await Promise.race([
      reader.read(),
      wait(remainingMs).then(() => "timeout" as const),
    ]);

    if (result === "timeout") {
      throw new Error(`Timed out waiting for stream content. Read:\n${text}`);
    }

    if (result.done) {
      throw new Error(`Stream ended before expected content. Read:\n${text}`);
    }

    text += decoder.decode(result.value, { stream: true });
  }

  return text;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}
