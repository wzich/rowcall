import { assertEquals } from "@std/assert";
import {
  buildNodebookUrl,
  type NodebookServerSecurity,
  validateLocalRequest,
} from "./main.ts";

const security: NodebookServerSecurity = {
  hostname: "127.0.0.1",
  port: 8000,
  authToken: "secret-token",
};

Deno.test("buildNodebookUrl includes the server auth token", () => {
  assertEquals(
    buildNodebookUrl("127.0.0.1", 8000, "secret-token"),
    "http://127.0.0.1:8000/?token=secret-token",
  );
});

Deno.test("validateLocalRequest allows static UI requests without a token", () => {
  assertEquals(
    validateLocalRequest(request("/", { host: "127.0.0.1:8000" }), security),
    { ok: true },
  );
});

Deno.test("validateLocalRequest requires a token for API requests", () => {
  assertEquals(
    validateLocalRequest(
      request("/document", { host: "127.0.0.1:8000" }),
      security,
    ),
    {
      ok: false,
      status: 401,
      message: "Missing or invalid Nodebook authorization token.",
    },
  );
  assertEquals(
    validateLocalRequest(
      request("/document", {
        host: "127.0.0.1:8000",
        token: "secret-token",
      }),
      security,
    ),
    { ok: true },
  );
});

Deno.test("validateLocalRequest accepts token query params for non-browser agents", () => {
  assertEquals(
    validateLocalRequest(
      request("/runtime/python?token=secret-token", {
        host: "localhost:8000",
      }),
      security,
    ),
    { ok: true },
  );
});

Deno.test("validateLocalRequest rejects unexpected Host and Origin headers", () => {
  assertEquals(
    statusOf(
      validateLocalRequest(
        request("/document", {
          host: "attacker.example:8000",
          token: "secret-token",
        }),
        security,
      ),
    ),
    403,
  );
  assertEquals(
    statusOf(
      validateLocalRequest(
        request("/document", {
          host: "127.0.0.1:8000",
          origin: "https://attacker.example",
          token: "secret-token",
        }),
        security,
      ),
    ),
    403,
  );
});

Deno.test("validateLocalRequest allows loopback dev-server origins", () => {
  assertEquals(
    validateLocalRequest(
      request("/run-graph", {
        method: "POST",
        host: "localhost:8000",
        origin: "http://127.0.0.1:5173",
        token: "secret-token",
      }),
      security,
    ),
    { ok: true },
  );
});

function statusOf(
  result: ReturnType<typeof validateLocalRequest>,
): number | null {
  return result.ok ? null : result.status;
}

function request(
  path: string,
  options: {
    method?: string;
    host: string;
    origin?: string;
    token?: string;
  },
): Request {
  const headers = new Headers({ host: options.host });
  if (options.origin) headers.set("origin", options.origin);
  if (options.token) headers.set("x-nodebook-token", options.token);
  return new Request(`http://${options.host}${path}`, {
    method: options.method ?? "GET",
    headers,
  });
}
