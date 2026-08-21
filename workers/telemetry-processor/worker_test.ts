import {
  alternateLane,
  chooseLane,
  loadConfig,
  retryDelaySeconds,
} from "./main.ts";
import {
  AFFECTED_SESSIONS_SQL,
  recordLocatorFromRow,
  reduceAffectedSessions,
} from "./processor.ts";

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
    SHERLOCK_WORKER_CONCURRENCY: "4",
    SHERLOCK_WORKER_LIVE_RESERVED: "3",
  });
  assert(config.concurrency === 4);
  assert(config.liveReserved === 3);
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
