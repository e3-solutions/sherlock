import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";

import {
  DirectFlameSource,
  NORMALIZER_VERSION,
} from "./flame-source.js";
import { expectUsageQueryParity } from "./test-fixtures/usage-query-oracle.js";
import { COVERAGE_SQL, QUERY_USAGE_SQL, createSherlockQuerySource } from "./mcp-query-source.js";

const DATABASE_URL = process.env.SHERLOCK_TEST_DATABASE_URL;
const describePostgres = DATABASE_URL ? describe : describe.skip;
const WINDOW_START = "2026-09-10T12:00:00.000Z";
const WINDOW_END = "2026-09-10T13:00:00.000Z";
const SAME_TIME = "2026-09-10T12:30:00.000Z";
const ZERO_TOKENS = Object.freeze({
  input: 0,
  cachedInput: 0,
  output: 0,
  reasoning: 0,
  total: 0,
});

function hash(number) {
  return number.toString(16).padStart(64, "0");
}

async function cleanup(sql, workspaceId) {
  await sql.unsafe("delete from processing.telemetry_jobs where workspace_id = $1", [workspaceId]);
  await sql.unsafe("delete from telemetry.events where workspace_id = $1", [workspaceId]);
  await sql.unsafe("delete from telemetry.native_records where workspace_id = $1", [workspaceId]);
  await sql.unsafe("delete from telemetry.ingest_batches where workspace_id = $1", [workspaceId]);
  await sql.unsafe("delete from telemetry.sessions where workspace_id = $1", [workspaceId]);
  await sql.unsafe("delete from telemetry.people where workspace_id = $1", [workspaceId]);
  await sql.unsafe("delete from telemetry.workspaces where id = $1", [workspaceId]);
}

async function createFixture({ startedAt = "2026-09-10T11:00:00.000Z", cutoverAt = null, parity = true } = {}) {
  const workspaceId = crypto.randomUUID();
  const personId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const nativeSessionId = `native-${sessionId}`;
  const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
  let batchSequence = 0;

  await sql.unsafe(
    `insert into telemetry.workspaces (id, slug, name, created_at)
     values ($1, $2, 'Usage reconciliation fixture', coalesce($3::timestamptz, now()))`,
    [workspaceId, `usage-reconciliation-${workspaceId}`, cutoverAt],
  );
  await sql.unsafe(
    `insert into telemetry.people (
       id, workspace_id, identity_key, display_name, email
     ) values ($1, $2, $3, 'Usage Reconciliation', 'usage-reconciliation@e3group.ai')`,
    [personId, workspaceId, `usage-reconciliation-${personId}`],
  );
  await sql.unsafe(
    `insert into telemetry.sessions (
       id, workspace_id, person_id, collector_key, native_session_id,
       actor_role, role_version, model, started_at, created_at
     ) values (
       $1, $2, $3, 'usage-reconciliation', $4,
       'primary', 'usage-reconciliation.v1', 'session-model-must-not-win', $5, $5
     )`,
    [sessionId, workspaceId, personId, nativeSessionId, startedAt],
  );

  const createBatch = async ({
    sourceStreamKey = `transport-${batchSequence}`,
    generationKey = `generation-${batchSequence}`,
    generationSeq = 0,
    batchHash = hash(10_000 + batchSequence),
    provider = "codex",
  } = {}) => {
    const batchId = crypto.randomUUID();
    batchSequence += 1;
    await sql.unsafe(
      `insert into telemetry.ingest_batches (
         id, workspace_id, person_id, collector_key, observed_native_session_id,
         source_provider, source_kind, source_stream_key, generation_key,
         generation_seq, start_offset, end_offset, source_byte_count,
         source_sha256, storage_path, storage_encoding, stored_byte_count,
         stored_sha256, record_count, contract_version,
         first_occurred_at, last_occurred_at
       ) values (
         $1, $2, $3, 'usage-reconciliation', $4,
         $12, $13, $5, $6,
         $7, 0, 1000, 1000,
         $8, $9, 'identity', 1000,
         $8, 32, 'sherlock.rollout-batch.v1', $10, $11
       )`,
      [
        batchId,
        workspaceId,
        personId,
        nativeSessionId,
        sourceStreamKey,
        generationKey,
        generationSeq,
        batchHash,
        `usage-reconciliation/${workspaceId}/${batchId}.jsonl`,
        "2026-09-10T10:00:00.000Z",
        "2026-09-10T13:00:00.000Z",
        provider,
        provider === "codex" ? "rollout" : "transcript",
      ],
    );
    return batchId;
  };

  const insertEvent = async ({
    batchId,
    recordIndex,
    offset,
    endOffset = offset + 1,
    recordHash = hash(offset + 1),
    occurredAt = SAME_TIME,
    nativeOccurredAt = occurredAt,
    serverReceivedAt = occurredAt ?? SAME_TIME,
    kind,
    subtype = null,
    model = null,
    total = null,
    input = total,
    cachedInput = total === null ? null : 0,
    output = total === null ? null : 0,
    reasoning = total === null ? null : 0,
    stream = "main",
    cumulative = true,
    normalizer = NORMALIZER_VERSION,
    isReplay = false,
    priority = 100,
    scope = null,
    logicalKey = null,
    sourceRecordId = null,
    usageScope = "session",
    eventSessionId = sessionId,
  }) => {
    const [record] = sourceRecordId ? [{ id: sourceRecordId }] : await sql.unsafe(
      `insert into telemetry.native_records (
         workspace_id, batch_id, record_index, source_start_offset,
         source_end_offset, record_sha256, native_type,
         native_payload_type, occurred_at, parse_status
       ) values ($1, $2, $3, $4::bigint, $8::bigint, $5, 'event_msg', $6, $7, 'ok')
       returning id`,
      [
        workspaceId,
        batchId,
        recordIndex,
        offset,
        recordHash,
        subtype,
        nativeOccurredAt,
        endOffset,
      ],
    );
    await sql.unsafe(
      `insert into telemetry.events (
         workspace_id, session_id, source_record_id, normalizer_version,
         projection_index, source_priority, event_kind, event_subtype,
         actor_role, occurred_at, observed_at, server_received_at, model,
         usage_stream_key, usage_scope, usage_is_cumulative,
         input_tokens, cached_input_tokens, output_tokens,
         reasoning_tokens, total_tokens, is_replay, canonical_scope_key, logical_event_key
       ) values (
         $1, $2, $3, $4, 0, $19, $5, $6,
         'primary', $7, $7, $17, $8,
         $9, $10, $11, $12, $13, $14, $15, $16, $18, $20, $21
       )`,
      [
        workspaceId,
        eventSessionId,
        record.id,
        normalizer,
        kind,
        subtype,
        occurredAt,
        model,
        kind === "usage" ? stream : null,
        kind === "usage" ? usageScope : null,
        kind === "usage" ? cumulative : null,
        kind === "usage" ? input : null,
        kind === "usage" ? cachedInput : null,
        kind === "usage" ? output : null,
        kind === "usage" ? reasoning : null,
        kind === "usage" ? total : null,
        serverReceivedAt,
        isReplay,
        priority,
        scope,
        logicalKey,
      ],
    );
    return record.id;
  };

  const context = (options) => insertEvent({
    ...options,
    kind: "lifecycle",
    subtype: "turn_context",
  });
  const usage = (options) => insertEvent({
    ...options,
    kind: "usage",
    model: options.model ?? "usage-event-model-must-not-win",
  });

  const source = new DirectFlameSource({
    databaseUrl: DATABASE_URL,
    workspaceId,
    expectedEmailDomain: "e3group.ai",
  });
  const directQuerySource = createSherlockQuerySource(source);
  const querySource = {
    ...directQuerySource,
    async fetchUsage(args) {
      if (parity) await expectUsageQueryParity(sql, workspaceId, args);
      return await directQuerySource.fetchUsage(args);
    },
  };
  return {
    workspaceId,
    personId,
    sessionId,
    sql,
    source,
    querySource,
    createBatch,
    async createSession({ startedAt, createdAt = startedAt }) {
      const id = crypto.randomUUID();
      await sql.unsafe(`insert into telemetry.sessions (
        id, workspace_id, person_id, collector_key, native_session_id,
        actor_role, role_version, model, started_at, created_at
      ) values ($1,$2,$3,'usage-reconciliation',$1::uuid::text,'primary','test.v1','model-A',$4,$5::text::timestamptz)`,
      [id, workspaceId, personId, startedAt, createdAt]);
      return id;
    },
    context,
    usage,
  };
}

async function disposeFixture(fixture) {
  if (!fixture) return;
  await fixture.source.close();
  try {
    await cleanup(fixture.sql, fixture.workspaceId);
  } finally {
    await fixture.sql.end({ timeout: 5 });
  }
}

async function fetchUsage(querySource, groupBy = "person_model") {
  return await querySource.fetchUsage({
    start: WINDOW_START,
    end: WINDOW_END,
    now: new Date(WINDOW_END),
    groupBy,
  });
}

function groupFor(result, model) {
  return result.groups.find((group) => group.model === model);
}

function expectCompleteCoverage(group) {
  expect(group.coverage).toEqual({
    state: "complete",
    reasons: [],
    excludedUsageEvents: 0,
    missingCumulativeBaselines: 0,
    regressedCumulativeStreams: 0,
    missingTokenComponents: [],
    missingModelObservations: 0,
    conflictingSourceEvents: 0,
  });
}

describePostgres("usage reconciliation PostgreSQL regressions", () => {
  beforeAll(async () => {
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      await sql.unsafe("grant sherlock_reader to postgres");
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it.each([
    { mode: "token_count only", native: false, counter: true, expectedEvents: 2 },
    { mode: "native response only", native: true, counter: false, expectedEvents: 2 },
    { mode: "both streams", native: true, counter: true, expectedEvents: 2 },
  ])("reconciles $mode without double counting response replays", async ({ native, counter, expectedEvents }) => {
    let fixture;
    try {
      fixture = await createFixture({ startedAt: WINDOW_START, parity: false });
      const batchId = await fixture.createBatch();
      await fixture.context({ batchId, recordIndex: 0, offset: 0, model: "model-A", normalizer: "sherlock.codex-rollout.v4", scope: "session" });
      if (counter) {
        await fixture.usage({ batchId, recordIndex: 1, offset: 10, subtype: "token_count", total: 100, normalizer: "sherlock.codex-rollout.v4", scope: "session" });
        await fixture.usage({ batchId, recordIndex: 2, offset: 20, subtype: "token_count", total: 150, normalizer: "sherlock.codex-rollout.v4", scope: "session" });
      }
      if (native) {
        for (const [recordIndex, offset, response, total, isReplay] of [
          [3, 30, "response-A", 100, false], [4, 40, "response-B", 50, false],
          [5, 50, "response-A", 100, false], [6, 60, "response-B", 50, true],
        ]) await fixture.usage({ batchId, recordIndex, offset, subtype: "token_usage_record", total,
          normalizer: "sherlock.codex-rollout.v4", cumulative: false, usageScope: "response",
          scope: "session", logicalKey: `usage:response:${response}`, stream: `session:response:${response}`, isReplay });
        // A transport generation replay with a different source_record_id is
        // also the same logical response, including outside the query window.
        const replayBatch = await fixture.createBatch();
        await fixture.usage({ batchId: replayBatch, recordIndex: 0, offset: 30,
          subtype: "token_usage_record", total: 100, normalizer: "sherlock.codex-rollout.v4",
          cumulative: false, usageScope: "response", scope: "session", logicalKey: "usage:response:response-A", stream: "session:response:response-A" });
      }
      const result = await fetchUsage(fixture.querySource);
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toMatchObject({ model: "model-A", knownTokens: { total: 150 }, usageEventCount: expectedEvents });
      expect(result.coverage.observedUsageEvents).toBe(expectedEvents);
      expect(await fixture.querySource.fetchCoverage({ start: WINDOW_START, end: WINDOW_END }))
        .toMatchObject({ observedSessions: 1, observedUsageEvents: expectedEvents });
    } finally { await disposeFixture(fixture); }
  });

  it("prefers token_count even outside the window, but replay-only counters do not suppress fallback", async () => {
    let fixture;
    try {
      fixture = await createFixture({ parity: false });
      const batchId = await fixture.createBatch();
      await fixture.usage({ batchId, recordIndex: 0, offset: 0, subtype: "token_count", total: 10,
        occurredAt: "2026-09-10T11:30:00Z", isReplay: true });
      await fixture.usage({ batchId, recordIndex: 1, offset: 10, subtype: "token_usage_record", total: 20,
        normalizer: "sherlock.codex-rollout.v4", cumulative: false, scope: "session", logicalKey: "usage:response:one" });
      expect((await fetchUsage(fixture.querySource)).groups[0].knownTokens.total).toBe(20);
      await fixture.usage({ batchId, recordIndex: 2, offset: 20, subtype: "token_count", total: 30,
        occurredAt: "2026-09-10T13:30:00Z" });
      expect((await fetchUsage(fixture.querySource)).groups).toEqual([]);
      expect(await fixture.querySource.fetchCoverage({ start: WINDOW_START, end: WINDOW_END }))
        .toMatchObject({ observedSessions: 0, observedUsageEvents: 0 });
    } finally { await disposeFixture(fixture); }
  });

  it("keeps an out-of-window original response from becoming new usage when replayed in-window", async () => {
    let fixture;
    try {
      fixture = await createFixture({ parity: false });
      const batchId = await fixture.createBatch();
      for (const [recordIndex, offset, occurredAt, response, total] of [
        [0, 0, "2026-09-10T11:59:00Z", "original", 100],
        [1, 10, SAME_TIME, "original", 100],
        [2, 20, SAME_TIME, "new", 50],
      ]) await fixture.usage({ batchId, recordIndex, offset, occurredAt, total,
        subtype: "token_usage_record", normalizer: "sherlock.codex-rollout.v4", cumulative: false,
        usageScope: "response", scope: "session", logicalKey: `usage:response:${response}`, stream: `session:response:${response}` });
      const result = await fetchUsage(fixture.querySource);
      expect(result.groups[0].knownTokens.total).toBe(50);
      expect(result.coverage.observedUsageEvents).toBe(1);
      expect(await fixture.querySource.fetchCoverage({ start: WINDOW_START, end: WINDOW_END }))
        .toMatchObject({ observedSessions: 1, observedUsageEvents: 1 });
    } finally { await disposeFixture(fixture); }
  });

  it("v4 supersedes old projections without adding cumulative totals at the version boundary", async () => {
    let fixture;
    try {
      fixture = await createFixture({ startedAt: WINDOW_START, parity: false });
      const batchId = await fixture.createBatch();
      const record = await fixture.usage({ batchId, recordIndex: 0, offset: 0, subtype: "token_count", total: 100, normalizer: "sherlock.codex-rollout.v3" });
      await fixture.usage({ batchId, recordIndex: 1, offset: 10, subtype: "token_count", total: 140,
        input: 70, cachedInput: 70, normalizer: "sherlock.codex-rollout.v4" });
      const result = await fetchUsage(fixture.querySource);
      expect(result.groups[0].knownTokens.total).toBe(140);
      expect(result.groups[0].knownTokens.input).toBe(100);
      expect(result.groups[0].coverage.missingTokenComponents).toEqual(["cachedInput", "input"]);
      // Operator reprocessing replaces the interpretation, preserving the old
      // fact/source link and restoring comparable component baselines.
      await fixture.usage({ batchId, recordIndex: 0, offset: 0, sourceRecordId: record, subtype: "token_count",
        total: 100, input: 50, cachedInput: 50, normalizer: "sherlock.codex-rollout.v4" });
      const backfilled = await fetchUsage(fixture.querySource);
      expect(backfilled.groups[0].knownTokens).toMatchObject({ total: 140, input: 70, cachedInput: 70 });
      expect(backfilled.coverage.observedUsageEvents).toBe(2);
      expect(await fixture.querySource.fetchCoverage({ start: WINDOW_START, end: WINDOW_END }))
        .toMatchObject({ observedSessions: 1, observedUsageEvents: 2 });
    } finally { await disposeFixture(fixture); }
  });

  it("lists resumed old sessions with stable microsecond pagination across mixed starts and activity", async () => {
    let fixture;
    try {
      fixture = await createFixture({ parity: false });
      const batchId = await fixture.createBatch();
      const fresh = await fixture.createSession({ startedAt: "2026-09-10T12:05:00Z", createdAt: "2026-09-10T12:05:00.123456Z" });
      const freshPeer = await fixture.createSession({ startedAt: "2026-09-10T12:05:00Z", createdAt: "2026-09-10T12:05:00.123455Z" });
      const tiedPeer = await fixture.createSession({ startedAt: "2026-09-10T12:05:00Z", createdAt: "2026-09-10T12:05:00.123455Z" });
      const lateReceipt = await fixture.createSession({ startedAt: "2026-09-09T12:00:00Z" });
      const replayOnly = await fixture.createSession({ startedAt: "2026-09-09T12:00:00Z" });
      const receivedOnly = await fixture.createSession({ startedAt: "2026-09-09T12:00:00Z" });
      const undated = await fixture.createSession({ startedAt: "2026-09-09T12:00:00Z" });
      for (const [recordIndex, eventSessionId, occurredAt, serverReceivedAt, isReplay] of [
        [0, fixture.sessionId, SAME_TIME, SAME_TIME, false],
        [1, fixture.sessionId, "2026-09-10T12:45:00Z", "2026-09-10T12:45:00Z", false],
        [2, replayOnly, SAME_TIME, SAME_TIME, true],
        [3, receivedOnly, "2026-09-09T12:00:00Z", SAME_TIME, false],
        [4, undated, null, SAME_TIME, false],
        [5, fresh, SAME_TIME, SAME_TIME, false],
        // Replay and end-exclusive boundary events cannot affect lastActivityAt.
        [6, fixture.sessionId, "2026-09-10T12:59:00Z", SAME_TIME, true],
        [7, fixture.sessionId, WINDOW_END, WINDOW_END, false],
        [8, lateReceipt, SAME_TIME, "2026-09-10T13:00:00.001Z", false],
      ]) await fixture.context({ batchId, recordIndex, offset: recordIndex * 10, eventSessionId, occurredAt, serverReceivedAt, isReplay });
      const args = { start: WINDOW_START, end: WINDOW_END, now: new Date(WINDOW_END), limit: 1 };
      const sessions = []; let cursor;
      do {
        const page = await fixture.querySource.fetchSessions({ ...args, cursor });
        sessions.push(...page.sessions); cursor = page.nextCursor;
      } while (cursor);
      expect(sessions.map((s) => s.sessionId)).toEqual([fresh, ...[freshPeer, tiedPeer].sort().reverse(), fixture.sessionId]);
      expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(4);
      expect(sessions[0].lastActivityAt).toBe(SAME_TIME);
      expect(sessions[1].lastActivityAt).toBeNull();
      expect(sessions[2].lastActivityAt).toBeNull();
      expect(sessions[3].lastActivityAt).toBe("2026-09-10T12:45:00.000Z");
      expect((await fixture.querySource.fetchSession({ sessionId: fixture.sessionId })).session.lastActivityAt).toBe(WINDOW_END);
    } finally { await disposeFixture(fixture); }
  });

  it("has valid partial usage indexes and bounds timestamp discovery in both plans", async () => {
    let fixture;
    try {
      fixture = await createFixture();
      const indexes = await fixture.sql.unsafe(`
        select c.relname, i.indisvalid, i.indisready, pg_get_indexdef(c.oid) definition
          from pg_index i join pg_class c on c.oid = i.indexrelid
         where c.oid in ('telemetry.events_usage_window_idx'::regclass,
                         'telemetry.events_usage_history_idx'::regclass,
                         'telemetry.events_usage_token_count_idx'::regclass)
      `);
      expect(indexes).toHaveLength(3);
      for (const index of indexes) {
        expect(index).toMatchObject({ indisvalid: true, indisready: true });
        expect(index.definition).toContain("NOT is_replay");
      }
      expect(indexes.find((i) => i.relname === "events_usage_window_idx").definition)
        .toContain("(workspace_id, occurred_at, session_id, id)");
      expect(indexes.find((i) => i.relname === "events_usage_history_idx").definition)
        .toContain("(workspace_id, session_id, occurred_at)");
      expect(indexes.find((i) => i.relname === "events_usage_token_count_idx").definition)
        .toContain("event_subtype = 'token_count'");
      const inspect = (value) => {
        if (!value || typeof value !== "object") return [];
        return [value, ...Object.values(value).flatMap(inspect)];
      };
      await fixture.sql.begin(async (tx) => {
        await tx.unsafe("set local role sherlock_reader; set local enable_seqscan = off");
        for (const [sql, params] of [
          [QUERY_USAGE_SQL, [fixture.workspaceId, WINDOW_START, WINDOW_END, "e3group.ai"]],
          [COVERAGE_SQL, [fixture.workspaceId, WINDOW_START, WINDOW_END, "e3group.ai",
            ["sherlock.codex-rollout.v1", "sherlock.codex-rollout.v2", "sherlock.codex-rollout.v3", "sherlock.claude-code-transcript.v1"]]],
        ]) {
          const [plan] = await tx.unsafe(`explain (format json) ${sql}`, params);
          const nodes = inspect(plan["QUERY PLAN"]);
          // Empty/tiny workspaces can legitimately favor the smaller history
          // index. Assert the timestamp bounds stay inside discovery, before
          // roster joins; the volume benchmark exercises the time index.
          const window = nodes.find((n) => ["CTE window_sessions", "CTE window_usage"].includes(n["Subplan Name"]));
          const predicates = inspect(window).filter((n) => n["Relation Name"] === "events")
            .map((n) => `${n["Index Cond"] ?? ""} ${n.Filter ?? ""}`).join(" ");
          expect(predicates).toContain("workspace_id =");
          expect(predicates).toContain("occurred_at >=");
          expect(predicates).toContain("occurred_at <");
        }
      });
    } finally {
      await disposeFixture(fixture);
    }
  });

  it.each([
    { name: "pre-cutover v1", cutoverAt: WINDOW_END, versions: [1, 2], total: 10 },
    { name: "pre-cutover v2 fallback", cutoverAt: WINDOW_END, versions: [2], total: 20 },
    { name: "replay v1 does not suppress v2 fallback", cutoverAt: WINDOW_END, versions: [2], total: 20, replayV1: true },
    { name: "pre-cutover v3 correction", cutoverAt: WINDOW_END, versions: [1, 2, 3], total: 30 },
    { name: "post-cutover v2", cutoverAt: "2026-09-10T10:00:00Z", versions: [1, 2], total: 20 },
    { name: "post-cutover v3 correction", cutoverAt: "2026-09-10T10:00:00Z", versions: [1, 2, 3], total: 30 },
    { name: "replay v3 does not suppress v1", cutoverAt: WINDOW_END, versions: [1, 2], total: 10, replayV3: true },
  ])("preserves old SQL results for $name without a v2-to-v3 cutover", async ({ cutoverAt, versions, total, replayV3, replayV1 }) => {
    let fixture;
    try {
      fixture = await createFixture({ startedAt: WINDOW_START, cutoverAt });
      const batchId = await fixture.createBatch();
      let sourceRecordId;
      for (const version of versions) {
        sourceRecordId = await fixture.usage({
          batchId, recordIndex: 0, offset: 0, sourceRecordId,
          normalizer: `sherlock.codex-rollout.v${version}`, total: version * 10,
          scope: "session", logicalKey: "same-usage",
        });
      }
      if (replayV1) await fixture.usage({
        batchId, recordIndex: 0, offset: 0, sourceRecordId,
        normalizer: "sherlock.codex-rollout.v1", total: 999, isReplay: true,
        scope: "session", logicalKey: "same-usage",
      });
      if (replayV3) await fixture.usage({
        batchId, recordIndex: 0, offset: 0, sourceRecordId,
        normalizer: "sherlock.codex-rollout.v3", total: 999, isReplay: true,
        scope: "session", logicalKey: "same-usage",
      });
      const result = await fetchUsage(fixture.querySource);
      expect(result.coverage.observedUsageEvents).toBe(1);
      expect(result.groups[0].knownTokens.total).toBe(total);
      expect(await fixture.querySource.fetchCoverage({ start: WINDOW_START, end: WINDOW_END }))
        .toMatchObject({ observedSessions: 1, observedUsageEvents: 1 });
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("preserves Claude message.id deduplication, out-of-window winners and replay exclusion", async () => {
    let fixture;
    try {
      fixture = await createFixture();
      const batchId = await fixture.createBatch({ provider: "claude_code" });
      const usage = (options) => fixture.usage({
        batchId, normalizer: "sherlock.claude-code-transcript.v1", cumulative: false,
        scope: "claude-session", model: "claude-opus", ...options,
      });
      await usage({ recordIndex: 0, offset: 0, logicalKey: "message:id-A:usage", total: 10, priority: 10 });
      await usage({ recordIndex: 1, offset: 10, logicalKey: "message:id-A:usage", total: 20 });
      await usage({ recordIndex: 2, offset: 20, logicalKey: "message:id-A:usage", total: 999, priority: 1000, isReplay: true });
      await usage({ recordIndex: 3, offset: 30, logicalKey: "message:id-B:usage", total: 40, priority: 10 });
      await usage({ recordIndex: 4, offset: 40, logicalKey: "message:id-B:usage", total: 50,
        occurredAt: "2026-09-10T13:01:00Z" });
      await usage({ recordIndex: 5, offset: 50, logicalKey: "message:id-C:usage", total: 30 });
      const result = await fetchUsage(fixture.querySource);
      expect(result.coverage.observedUsageEvents).toBe(2);
      expect(result.groups[0]).toMatchObject({ provider: "claude", knownTokens: { total: 50 } });
      expect(await fixture.querySource.fetchCoverage({ start: WINDOW_START, end: WINDOW_END }))
        .toMatchObject({ observedSessions: 1, observedUsageEvents: 2 });
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("attributes cumulative deltas to the preceding turn context by native source order", async () => {
    let fixture;
    try {
      fixture = await createFixture({ startedAt: "2026-09-10T12:00:00.000Z" });
      const batchId = await fixture.createBatch();

      // Insert in reverse semantic order with one timestamp. Database ids and
      // ingestion order must not override immutable source positions.
      await fixture.context({ batchId, recordIndex: 0, offset: 40, model: "ctx-C" });
      await fixture.usage({ batchId, recordIndex: 1, offset: 30, total: 150 });
      await fixture.context({ batchId, recordIndex: 2, offset: 20, model: "ctx-B" });
      await fixture.usage({ batchId, recordIndex: 3, offset: 10, total: 100 });
      await fixture.context({
        batchId,
        recordIndex: 4,
        offset: 0,
        model: "ctx-A",
        occurredAt: null,
      });

      const result = await fetchUsage(fixture.querySource);
      const groupA = groupFor(result, "ctx-A");
      const groupB = groupFor(result, "ctx-B");

      expect(result.groups).toHaveLength(2);
      expect(groupA).toMatchObject({
        tokens: { input: 100, cachedInput: 0, output: 0, reasoning: 0, total: 100 },
        knownTokens: { input: 100, cachedInput: 0, output: 0, reasoning: 0, total: 100 },
        usageEventCount: 1,
      });
      expect(groupB).toMatchObject({
        tokens: { input: 50, cachedInput: 0, output: 0, reasoning: 0, total: 50 },
        knownTokens: { input: 50, cachedInput: 0, output: 0, reasoning: 0, total: 50 },
        usageEventCount: 1,
      });
      expect(groupFor(result, "ctx-C")).toBeUndefined();
      expectCompleteCoverage(groupA);
      expectCompleteCoverage(groupB);
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  it("keeps pre-regression model usage exact and excludes the poisoned suffix", async () => {
    let fixture;
    try {
      fixture = await createFixture();
      const batchId = await fixture.createBatch();
      await fixture.context({
        batchId, recordIndex: 0, offset: 0, model: "ctx-A",
        occurredAt: "2026-09-10T11:30:00.000Z",
      });
      await fixture.usage({
        batchId, recordIndex: 1, offset: 10, total: 100,
        occurredAt: "2026-09-10T11:40:00.000Z",
      });
      await fixture.usage({
        batchId, recordIndex: 2, offset: 20, total: 120,
        occurredAt: "2026-09-10T12:10:00.000Z",
      });
      await fixture.context({
        batchId, recordIndex: 3, offset: 30, model: "ctx-B",
        occurredAt: "2026-09-10T12:20:00.000Z",
      });
      await fixture.usage({
        batchId, recordIndex: 4, offset: 40, total: 40,
        occurredAt: "2026-09-10T12:30:00.000Z",
      });
      await fixture.usage({
        batchId, recordIndex: 5, offset: 50, total: 110,
        occurredAt: "2026-09-10T12:40:00.000Z",
      });

      const byModel = await fetchUsage(fixture.querySource);
      const groupA = groupFor(byModel, "ctx-A");
      const groupB = groupFor(byModel, "ctx-B");
      expect(groupA.tokens).toEqual({
        input: 20, cachedInput: 0, output: 0, reasoning: 0, total: 20,
      });
      expect(groupA.knownTokens).toEqual(groupA.tokens);
      expectCompleteCoverage(groupA);
      expect(groupB).toMatchObject({
        tokens: { input: null, cachedInput: null, output: null, reasoning: null, total: null },
        knownTokens: ZERO_TOKENS,
        usageEventCount: 2,
        coverage: {
          state: "partial",
          reasons: ["cumulative_counter_regressed"],
          excludedUsageEvents: 2,
          missingCumulativeBaselines: 0,
          regressedCumulativeStreams: 1,
          missingTokenComponents: [],
          missingModelObservations: 0,
        },
      });

      const byPerson = await fetchUsage(fixture.querySource, "person");
      expect(byPerson.groups).toHaveLength(1);
      expect(byPerson.groups[0]).toMatchObject({
        personId: fixture.personId,
        tokens: { input: null, cachedInput: null, output: null, reasoning: null, total: null },
        knownTokens: { input: 20, cachedInput: 0, output: 0, reasoning: 0, total: 20 },
        usageEventCount: 3,
        coverage: {
          state: "partial",
          reasons: ["cumulative_counter_regressed"],
          excludedUsageEvents: 2,
          regressedCumulativeStreams: 1,
        },
      });
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  it("carries a pre-window regression forward as unknown arithmetic", async () => {
    let fixture;
    try {
      fixture = await createFixture();
      const batchId = await fixture.createBatch();
      await fixture.context({
        batchId, recordIndex: 0, offset: 0, model: "ctx-A",
        occurredAt: "2026-09-10T11:10:00.000Z",
      });
      await fixture.usage({
        batchId, recordIndex: 1, offset: 10, total: 100,
        occurredAt: "2026-09-10T11:20:00.000Z",
      });
      await fixture.usage({
        batchId, recordIndex: 2, offset: 20, total: 40,
        occurredAt: "2026-09-10T11:30:00.000Z",
      });
      await fixture.usage({
        batchId, recordIndex: 3, offset: 30, total: 110,
        occurredAt: "2026-09-10T12:10:00.000Z",
      });

      const group = groupFor(await fetchUsage(fixture.querySource), "ctx-A");
      expect(group).toMatchObject({
        tokens: { input: null, cachedInput: null, output: null, reasoning: null, total: null },
        knownTokens: ZERO_TOKENS,
        usageEventCount: 1,
        coverage: {
          state: "partial",
          reasons: ["cumulative_counter_regressed"],
          excludedUsageEvents: 1,
          missingCumulativeBaselines: 0,
          regressedCumulativeStreams: 1,
        },
      });
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  it("taints the suffix when one component regresses despite a rising total", async () => {
    let fixture;
    try {
      fixture = await createFixture({ startedAt: "2026-09-10T12:00:00.000Z" });
      const batchId = await fixture.createBatch();
      await fixture.context({ batchId, recordIndex: 0, offset: 0, model: "ctx-A" });
      await fixture.usage({
        batchId,
        recordIndex: 1,
        offset: 10,
        input: 100,
        cachedInput: 100,
        output: 0,
        reasoning: 0,
        total: 200,
      });
      await fixture.usage({
        batchId,
        recordIndex: 2,
        offset: 20,
        input: 90,
        cachedInput: 130,
        output: 0,
        reasoning: 0,
        total: 220,
      });

      const group = groupFor(await fetchUsage(fixture.querySource), "ctx-A");
      expect(group).toMatchObject({
        tokens: { input: null, cachedInput: null, output: null, reasoning: null, total: null },
        knownTokens: {
          input: 100,
          cachedInput: 100,
          output: 0,
          reasoning: 0,
          total: 200,
        },
        usageEventCount: 2,
        coverage: {
          state: "partial",
          reasons: ["cumulative_counter_regressed"],
          excludedUsageEvents: 1,
          missingCumulativeBaselines: 0,
          regressedCumulativeStreams: 1,
          missingTokenComponents: [],
          missingModelObservations: 0,
          conflictingSourceEvents: 0,
        },
      });
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  it("conserves cumulative usage across adjacent windows when timestamps run backward", async () => {
    let fixture;
    try {
      fixture = await createFixture({ startedAt: "2026-09-10T09:00:00.000Z" });
      const batchId = await fixture.createBatch();
      await fixture.context({
        batchId,
        recordIndex: 0,
        offset: 0,
        model: "ctx-A",
        occurredAt: "2026-09-10T09:00:00.000Z",
      });
      await fixture.usage({
        batchId,
        recordIndex: 1,
        offset: 10,
        total: 0,
        occurredAt: "2026-09-10T09:30:00.000Z",
      });
      await fixture.usage({
        batchId,
        recordIndex: 2,
        offset: 20,
        total: 100,
        occurredAt: "2026-09-10T11:30:00.000Z",
      });
      await fixture.usage({
        batchId,
        recordIndex: 3,
        offset: 30,
        total: 150,
        occurredAt: "2026-09-10T10:30:00.000Z",
      });

      const fetchWindow = async (start, end) => await fixture.querySource.fetchUsage({
        start,
        end,
        now: new Date("2026-09-10T12:00:00.000Z"),
      });
      const first = groupFor(await fetchWindow(
        "2026-09-10T10:00:00.000Z",
        "2026-09-10T11:00:00.000Z",
      ), "ctx-A");
      const second = groupFor(await fetchWindow(
        "2026-09-10T11:00:00.000Z",
        "2026-09-10T12:00:00.000Z",
      ), "ctx-A");
      const combined = groupFor(await fetchWindow(
        "2026-09-10T10:00:00.000Z",
        "2026-09-10T12:00:00.000Z",
      ), "ctx-A");

      expect(first).toMatchObject({
        tokens: { input: 50, cachedInput: 0, output: 0, reasoning: 0, total: 50 },
        knownTokens: { input: 50, cachedInput: 0, output: 0, reasoning: 0, total: 50 },
        usageEventCount: 1,
      });
      expect(second).toMatchObject({
        tokens: { input: 100, cachedInput: 0, output: 0, reasoning: 0, total: 100 },
        knownTokens: { input: 100, cachedInput: 0, output: 0, reasoning: 0, total: 100 },
        usageEventCount: 1,
      });
      expect(combined).toMatchObject({
        tokens: { input: 150, cachedInput: 0, output: 0, reasoning: 0, total: 150 },
        knownTokens: { input: 150, cachedInput: 0, output: 0, reasoning: 0, total: 150 },
        usageEventCount: 2,
      });
      expect(first.tokens.total + second.tokens.total).toBe(combined.tokens.total);
      expectCompleteCoverage(first);
      expectCompleteCoverage(second);
      expectCompleteCoverage(combined);
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  it("keeps the accepted prefix but nulls totals after partially overlapping source ranges", async () => {
    let fixture;
    try {
      fixture = await createFixture({ startedAt: "2026-09-10T12:00:00.000Z" });
      const original = await fixture.createBatch({
        sourceStreamKey: "transport-original",
        generationKey: "generation-original",
      });
      const overlap = await fixture.createBatch({
        sourceStreamKey: "transport-overlap",
        generationKey: "generation-overlap",
      });
      await fixture.context({
        batchId: original,
        recordIndex: 0,
        offset: 0,
        model: "ctx-A",
      });
      await fixture.usage({
        batchId: original,
        recordIndex: 1,
        offset: 10,
        endOffset: 11,
        recordHash: hash(900),
        total: 50,
      });
      await fixture.usage({
        batchId: original,
        recordIndex: 2,
        offset: 20,
        endOffset: 30,
        recordHash: hash(901),
        total: 100,
      });
      await fixture.usage({
        batchId: overlap,
        recordIndex: 0,
        offset: 25,
        endOffset: 35,
        recordHash: hash(902),
        total: 120,
      });
      await fixture.usage({
        batchId: overlap,
        recordIndex: 1,
        offset: 40,
        endOffset: 41,
        recordHash: hash(903),
        total: 150,
      });

      const result = await fetchUsage(fixture.querySource, "person");
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toMatchObject({
        personId: fixture.personId,
        tokens: { input: null, cachedInput: null, output: null, reasoning: null, total: null },
        knownTokens: { input: 50, cachedInput: 0, output: 0, reasoning: 0, total: 50 },
        usageEventCount: 4,
        coverage: {
          state: "partial",
          reasons: expect.arrayContaining(["source_record_conflict"]),
          excludedUsageEvents: 3,
          conflictingSourceEvents: 3,
        },
      });
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  it("deduplicates overlapping uploads by immutable native identity", async () => {
    let fixture;
    try {
      fixture = await createFixture({ startedAt: "2026-09-10T12:00:00.000Z" });
      const original = await fixture.createBatch({
        sourceStreamKey: "transport-original",
        generationKey: "generation-original",
      });
      const overlap = await fixture.createBatch({
        sourceStreamKey: "transport-overlap",
        generationKey: "generation-overlap",
      });
      await fixture.context({
        batchId: original, recordIndex: 0, offset: 0, recordHash: hash(700), model: "ctx-A",
      });
      await fixture.usage({
        batchId: original, recordIndex: 1, offset: 10, recordHash: hash(701), total: 100,
      });
      await fixture.usage({
        batchId: overlap, recordIndex: 0, offset: 10, recordHash: hash(701), total: 100,
      });
      // The content hash and timestamp repeat, but a different native offset is
      // a different record and must remain visible.
      await fixture.usage({
        batchId: overlap, recordIndex: 1, offset: 20, recordHash: hash(701), total: 100,
      });

      const rawBefore = await fixture.sql.unsafe(
        `select count(*)::integer as count
           from telemetry.events
          where workspace_id = $1 and event_kind = 'usage'`,
        [fixture.workspaceId],
      );
      const group = groupFor(await fetchUsage(fixture.querySource), "ctx-A");
      expect(group).toMatchObject({
        tokens: { input: 100, cachedInput: 0, output: 0, reasoning: 0, total: 100 },
        knownTokens: { input: 100, cachedInput: 0, output: 0, reasoning: 0, total: 100 },
        usageEventCount: 2,
      });
      expectCompleteCoverage(group);
      const rawAfter = await fixture.sql.unsafe(
        `select count(*)::integer as count
           from telemetry.events
          where workspace_id = $1 and event_kind = 'usage'`,
        [fixture.workspaceId],
      );
      expect(rawBefore[0].count).toBe(3);
      expect(rawAfter[0].count).toBe(3);
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  it("uses unknown when no turn context precedes Codex usage", async () => {
    let fixture;
    try {
      fixture = await createFixture({ startedAt: "2026-09-10T12:00:00.000Z" });
      const batchId = await fixture.createBatch();
      await fixture.usage({
        batchId,
        recordIndex: 0,
        offset: 10,
        total: 25,
        model: "usage-event-model-must-not-win",
      });

      const result = await fetchUsage(fixture.querySource);
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toMatchObject({
        model: "unknown",
        tokens: { input: 25, cachedInput: 0, output: 0, reasoning: 0, total: 25 },
        knownTokens: { input: 25, cachedInput: 0, output: 0, reasoning: 0, total: 25 },
        coverage: {
          state: "partial",
          reasons: ["model_context_missing"],
          excludedUsageEvents: 0,
          missingCumulativeBaselines: 0,
          regressedCumulativeStreams: 0,
          missingTokenComponents: [],
          missingModelObservations: 1,
        },
      });
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  it("returns null tokens and an empty accepted prefix without a cumulative baseline", async () => {
    let fixture;
    try {
      fixture = await createFixture();
      const batchId = await fixture.createBatch();
      await fixture.context({
        batchId, recordIndex: 0, offset: 0, model: "ctx-A",
        occurredAt: "2026-09-10T11:30:00.000Z",
      });
      await fixture.usage({
        batchId, recordIndex: 1, offset: 10, total: 80,
        occurredAt: "2026-09-10T12:10:00.000Z",
      });

      const group = groupFor(await fetchUsage(fixture.querySource), "ctx-A");
      expect(group).toMatchObject({
        tokens: { input: null, cachedInput: null, output: null, reasoning: null, total: null },
        knownTokens: ZERO_TOKENS,
        coverage: {
          state: "partial",
          reasons: ["cumulative_baseline_missing"],
          excludedUsageEvents: 1,
          missingCumulativeBaselines: 1,
          regressedCumulativeStreams: 0,
          missingTokenComponents: [],
          missingModelObservations: 0,
        },
      });
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  it("nulls only a missing token component", async () => {
    let fixture;
    try {
      fixture = await createFixture({ startedAt: "2026-09-10T12:00:00.000Z" });
      const batchId = await fixture.createBatch();
      await fixture.context({ batchId, recordIndex: 0, offset: 0, model: "ctx-A" });
      await fixture.usage({
        batchId,
        recordIndex: 1,
        offset: 10,
        total: 10,
        output: null,
      });

      const group = groupFor(await fetchUsage(fixture.querySource), "ctx-A");
      expect(group).toMatchObject({
        tokens: { input: 10, cachedInput: 0, output: null, reasoning: 0, total: 10 },
        knownTokens: { input: 10, cachedInput: 0, output: 0, reasoning: 0, total: 10 },
        coverage: {
          state: "partial",
          reasons: ["token_component_missing"],
          excludedUsageEvents: 1,
          missingCumulativeBaselines: 0,
          regressedCumulativeStreams: 0,
          missingTokenComponents: ["output"],
          missingModelObservations: 0,
        },
      });
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  it("marks conflicting bytes at one native range unknown without mutating raw facts", async () => {
    let fixture;
    try {
      fixture = await createFixture({ startedAt: "2026-09-10T12:00:00.000Z" });
      const original = await fixture.createBatch({
        sourceStreamKey: "transport-original",
        generationKey: "generation-original",
      });
      const conflicting = await fixture.createBatch({
        sourceStreamKey: "transport-conflicting",
        generationKey: "generation-conflicting",
      });
      await fixture.context({
        batchId: original, recordIndex: 0, offset: 0, recordHash: hash(800), model: "ctx-A",
      });
      await fixture.usage({
        batchId: original, recordIndex: 1, offset: 10, recordHash: hash(801), total: 100,
      });
      await fixture.usage({
        batchId: conflicting, recordIndex: 0, offset: 10, recordHash: hash(802), total: 120,
      });

      const result = await fetchUsage(fixture.querySource);
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toMatchObject({
        model: "unknown",
        tokens: { input: null, cachedInput: null, output: null, reasoning: null, total: null },
        knownTokens: ZERO_TOKENS,
        coverage: {
          state: "partial",
          reasons: ["source_record_conflict", "model_context_missing"],
          excludedUsageEvents: 2,
          missingCumulativeBaselines: 0,
          regressedCumulativeStreams: 0,
          missingTokenComponents: [],
          missingModelObservations: 2,
          conflictingSourceEvents: 2,
        },
      });
      const raw = await fixture.sql.unsafe(
        `select count(*)::integer as count
           from telemetry.events
          where workspace_id = $1 and event_kind = 'usage'`,
        [fixture.workspaceId],
      );
      expect(raw[0].count).toBe(2);
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);
});
