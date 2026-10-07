import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";

import {
  DirectFlameSource,
  NORMALIZER_VERSION,
} from "./flame-source.js";
import { createSherlockQuerySource } from "./mcp-query-source.js";

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

async function createFixture({ startedAt = "2026-09-10T11:00:00.000Z" } = {}) {
  const workspaceId = crypto.randomUUID();
  const personId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const nativeSessionId = `native-${sessionId}`;
  const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
  let batchSequence = 0;

  await sql.unsafe(
    `insert into telemetry.workspaces (id, slug, name)
     values ($1, $2, 'Usage reconciliation fixture')`,
    [workspaceId, `usage-reconciliation-${workspaceId}`],
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
         'codex', 'rollout', $5, $6,
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
  }) => {
    const [record] = await sql.unsafe(
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
         reasoning_tokens, total_tokens
       ) values (
         $1, $2, $3, $4, 0, 100, $5, $6,
         'primary', $7, $7, $17, $8,
         $9, $10, $11, $12, $13, $14, $15, $16
       )`,
      [
        workspaceId,
        sessionId,
        record.id,
        NORMALIZER_VERSION,
        kind,
        subtype,
        occurredAt,
        model,
        kind === "usage" ? stream : null,
        kind === "usage" ? "session" : null,
        kind === "usage" ? cumulative : null,
        kind === "usage" ? input : null,
        kind === "usage" ? cachedInput : null,
        kind === "usage" ? output : null,
        kind === "usage" ? reasoning : null,
        kind === "usage" ? total : null,
        serverReceivedAt,
      ],
    );
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
  const querySource = createSherlockQuerySource(source);
  return {
    workspaceId,
    personId,
    sessionId,
    sql,
    source,
    querySource,
    createBatch,
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
