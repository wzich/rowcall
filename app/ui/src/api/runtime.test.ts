import { assertEquals, assertRejects } from "@std/assert";
import {
  loadProjectEnvironment,
  restartPythonRuntime,
  RuntimeApiRequestError,
  syncProjectEnvironment,
} from "./runtime.ts";

Deno.test("runtime environment API uses separate status, sync, and restart routes", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; method: string }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      path: String(input),
      method: init?.method ?? "GET",
    });
    if (String(input).endsWith("/restart")) {
      return Promise.resolve(Response.json({ ok: true }));
    }
    return Promise.resolve(Response.json({
      ok: true,
      environment: {
        ownership: "rowcall",
        requirementsPath: "/project/requirements.txt",
        requirementsPresent: true,
        requirementsStatus: "current",
        canSync: true,
      },
    }));
  }) as typeof fetch;

  try {
    await loadProjectEnvironment();
    await syncProjectEnvironment();
    await restartPythonRuntime();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(requests, [
    { path: "/runtime/environment", method: "GET" },
    { path: "/runtime/environment/sync", method: "POST" },
    { path: "/runtime/python/restart", method: "POST" },
  ]);
});

Deno.test("runtime environment API surfaces server errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(Response.json({
      ok: false,
      error: {
        kind: "environment_sync_error",
        message: "pip failed",
      },
    }, { status: 422 }))) as typeof fetch;

  try {
    await assertRejects(
      syncProjectEnvironment,
      RuntimeApiRequestError,
      "pip failed",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
