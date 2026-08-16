import { createHandler } from "./index.ts";
import type { ActivityReductionBackend } from "./job.ts";
import type { ReduceSessionOptions, ReduceSessionResult } from "./postgres.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

class HttpBackend implements ActivityReductionBackend {
  closed = false;
  calls: ReduceSessionOptions[] = [];
  sessions = ["00000000-0000-4000-8000-000000000010"];

  resolveWorkspaceCutoff(): Promise<bigint> {
    return Promise.resolve(7n);
  }

  listSessionIds(): Promise<string[]> {
    return Promise.resolve(this.sessions);
  }

  reduceSession(options: ReduceSessionOptions): Promise<ReduceSessionResult> {
    this.calls.push(options);
    return Promise.resolve({
      session_id: options.sessionId,
      cutoff_event_id: 7n,
      candidate_count: 1,
      inserted_count: 1,
      tombstone_count: 0,
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const validEnvironment: Record<string, string> = {
  SUPABASE_DB_URL: "postgres://server-only",
  SHERLOCK_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
  SHERLOCK_ACTIVITY_REDUCER_TOKEN_SHA256:
    "0f6e9e2f15b4af82b824dd7bb88f474340b8a379fdb8ee87db10212116314cc5",
};

function setup(overrides: Record<string, string | undefined> = {}) {
  const environment = { ...validEnvironment, ...overrides };
  const backend = new HttpBackend();
  const handler = createHandler({
    env: (name) => environment[name],
    connect: (databaseUrl) => {
      assertEquals(databaseUrl, "postgres://server-only");
      return backend;
    },
    now: () => 0,
  });
  return { handler, backend };
}

function request(
  body = "{}",
  token: string | null = "narrow-job-token",
  method = "POST",
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== null) headers.set("x-sherlock-job-token", token);
  return new Request("https://example.test/reducer", {
    method,
    headers,
    body: method === "POST" ? body : undefined,
  });
}

Deno.test("HTTP job wrapper accepts only the narrow token and returns serialized receipt", async () => {
  const { handler, backend } = setup();
  const response = await handler(request());
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(body.through_event_id, "7");
  assertEquals(body.status, "complete");
  assert(backend.closed, "database pool must close after the invocation");
});

Deno.test("HTTP wrapper rejects wrong or missing machine token", async () => {
  for (const token of [null, "wrong"]) {
    const { handler, backend } = setup();
    const response = await handler(request("{}", token));
    assertEquals(response.status, 401);
    assert(!backend.closed, "unauthorized calls must not open a backend");
  }
});

Deno.test("HTTP wrapper rejects methods and caller-controlled job parameters", async () => {
  const { handler } = setup();
  assertEquals((await handler(request("", null, "GET"))).status, 405);
  assertEquals(
    (await handler(request('{"workspace_id":"other"}'))).status,
    400,
  );
  assertEquals((await handler(request("not-json"))).status, 400);
  assertEquals(
    (await handler(request(JSON.stringify({
      padding: "x".repeat(2_000),
    })))).status,
    400,
  );
});

Deno.test("HTTP wrapper fails closed on malformed server configuration", async () => {
  for (
    const overrides of [
      { SUPABASE_DB_URL: undefined },
      { SHERLOCK_WORKSPACE_ID: "not-a-uuid" },
      { SHERLOCK_ACTIVITY_REDUCER_TOKEN_SHA256: undefined },
      { SHERLOCK_ACTIVITY_REDUCER_TOKEN_SHA256: "not-a-hash" },
      { SHERLOCK_REDUCER_MAX_SESSIONS: "zero" },
    ]
  ) {
    const { handler } = setup(overrides);
    const response = await handler(request());
    assertEquals(response.status, 500);
    assertEquals(await response.json(), {
      error: { code: "invalid_configuration" },
    });
  }
});

Deno.test("HTTP wrapper contains synchronous database connection failures", async () => {
  const environment = { ...validEnvironment };
  const handler = createHandler({
    env: (name) => environment[name],
    connect: () => {
      throw new Error("malformed database URL with secret detail");
    },
  });
  const response = await handler(request());
  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: { code: "internal_error" } });
});

Deno.test("HTTP wrapper reports partial reducer failure and still closes backend", async () => {
  const { handler, backend } = setup();
  backend.reduceSession = () =>
    Promise.reject(new Error("synthetic secret detail"));
  const response = await handler(request());
  assertEquals(response.status, 500);
  const body = await response.json();
  assertEquals(body.failures, [{
    session_id: "00000000-0000-4000-8000-000000000010",
    code: "reduction_failed",
  }]);
  assert(
    !JSON.stringify(body).includes("synthetic secret detail"),
    "internal error details must not enter the response",
  );
  assert(backend.closed);
});
