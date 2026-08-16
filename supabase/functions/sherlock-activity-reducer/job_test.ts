import {
  type ActivityReductionBackend,
  ActivityWorkspaceLimitError,
  runActivityReductionJob,
} from "./job.ts";
import {
  ActivitySessionBusyError,
  ActivitySessionDeadlineError,
  ActivitySessionLimitError,
  type ReduceSessionOptions,
  type ReduceSessionResult,
} from "./postgres.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const normalize = (value: unknown) =>
    JSON.stringify(
      value,
      (_key, item) => typeof item === "bigint" ? item.toString() : item,
    );
  if (normalize(actual) !== normalize(expected)) {
    throw new Error(
      `expected ${normalize(expected)}, received ${normalize(actual)}`,
    );
  }
}

class FakeBackend implements ActivityReductionBackend {
  cutoffCalls = 0;
  cutoffTimeout: number | undefined;
  listCalls = 0;
  listTimeout: number | undefined;
  reduceCalls: ReduceSessionOptions[] = [];
  closed = false;

  constructor(
    readonly sessions: string[],
    readonly outcomes: Record<string, ReduceSessionResult | Error> = {},
  ) {}

  resolveWorkspaceCutoff(
    _workspaceId?: string,
    _normalizerVersion?: string,
    statementTimeoutMs?: number,
  ): Promise<bigint> {
    this.cutoffCalls += 1;
    this.cutoffTimeout = statementTimeoutMs;
    return Promise.resolve(42n);
  }

  listSessionIds(
    options: { limit: number; statementTimeoutMs?: number },
  ): Promise<string[]> {
    this.listCalls += 1;
    this.listTimeout = options.statementTimeoutMs;
    return Promise.resolve(this.sessions.slice(0, options.limit));
  }

  reduceSession(options: ReduceSessionOptions): Promise<ReduceSessionResult> {
    this.reduceCalls.push(options);
    const outcome = this.outcomes[options.sessionId];
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(
      outcome ?? {
        session_id: options.sessionId,
        cutoff_event_id: 42n,
        candidate_count: 2,
        inserted_count: 1,
        tombstone_count: 0,
      },
    );
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const base = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  normalizerVersion: "normalizer.v1",
  activityVersion: "activity.v1",
  maxSessions: 5,
  maxEventsPerSession: 100,
  eventPageSize: 10,
  deadlineMs: 1_000,
  statementTimeoutMs: 100,
};

Deno.test("job captures one cutoff and applies the same bounded scope to every session", async () => {
  const backend = new FakeBackend(["a", "b"]);
  const result = await runActivityReductionJob(backend, base);

  assertEquals({
    status: result.status,
    cutoff: result.through_event_id,
    selected: result.selected_session_count,
    completed: result.completed_session_count,
    candidates: result.candidate_count,
    inserted: result.inserted_count,
  }, {
    status: "complete",
    cutoff: 42n,
    selected: 2,
    completed: 2,
    candidates: 4,
    inserted: 2,
  });
  assertEquals(backend.cutoffCalls, 1);
  assertEquals(backend.cutoffTimeout, 100);
  assertEquals(backend.listTimeout, 100);
  assert(
    backend.reduceCalls.every((call) =>
      call.throughEventId === 42n && call.maxEventCount === 100 &&
      call.eventPageSize === 10 &&
      call.statementTimeoutMs === 100
    ),
  );
});

Deno.test("overlapping session work is retryable and does not block later sessions", async () => {
  const backend = new FakeBackend(["a", "b"], {
    a: new ActivitySessionBusyError("a"),
  });
  const result = await runActivityReductionJob(backend, base);
  assertEquals(result.failures, [{ session_id: "a", code: "session_busy" }]);
  assertEquals(backend.reduceCalls.map((call) => call.sessionId), ["a", "b"]);
  assertEquals(result.completed_session_count, 1);
});

Deno.test("empty workspace is a successful no-op", async () => {
  const result = await runActivityReductionJob(new FakeBackend([]), base);
  assertEquals({
    status: result.status,
    selected: result.selected_session_count,
    completed: result.completed_session_count,
    inserted: result.inserted_count,
  }, { status: "complete", selected: 0, completed: 0, inserted: 0 });
});

Deno.test("workspace cap fails before any session work instead of starving UUIDs", async () => {
  const backend = new FakeBackend(["a", "b", "c"]);
  let error: unknown;
  try {
    await runActivityReductionJob(backend, { ...base, maxSessions: 2 });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof ActivityWorkspaceLimitError);
  assertEquals(backend.reduceCalls.length, 0);
});

Deno.test("bounded session failure does not block later sessions and is reported", async () => {
  const backend = new FakeBackend(["a", "b", "c"], {
    b: new ActivitySessionLimitError("b", 100),
  });
  const result = await runActivityReductionJob(backend, base);
  assertEquals({
    status: result.status,
    completed: result.completed_session_count,
    calls: backend.reduceCalls.map((call) => call.sessionId),
    failures: result.failures,
  }, {
    status: "partial_failure",
    completed: 2,
    calls: ["a", "b", "c"],
    failures: [{ session_id: "b", code: "session_event_limit_exceeded" }],
  });
});

Deno.test("deadline returns explicit retryable partial progress", async () => {
  const ticks = [0, 0, 100, 500, 600, 1_000, 1_000];
  const backend = new FakeBackend(["a", "b", "c"]);
  const result = await runActivityReductionJob(backend, {
    ...base,
    now: () => ticks.shift() ?? 1_000,
  });
  assertEquals(result.status, "partial_deadline");
  assertEquals(backend.reduceCalls.map((call) => call.sessionId), ["a", "b"]);
});

Deno.test("a session consuming the absolute budget stops the sweep", async () => {
  let current = 0;
  const backend = new FakeBackend(["a", "b"]);
  backend.reduceSession = (options) => {
    backend.reduceCalls.push(options);
    assertEquals(options.deadlineAtMs, 1_000);
    current = options.deadlineAtMs!;
    return Promise.reject(new ActivitySessionDeadlineError(options.sessionId));
  };
  const result = await runActivityReductionJob(backend, {
    ...base,
    now: () => current,
  });
  assertEquals(result.status, "partial_deadline");
  assertEquals(backend.reduceCalls.map((call) => call.sessionId), ["a"]);
  assertEquals(result.failures, [{
    session_id: "a",
    code: "session_deadline_exceeded",
  }]);
});
