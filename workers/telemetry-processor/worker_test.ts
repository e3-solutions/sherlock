import {
  alternateLane,
  CapacityCircuit,
  capacityRetryMilliseconds,
  chooseLane,
  chooseOverloadJobKind,
  handoffOverlapConnectionBudget,
  isCapacityError,
  loadConfig,
  retryDelaySeconds,
  updateOverloadState,
  workerConnectionBudget,
} from "./main.ts";
import { normalizationStatementTimeout } from "../../supabase/functions/sherlock-rollout-ingest/normalizer_postgres.ts";
import {
  AFFECTED_SESSIONS_SQL,
  recordLocatorFromRow,
  reduceAffectedSessions,
} from "./processor.ts";
import { createReservedTransactionRunner } from "./database.ts";
const railwayConfig = await Deno.readTextFile(
  new URL("../../railway.toml", import.meta.url),
);

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("configuration is bounded and secrets remain required", () => {
  const config = loadConfig({
    SUPABASE_DB_URL: "postgresql://example.invalid/postgres",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-secret",
  });
  assert(config.concurrency === 6);
  assert(config.liveReserved === 5);
  assert(config.normalizeReserved === 5);
  assert(config.controlConnections === 4);
  assert(config.processingConnections === 6);
  assert(config.processingTimeoutMilliseconds === 90_000);
  let rejected = false;
  try {
    loadConfig({
      SUPABASE_DB_URL: "postgresql://example.invalid/postgres",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-secret",
      SHERLOCK_WORKER_CONCURRENCY: "2",
      SHERLOCK_WORKER_LIVE_RESERVED: "3",
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "invalid reserved capacity must fail startup");
  for (const [concurrency, liveReserved] of [["1", "1"], ["4", "4"]]) {
    let invalid = false;
    try {
      loadConfig({
        SUPABASE_DB_URL: "postgresql://example.invalid/postgres",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "test-secret",
        SHERLOCK_WORKER_CONCURRENCY: concurrency,
        SHERLOCK_WORKER_LIVE_RESERVED: liveReserved,
      });
    } catch {
      invalid = true;
    }
    assert(invalid, `${concurrency}/${liveReserved} must be rejected`);
  }
});

Deno.test("connection pools and overload reservations stay within bounds", () => {
  const config = loadConfig({
    SUPABASE_DB_URL: "postgresql://example.invalid/postgres",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-secret",
  });
  assert(workerConnectionBudget(config, "handoff_wait") === 1);
  assert(workerConnectionBudget(config, "active") === 10);
  assert(handoffOverlapConnectionBudget(config) === 11);
  assert(config.controlConnections - 1 === 3);
  for (
    const invalid of [
      { SHERLOCK_WORKER_CONTROL_CONNECTIONS: "1" },
      { SHERLOCK_WORKER_PROCESSING_CONNECTIONS: "5" },
      { SHERLOCK_WORKER_NORMALIZE_RESERVED: "6" },
      {
        SHERLOCK_WORKER_OVERLOAD_ENTER_SECONDS: "60",
        SHERLOCK_WORKER_OVERLOAD_EXIT_SECONDS: "60",
      },
    ]
  ) {
    let rejected = false;
    try {
      loadConfig({
        SUPABASE_DB_URL: "postgresql://example.invalid/postgres",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "test-secret",
        ...invalid,
      });
    } catch {
      rejected = true;
    }
    assert(rejected, JSON.stringify(invalid));
  }
});

Deno.test("reserved transactions commit without pool transaction methods", async () => {
  const calls: string[] = [];
  let poolMethodCalls = 0;
  const connection = {
    unsafe(sql: string) {
      calls.push(sql);
      return Promise.resolve([]);
    },
    begin() {
      poolMethodCalls += 1;
      throw new Error("reserved connections do not support begin");
    },
    reserve() {
      poolMethodCalls += 1;
      throw new Error("must not acquire a nested connection");
    },
  };
  const run = createReservedTransactionRunner(connection as never);
  const result = await run(async (tx) => {
    await tx.unsafe("work");
    return 42;
  });
  assert(result === 42);
  assert(calls.join(",") === "begin,work,commit");
  assert(poolMethodCalls === 0);
});

Deno.test("reserved transactions roll back and preserve the work error", async () => {
  const calls: string[] = [];
  const workError = new Error("work failed");
  const connection = {
    unsafe(sql: string) {
      calls.push(sql);
      if (sql === "rollback") {
        return Promise.reject(new Error("rollback also failed"));
      }
      return Promise.resolve([]);
    },
  };
  const run = createReservedTransactionRunner(connection as never);
  let caught: unknown;
  try {
    await run(async (tx) => {
      await tx.unsafe("work");
      throw workError;
    });
  } catch (error) {
    caught = error;
  }
  assert(caught === workError);
  assert(calls.join(",") === "begin,work,rollback");
});

Deno.test("reserved transaction BEGIN failure does not issue ROLLBACK", async () => {
  const calls: string[] = [];
  const beginError = new Error("begin failed");
  const run = createReservedTransactionRunner({
    unsafe(sql: string) {
      calls.push(sql);
      return Promise.reject(beginError);
    },
  } as never);
  let caught: unknown;
  try {
    await run(() => Promise.resolve(undefined));
  } catch (error) {
    caught = error;
  }
  assert(caught === beginError);
  assert(calls.join(",") === "begin");
});

Deno.test("reserved transaction COMMIT failure rolls back the same session", async () => {
  const calls: string[] = [];
  const commitError = new Error("commit failed");
  const run = createReservedTransactionRunner({
    unsafe(sql: string) {
      calls.push(sql);
      if (sql === "commit") return Promise.reject(commitError);
      return Promise.resolve([]);
    },
  } as never);
  let caught: unknown;
  try {
    await run(async (tx) => {
      await tx.unsafe("work");
    });
  } catch (error) {
    caught = error;
  }
  assert(caught === commitError);
  assert(calls.join(",") === "begin,work,commit,rollback");
});

Deno.test("reserved transaction runner rejects nesting and cleans up", async () => {
  const calls: string[] = [];
  const run = createReservedTransactionRunner({
    unsafe(sql: string) {
      calls.push(sql);
      return Promise.resolve([]);
    },
  } as never);
  let message = "";
  try {
    await run(async () => await run(() => Promise.resolve(undefined)));
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  assert(message === "nested reserved transactions are not supported");
  assert(calls.join(",") === "begin,rollback");
});

Deno.test("Railway rebuilds only for the complete worker dependency closure", () => {
  for (
    const path of [
      "/workers/telemetry-processor/**",
      "/supabase/functions/sherlock-rollout-ingest/**",
      "/supabase/functions/sherlock-activity-reducer/**",
      "/packages/frame-evidence/**",
      "/.dockerignore",
      "/railway.toml",
    ]
  ) {
    assert(railwayConfig.includes(`"${path}"`), `missing watch path ${path}`);
  }
  assert(railwayConfig.includes("drainingSeconds = 120"));
  assert(railwayConfig.includes("overlapSeconds = 0"));
});

Deno.test("overload mode uses hysteresis and preserves one reduction lane", () => {
  const thresholds = { overloadEnterSeconds: 120, overloadExitSeconds: 60 };
  let state = { active: false, enterSamples: 0, exitSamples: 0 };
  state = updateOverloadState(state, 130, thresholds);
  assert(!state.active);
  state = updateOverloadState(state, 125, thresholds);
  assert(state.active);
  state = updateOverloadState(state, 61, thresholds);
  assert(state.active);
  state = updateOverloadState(state, 60, thresholds);
  assert(state.active);
  state = updateOverloadState(state, null, thresholds);
  assert(!state.active);
  assert(chooseOverloadJobKind(4, 1, 5) === "normalize");
  assert(chooseOverloadJobKind(5, 0, 5) === "reduce");
  assert(chooseOverloadJobKind(5, 1, 5) === "normalize");
});

Deno.test("only pool capacity errors open the worker circuit", () => {
  assert(isCapacityError(Object.assign(new Error("too many connections"), {
    code: "53300",
  })));
  assert(isCapacityError(Object.assign(new Error("pool EMAX"), {
    code: "XX000",
  })));
  assert(isCapacityError(Object.assign(new Error("session pool exhausted"), {
    code: "EMAXCONNSESSION",
  })));
  assert(
    !isCapacityError(Object.assign(new Error("serialization"), {
      code: "40001",
    })),
  );
  assert(
    !isCapacityError(Object.assign(new Error("generic internal error"), {
      code: "XX000",
    })),
  );
  assert(capacityRetryMilliseconds(1, () => 0.5) === 30_000);
  assert(capacityRetryMilliseconds(3, () => 0.5) === 120_000);
});

Deno.test("processing and control EMAX stay in one single-probe circuit", () => {
  let now = 0;
  const circuit = new CapacityCircuit(() => now, () => 0.5);
  const processingError = Object.assign(new Error("job EMAX"), {
    code: "XX000",
  });
  assert(
    circuit.handle(processingError) === 30_000,
    "processing capacity must be absorbed instead of rejecting the run loop",
  );
  assert(circuit.millisecondsUntilReady() === 30_000);
  now += 30_000;
  assert(circuit.isHalfOpen());
  assert(circuit.beginProbe(), "the first half-open claim must be admitted");
  assert(!circuit.beginProbe(), "a second half-open claim must be rejected");
  assert(circuit.hasProbeInFlight());

  const controlError = Object.assign(new Error("outer claim exhausted"), {
    code: "EMAXCONNSESSION",
  });
  assert(
    circuit.handle(controlError) === 60_000,
    "control capacity must reopen the same circuit instead of rejecting",
  );
  assert(!circuit.isHalfOpen());
  now += 60_000;
  assert(circuit.beginProbe());
  assert(!circuit.beginProbe());
  now += 300_000;
  assert(
    circuit.hasProbeInFlight(),
    "elapsed time alone must not admit work beside the probe",
  );
  assert(circuit.completeProbe());
  assert(circuit.millisecondsUntilReady() === 0);
});

Deno.test("normalization rechecks its absolute deadline after projection", () => {
  assert(normalizationStatementTimeout(5_000, 10_000, () => 8_000) === 2_000);
  let rejected = false;
  try {
    normalizationStatementTimeout(5_000, 10_000, () => 10_001);
  } catch (error) {
    rejected = error instanceof Error && "code" in error &&
      error.code === "processing_deadline_exceeded";
  }
  assert(rejected, "expired projection budget must prevent database work");
});

Deno.test("live capacity is reserved and backfill remains bounded", () => {
  const config = { concurrency: 4, liveReserved: 3 };
  assert(chooseLane(0, 3, config) === "live");
  assert(chooseLane(3, 0, config) === "backfill");
  assert(chooseLane(3, 1, config) === "live");
  assert(alternateLane("live", 0, config) === "backfill");
  assert(
    alternateLane("live", 1, config) === null,
    "backfill must not borrow live-reserved capacity",
  );
  assert(
    alternateLane("backfill", 0, config) === "live",
    "live work may borrow the backfill slot",
  );
});

Deno.test("retry backoff grows exponentially and caps", () => {
  assert(retryDelaySeconds(1, 5, 300) === 5);
  assert(retryDelaySeconds(4, 5, 300) === 40);
  assert(retryDelaySeconds(20, 5, 300) === 300);
});

Deno.test("worker reloads immutable native fragment metadata", () => {
  const locator = recordLocatorFromRow({
    record_index: "0",
    source_start_offset: "4194304",
    source_end_offset: "8388608",
    record_sha256: "a".repeat(64),
    native_type: null,
    native_payload_type: null,
    occurred_at: null,
    parse_status: "fragment",
    native_record_start_offset: "0",
    native_record_end_offset: "20971521",
    native_record_sha256: "b".repeat(64),
    fragment_index: "1",
    fragment_count: "6",
  });

  assert(locator.parse_status === "fragment");
  assert(locator.native_record_start_offset === 0);
  assert(locator.native_record_end_offset === 20 * 1024 * 1024 + 1);
  assert(locator.native_record_sha256 === "b".repeat(64));
  assert(locator.fragment_index === 1);
  assert(locator.fragment_count === 6);
});

Deno.test("parent repair retargets both normalized parents and their children", () => {
  assert(AFFECTED_SESSIONS_SQL.includes("id = any($2::uuid[])"));
  assert(AFFECTED_SESSIONS_SQL.includes("parent_session_id = any($2::uuid[])"));
  assert(!AFFECTED_SESSIONS_SQL.includes("limit"));
});

Deno.test("reduction targets only normalized sessions with no workspace scan", async () => {
  const visited: string[] = [];
  const result = await reduceAffectedSessions(
    "workspace-a",
    ["affected-session"],
    (sessionId) => {
      assert(sessionId === "affected-session");
      return Promise.resolve(42n);
    },
    {
      reduceSession(options) {
        visited.push(options.sessionId);
        assert(options.workspaceId === "workspace-a");
        assert(options.throughEventId === 42n);
        return Promise.resolve({
          candidate_count: 2,
          inserted_count: 2,
          tombstone_count: 0,
        });
      },
    },
  );
  assert(JSON.stringify(visited) === JSON.stringify(["affected-session"]));
  assert(result.session_count === 1 && result.inserted_count === 2);
});

Deno.test("targeted scheduling has no fifty-session ceiling", async () => {
  const sessions = Array.from({ length: 75 }, (_, index) => `session-${index}`);
  let reduced = 0;
  const result = await reduceAffectedSessions(
    "workspace-a",
    sessions,
    () => Promise.resolve(1n),
    {
      reduceSession() {
        reduced += 1;
        return Promise.resolve({
          candidate_count: 0,
          inserted_count: 0,
          tombstone_count: 0,
        });
      },
    },
  );
  assert(reduced === 75 && result.session_count === 75);
});
