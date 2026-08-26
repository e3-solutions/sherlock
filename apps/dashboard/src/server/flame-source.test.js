import { describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_REPRESENTATION_NEIGHBORHOOD_SECONDS,
  BUCKET_COUNT,
  BUCKET_MS,
  CLAUDE_NORMALIZER_VERSION,
  COMPATIBLE_WORK_FRAME_VERSION,
  DEFAULT_WORK_DETAIL_LIMIT,
  FRAME_VERSION,
  FRESHNESS_NORMALIZER_VERSIONS,
  FRESHNESS_SQL,
  FLAME_SQL,
  INTERVAL_PROMPTS_SQL,
  INTERVAL_PULL_REQUESTS_SQL,
  INTERVAL_PROMPT_LIMIT,
  INTERVAL_WORK_SQL,
  LEGACY_NORMALIZER_VERSIONS,
  MAX_WORK_DETAIL_LIMIT,
  MCP_PROMPT_EVIDENCE_LIMIT,
  NORMALIZER_VERSION,
  NORMALIZER_VERSIONS,
  PEOPLE_SQL,
  PREFERRED_DASHBOARD_EMAIL_DOMAIN,
  PROJECTION_FLAME_SQL,
  PROJECTION_INTERVAL_PROMPTS_SQL,
  PROJECTION_INTERVAL_WORK_SQL,
  PROJECTION_WORK_DETAIL_SQL,
  SIXTYFOUR_DASHBOARD_EMAIL_DOMAIN,
  WORK_DETAIL_SQL,
  ASSISTANT_REPRESENTATION_MATCH_SECONDS,
  DirectFlameSource,
  UNKEYED_PROMPT_REPRESENTATION_MILLISECONDS,
  UNKEYED_PROMPT_MATCH_SECONDS,
  FlameSourceError,
  buildFlamePayload,
  buildFreshnessPayload,
  dashboardWorkSummary,
  decodeWorkCursor,
  decodeSnapshotToken,
  encodeWorkCursor,
  encodeProjectionSnapshotToken,
  encodeSnapshotToken,
  validateDashboardEmailDomain,
} from "./flame-source.js";

const START = new Date("2026-08-16T12:00:00.000Z");
const READ = new Date("2026-08-17T12:00:01.000Z");
const PG_SNAPSHOT = "730:741:733,739";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PERSON_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SNAPSHOT = encodeSnapshotToken({ snapshot: PG_SNAPSHOT, read: READ });

function mockSource(...results) {
  const source = Object.create(DirectFlameSource.prototype);
  source.workspaceId = WORKSPACE_ID;
  const unsafe = vi.fn();
  for (const result of results) unsafe.mockResolvedValueOnce(result);
  const array = vi.fn((values) => values);
  source.transaction = (callback) => callback({ unsafe, array });
  return { source, unsafe, array };
}

function workRequest(overrides = {}) {
  return {
    personId: PERSON_ID, start: START.toISOString(), sessionId: SESSION_ID,
    role: "agent", snapshot: SNAPSHOT, ...overrides,
  };
}

function rowsFor(personId, overrides = {}) {
  return Array.from({ length: BUCKET_COUNT }, (_, index) => ({
    person_id: personId,
    bucket_start: new Date(START.getTime() + index * BUCKET_MS),
    agent: 0,
    subagent: 0,
    other: 0,
    prompts: 0,
    day_agent: 0,
    day_subagent: 0,
    day_other: 0,
    latest: null,
    latest_activity: null,
    ...overrides[index],
  }));
}

function expectSqlInOrder(sql, ...fragments) {
  let previousIndex = -1;
  for (const fragment of fragments) {
    const index = sql.indexOf(fragment, previousIndex + 1);
    expect(index).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

describe("Sherlock Flame payload", () => {
  it("renders human summaries while rejecting reserved runtime context", () => {
    expect(dashboardWorkSummary("  Ship the dashboard fix  ")).toBe(
      "Ship the dashboard fix",
    );
    expect(dashboardWorkSummary("   ")).toBeNull();
    expect(dashboardWorkSummary("<recommended_plugins>machine context"))
      .toBeNull();
    expect(dashboardWorkSummary("<environment_context>machine context"))
      .toBeNull();
    expect(dashboardWorkSummary("<order>human-authored XML</order>"))
      .toBe("<order>human-authored XML</order>");
  });

  it("maps the live user-visible freshness aggregate without exposing private queue rows", () => {
    const payload = buildFreshnessPayload([{
      read_at: "2026-08-17T12:10:00.000Z",
      raw_watermark: "2026-08-17T12:09:00.000Z",
      canonical_watermark: "2026-08-17T12:08:00.000Z",
      oldest_pending_normalize: "2026-08-17T12:00:00.000Z",
      pending_normalize_count: "3",
      person_id: "ada",
      latest_canonical_activity: "2026-08-17T12:07:00.000Z",
    }], 500);

    expect(payload).toEqual({
      read: "2026-08-17T12:10:00.000Z",
      rawWatermark: "2026-08-17T12:09:00.000Z",
      canonicalWatermark: "2026-08-17T12:08:00.000Z",
      oldestPendingNormalize: "2026-08-17T12:00:00.000Z",
      pendingNormalize: 3,
      delayed: true,
      people: [{ id: "ada", lastActivity: "2026-08-17T12:07:00.000Z" }],
    });
    expect(FRESHNESS_SQL).toContain("analytics.read_dashboard_freshness");
    expect(FRESHNESS_SQL).not.toContain("processing.telemetry_jobs");
  });

  it("rejects inconsistent or duplicate freshness roster rows", () => {
    const row = {
      read_at: READ,
      raw_watermark: null,
      canonical_watermark: null,
      oldest_pending_normalize: null,
      pending_normalize_count: 0,
      person_id: "ada",
      latest_canonical_activity: null,
    };
    expect(() => buildFreshnessPayload([{ ...row }, { ...row }], 500))
      .toThrow(FlameSourceError);
    expect(() => buildFreshnessPayload([{ ...row, pending_normalize_count: 1 }], 500))
      .toThrow(FlameSourceError);
  });

  it("fetches freshness through the narrow reader function in a bounded transaction", async () => {
    const row = {
      read_at: READ,
      raw_watermark: null,
      canonical_watermark: null,
      oldest_pending_normalize: null,
      pending_normalize_count: 0,
      person_id: null,
      latest_canonical_activity: null,
    };
    const unsafe = vi.fn().mockResolvedValue([row]);
    const source = Object.create(DirectFlameSource.prototype);
    Object.assign(source, {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      expectedEmailDomain: "e3group.ai",
      maxPeople: 500,
      transaction: (callback, options) => {
        expect(options.statementTimeoutMs).toBe(10_000);
        return callback({ unsafe, array: (values) => ({ values }) });
      },
    });

    await expect(source.fetchFreshness()).resolves.toMatchObject({ people: [] });
    expect(unsafe).toHaveBeenCalledWith(FRESHNESS_SQL, [
      source.workspaceId,
      source.expectedEmailDomain,
      { values: FRESHNESS_NORMALIZER_VERSIONS },
      500,
    ]);
  });
  it("preserves the full roster, exact buckets, roles, prompts, and partial receipt", () => {
    const ada = rowsFor("ada", {
      0: {
        agent: 1,
        subagent: 2,
        other: 1,
        prompts: 3,
        day_agent: 1,
        day_subagent: 2,
        day_other: 1,
        latest: new Date("2026-08-16T12:09:00.000Z"),
        latest_activity: new Date("2026-08-16T12:08:00.000Z"),
      },
    });
    for (const row of ada) {
      row.day_agent = 1;
      row.day_subagent = 2;
      row.day_other = 1;
      row.latest = new Date("2026-08-16T12:09:00.000Z");
      row.latest_activity = new Date("2026-08-16T12:08:00.000Z");
    }
    const zero = rowsFor("zero");
    const payload = buildFlamePayload({
      rows: [...ada, ...zero],
      roster: [
        { person_id: "ada", display_name: "Ada" },
        { person_id: "zero", display_name: "Zero Activity" },
      ],
      start: START,
      read: READ,
      snapshot: PG_SNAPSHOT,
    });

    expect(payload.people).toHaveLength(2);
    expect(payload.people[0]).toMatchObject({
      id: "ada",
      lastActivity: "2026-08-16T12:08:00.000Z",
      activeSeconds: 600,
      total: [1, 2, 1],
    });
    expect(payload.people[0].buckets[0]).toEqual([1, 2, 1, 3]);
    expect(payload.people[1].buckets).toHaveLength(BUCKET_COUNT);
    expect(payload.people[1].buckets.every((bucket) =>
      bucket.every((value) => value === 0)
    )).toBe(true);
    expect(payload.coverage).toEqual({
      evidence: "observed_events",
      state: "partial",
      reason: "event_presence_not_continuous_attention",
    });
    expect(decodeSnapshotToken(payload.snapshot)).toEqual({
      snapshot: PG_SNAPSHOT,
      read: READ,
      normalizerVersions: NORMALIZER_VERSIONS,
    });
  });

  it("checks source read access before reporting ready", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    const unsafe = vi.fn().mockResolvedValueOnce([{
      backend_role: true,
      read_only: true,
      can_read_people: true,
      can_read_events: true,
    }]);
    source.transaction = (callback) => callback({ unsafe });

    await expect(source.readiness()).resolves.toEqual({
      status: "ok",
      mode: "sherlock_backend_aggregate",
    });
    expect(unsafe.mock.calls[0][0]).not.toContain("analytics.activity_spans");
  });

  it("configures default source transactions before pinning the read-only role", async () => {
    const unsafe = vi.fn().mockResolvedValue([]);
    const source = Object.create(DirectFlameSource.prototype);
    source.sql = { begin: (callback) => callback({ unsafe }) };

    await source.transaction(async () => "ok");

    expect(unsafe.mock.calls).toEqual([
      ["set transaction isolation level repeatable read, read only"],
      ["select set_config('statement_timeout', $1, true)", ["20000"]],
      ["set local role sherlock_reader"],
    ]);
  });

  it("allows a source transaction to select a 30-second statement timeout", async () => {
    const unsafe = vi.fn().mockResolvedValue([]);
    const source = Object.create(DirectFlameSource.prototype);
    source.sql = { begin: (callback) => callback({ unsafe }) };

    await source.transaction(async () => "ok", { statementTimeoutMs: 30_000 });

    expect(unsafe.mock.calls[1]).toEqual([
      "select set_config('statement_timeout', $1, true)",
      ["30000"],
    ]);
  });

  it("rejects incomplete result grids", () => {
    expect(() => buildFlamePayload({
      rows: rowsFor("ada").slice(1),
      roster: [{ person_id: "ada", display_name: "Ada" }],
      start: START,
      read: START,
      snapshot: PG_SNAPSHOT,
    })).toThrow(FlameSourceError);
  });

  it("returns a valid empty payload for a new workspace", () => {
    const payload = buildFlamePayload({
      rows: [],
      roster: [],
      start: START,
      read: READ,
      snapshot: PG_SNAPSHOT,
    });

    expect(payload).toMatchObject({
      start: START.toISOString(),
      read: READ.toISOString(),
      latest: null,
      people: [],
    });
    expect(decodeSnapshotToken(payload.snapshot)).toEqual({
      snapshot: PG_SNAPSHOT,
      read: READ,
      normalizerVersions: NORMALIZER_VERSIONS,
    });
    expect(() => buildFlamePayload({
      rows: [{ person_id: "unexpected" }],
      roster: [],
      start: START,
      read: READ,
      snapshot: PG_SNAPSHOT,
    })).toThrow(FlameSourceError);
  });

  it("keeps observed-event buckets without querying inferred activity spans", () => {
    expect(FLAME_SQL).toContain("e.workspace_id = p.workspace_id");
    expect(FLAME_SQL).toContain("date_bin(interval '10 minutes', a.observed_at");
    expect(FLAME_SQL).toContain("e.actor_role = 'primary'");
    expect(FLAME_SQL).not.toContain("s.actor_role = 'primary'");
    expect(FLAME_SQL).toContain("e.actor_role <> 'automation'");
    expect(FLAME_SQL).toContain(
      "e.actor_role = 'unknown' and s.parent_session_id is not null",
    );
    expect(FLAME_SQL).toContain("then 'worker' else e.actor_role end actor_role");
    expect(FLAME_SQL).toContain("$5::timestamptz read_at");
    expect(FLAME_SQL).toContain(") < p.read_at");
    expect(FLAME_SQL).toContain("max(a.observed_at) latest_activity");
    expect(FLAME_SQL).toContain("where a.observed_at < p.end_at");
    expect(FLAME_SQL).toContain("s.started_at session_started_at");
    expect(FLAME_SQL).toContain("'task_started', 'task_complete', 'turn_started', 'turn_complete'");
    expect(FLAME_SQL).not.toContain("analytics.activity_spans");
    expect(FLAME_SQL).toContain("$1::uuid");
    expect(FLAME_SQL).not.toContain("e.content_excerpt,");
    expect(FLAME_SQL).toContain("native_prompt_candidate");
  });

  it("excludes guardians only after canonical activity winners are selected", () => {
    expectSqlInOrder(
      FLAME_SQL,
      "activity_candidates as materialized",
      "activity_events as materialized",
      "where canonical_rank = 1",
      "and actor_role <> 'guardian'",
      "bucket_activity as materialized",
    );
    expect(FLAME_SQL).toContain("where a.actor_role = 'worker'");

    for (const sql of [INTERVAL_WORK_SQL, WORK_DETAIL_SQL]) {
      expectSqlInOrder(
        sql,
        "activity_candidates as materialized",
        "activity_event_ids as materialized",
        "where canonical_rank = 1",
        "and actor_role <> 'guardian'",
        "activity_events as materialized",
      );
      expect(sql).toContain("when actor_role = 'worker' then 'subagent'");
    }
  });

  it("reads supported provider projections without canonicalizing across versions", () => {
    expect(NORMALIZER_VERSIONS).toEqual([
      NORMALIZER_VERSION,
      CLAUDE_NORMALIZER_VERSION,
    ]);
    for (const sql of [FLAME_SQL, INTERVAL_WORK_SQL, WORK_DETAIL_SQL]) {
      expect(sql).toContain("$4::text[] normalizer_versions");
      expect(sql).toContain("e.normalizer_version = any(p.normalizer_versions)");
      expect(sql).toContain("e.normalizer_version, e.logical_event_key, e.event_kind");
    }
  });

  it("returns zero active seconds for roster members without observed sessions", () => {
    const payload = buildFlamePayload({
      rows: rowsFor("zero"),
      roster: [{ person_id: "zero", display_name: "Zero Activity" }],
      start: START,
      read: READ,
      snapshot: PG_SNAPSHOT,
    });
    expect(payload.people[0].activeSeconds).toBe(0);
  });

  it("counts one occupied bucket once despite parallel session counts", () => {
    const payload = buildFlamePayload({
      rows: rowsFor("ada", {
        0: {
          agent: 3,
          subagent: 2,
          other: 4,
          day_agent: 3,
          day_subagent: 2,
          day_other: 4,
        },
      }),
      roster: [{ person_id: "ada", display_name: "Ada" }],
      start: START,
      read: READ,
      snapshot: PG_SNAPSHOT,
    });

    expect(payload.people[0].activeSeconds).toBe(600);
  });

  it("adds separated occupied buckets without filling the gap", () => {
    const payload = buildFlamePayload({
      rows: rowsFor("ada", {
        0: { agent: 1, day_agent: 1, day_subagent: 1 },
        12: { subagent: 1 },
      }),
      roster: [{ person_id: "ada", display_name: "Ada" }],
      start: START,
      read: READ,
      snapshot: PG_SNAPSHOT,
    });

    expect(payload.people[0].activeSeconds).toBe(1_200);
  });

  it("does not count a prompt-only bucket as observed session time", () => {
    const payload = buildFlamePayload({
      rows: rowsFor("ada", { 0: { prompts: 7 } }),
      roster: [{ person_id: "ada", display_name: "Ada" }],
      start: START,
      read: READ,
      snapshot: PG_SNAPSHOT,
    });

    expect(payload.people[0].activeSeconds).toBe(0);
  });

  it("caps naturally at 24 hours when all 144 buckets are occupied", () => {
    const rows = rowsFor("ada");
    for (const row of rows) {
      row.agent = 1;
      row.day_agent = 1;
    }
    const payload = buildFlamePayload({
      rows,
      roster: [{ person_id: "ada", display_name: "Ada" }],
      start: START,
      read: READ,
      snapshot: PG_SNAPSHOT,
    });

    expect(payload.people[0].activeSeconds).toBe(86_400);
  });

  it("excludes stable smoke identities from roster and direct evidence paths", () => {
    expect(PEOPLE_SQL).toContain("github_id is distinct from 'sherlock-smoke'");
    expect(FLAME_SQL).toContain("github_id is distinct from 'sherlock-smoke'");
    expect(WORK_DETAIL_SQL).toContain("pe.github_id is distinct from 'sherlock-smoke'");
    expect(PROJECTION_WORK_DETAIL_SQL).toContain(
      "evidence_person.github_id is distinct from 'sherlock-smoke'",
    );
  });

  it("requires one approved dashboard email domain", () => {
    expect(PREFERRED_DASHBOARD_EMAIL_DOMAIN).toBe("e3group.ai");
    expect(SIXTYFOUR_DASHBOARD_EMAIL_DOMAIN).toBe("sixtyfour.ai");
    expect(validateDashboardEmailDomain("e3group.ai")).toBe("e3group.ai");
    expect(validateDashboardEmailDomain("sixtyfour.ai")).toBe("sixtyfour.ai");
    expect(() => validateDashboardEmailDomain("example.com")).toThrow(TypeError);
    expect(() => validateDashboardEmailDomain("sub.e3group.ai")).toThrow(TypeError);
  });

  it("binds expected-domain visibility across roster, day, and detail SQL", () => {
    expect(PEOPLE_SQL).toContain("split_part(pe.email, '@', 2) = $3");
    expect(PEOPLE_SQL).toContain("split_part(pe.email, '@', 3) = ''");
    for (const query of [FLAME_SQL, INTERVAL_WORK_SQL, INTERVAL_PROMPTS_SQL, WORK_DETAIL_SQL]) {
      expect(query).toContain("expected_email_domain");
      expect(query).toContain("split_part(pe.email, '@', 2) = p.expected_email_domain");
      expect(query).toContain("split_part(pe.email, '@', 3) = ''");
    }
    for (const query of [
      PROJECTION_FLAME_SQL,
      PROJECTION_INTERVAL_WORK_SQL,
      PROJECTION_INTERVAL_PROMPTS_SQL,
      PROJECTION_WORK_DETAIL_SQL,
    ]) {
      expect(query).toContain("expected_email_domain");
      expect(query).toContain(
        "split_part(evidence_person.email, '@', 2) = p.expected_email_domain",
      );
      expect(query).toContain("split_part(evidence_person.email, '@', 3) = ''");
    }
  });

  it("canonically counts submitted primary prompts", () => {
    expect(FLAME_SQL).toContain("partition by session_id, canonical_scope_key");
    expect(FLAME_SQL).toContain("normalizer_version, logical_event_key, event_kind");
    expect(FLAME_SQL).toContain("order by source_priority desc");
    expect(FLAME_SQL).toContain("source_occurred_at asc nulls last, id");
    expect(FLAME_SQL).toContain("keyed_submitted");
    expect(FLAME_SQL).toContain("e.message_role = 'user'");
    expect(FLAME_SQL).toContain("e.content_byte_size > 0");
    expect(FLAME_SQL).toContain("e.error_code is null");
    expect(FLAME_SQL).toContain("keyed_native_item_id");
    expect(FLAME_SQL).toContain("partition by person_id, prompt_identity");
  });

  it("round-trips a bounded immutable aggregate snapshot receipt", () => {
    const token = encodeSnapshotToken({ snapshot: PG_SNAPSHOT, read: READ });

    expect(token).toMatch(/^v3\.[A-Za-z0-9_-]+$/);
    expect(decodeSnapshotToken(token)).toEqual({
      snapshot: PG_SNAPSHOT,
      read: READ,
      normalizerVersions: NORMALIZER_VERSIONS,
    });

    const legacyBody = Buffer.from(JSON.stringify([
      PG_SNAPSHOT,
      READ.toISOString(),
    ])).toString("base64url");
    expect(decodeSnapshotToken(`v1.${legacyBody}`)).toEqual({
      snapshot: PG_SNAPSHOT,
      read: READ,
      normalizerVersions: LEGACY_NORMALIZER_VERSIONS,
    });
  });

  it("pins projection snapshots to the exact immutable frame version", () => {
    const token = encodeProjectionSnapshotToken({
      snapshot: PG_SNAPSHOT,
      read: READ,
      frameVersion: FRAME_VERSION,
    });

    expect(token).toMatch(/^v2\.[A-Za-z0-9_-]+$/);
    expect(decodeSnapshotToken(token)).toEqual({
      snapshot: PG_SNAPSHOT,
      read: READ,
      frameVersion: FRAME_VERSION,
    });
    const compatibleToken = encodeProjectionSnapshotToken({
      snapshot: PG_SNAPSHOT,
      read: READ,
      frameVersion: COMPATIBLE_WORK_FRAME_VERSION,
    });
    expect(decodeSnapshotToken(compatibleToken)).toEqual({
      snapshot: PG_SNAPSHOT,
      read: READ,
      frameVersion: COMPATIBLE_WORK_FRAME_VERSION,
    });
    expect(() => encodeProjectionSnapshotToken({
      snapshot: PG_SNAPSHOT,
      read: READ,
      frameVersion: "frame-evidence-v3",
    })).toThrow(FlameSourceError);
    const unsupported = Buffer.from(JSON.stringify([
      PG_SNAPSHOT,
      READ.toISOString(),
      "frame-evidence-v3",
    ])).toString("base64url");
    expect(() => decodeSnapshotToken(`v2.${unsupported}`)).toThrow(FlameSourceError);
  });

  it.each([
    "",
    "v3.Zm9v",
    "v1.not+base64url",
    "v1.WyIxOjI6MyIsIjIwMjYtMDgtMTdUMTI6MDA6MDEuMDAwWiJd",
  ])("rejects invalid prompt snapshot token %s", (token) => {
    expect(() => decodeSnapshotToken(token)).toThrow(FlameSourceError);
  });

  it("captures the aggregate snapshot in the same transaction as its rows", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    source.expectedEmailDomain = "e3group.ai";
    source.maxPeople = 5;
    const roster = [{ person_id: "ada", display_name: "Ada" }];
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{ now: READ, snapshot: PG_SNAPSHOT }])
      .mockResolvedValueOnce(roster)
      .mockResolvedValueOnce(rowsFor("ada"));
    source.transaction = (callback) => callback({
      unsafe,
      array: (values) => values,
    });

    const payload = await source.fetchDay();

    expect(unsafe.mock.calls[0][0]).toContain("pg_current_snapshot()::text as snapshot");
    expect(decodeSnapshotToken(payload.snapshot)).toEqual({
      snapshot: PG_SNAPSHOT,
      read: READ,
      normalizerVersions: NORMALIZER_VERSIONS,
    });
    expect(unsafe.mock.calls[2][1]).toEqual([
      source.workspaceId,
      START.toISOString(),
      "2026-08-17T12:00:00.000Z",
      NORMALIZER_VERSIONS,
      READ.toISOString(),
      "e3group.ai",
    ]);
  });

  it.each([
    [true, false, PROJECTION_FLAME_SQL, "v2", FRAME_VERSION],
    [false, true, PROJECTION_FLAME_SQL, "v2", COMPATIBLE_WORK_FRAME_VERSION],
    [false, false, FLAME_SQL, "v3", null],
    [null, null, FLAME_SQL, "v3", null],
  ])("routes current activation %s and compatible work activation %s", async (
    frameProjectionActive,
    compatibleWorkProjectionActive,
    expectedSql,
    expectedTokenVersion,
    expectedFrameVersion,
  ) => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    source.expectedEmailDomain = "e3group.ai";
    source.maxPeople = 5;
    const roster = [{ person_id: "ada", display_name: "Ada" }];
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{
        now: READ,
        snapshot: PG_SNAPSHOT,
        frame_projection_active: frameProjectionActive,
        compatible_work_projection_active: compatibleWorkProjectionActive,
      }])
      .mockResolvedValueOnce(roster)
      .mockResolvedValueOnce(rowsFor("ada"));
    source.transaction = (callback) => callback({
      unsafe,
      array: (values) => values,
    });

    const payload = await source.fetchDay();

    expect(unsafe.mock.calls[0][0]).toContain("exists (");
    expect(unsafe.mock.calls[0][0]).toContain("activation.frame_version = $2");
    expect(unsafe.mock.calls[0][0]).toContain("activation.frame_version = $3");
    expect(unsafe.mock.calls[0][0]).not.toContain("order by activation");
    expect(unsafe.mock.calls[0][1]).toEqual([
      source.workspaceId,
      FRAME_VERSION,
      COMPATIBLE_WORK_FRAME_VERSION,
    ]);
    expect(unsafe.mock.calls[2][0]).toBe(expectedSql);
    const expectedSnapshot = {
      snapshot: PG_SNAPSHOT,
      read: READ,
    };
    if (expectedFrameVersion) {
      expectedSnapshot.frameVersion = expectedFrameVersion;
    } else {
      expectedSnapshot.normalizerVersions = NORMALIZER_VERSIONS;
    }
    if (frameProjectionActive) {
      expect(unsafe.mock.calls[2][1]).toEqual([
        source.workspaceId,
        START.toISOString(),
        "2026-08-17T12:00:00.000Z",
        FRAME_VERSION,
        READ.toISOString(),
        "e3group.ai",
      ]);
    }
    if (!frameProjectionActive && compatibleWorkProjectionActive) {
      expect(unsafe.mock.calls[2][1][3]).toBe(COMPATIBLE_WORK_FRAME_VERSION);
    }
    expect(payload.snapshot).toMatch(new RegExp(`^${expectedTokenVersion}\\.`));
    expect(decodeSnapshotToken(payload.snapshot)).toEqual(expectedSnapshot);
  });

  it("can disable projection lookup before the additive migration is present", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    source.expectedEmailDomain = "e3group.ai";
    source.maxPeople = 5;
    source.projectionEnabled = false;
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{ now: READ, snapshot: PG_SNAPSHOT, frame_projection_active: false }])
      .mockResolvedValueOnce([{ person_id: "ada", display_name: "Ada" }])
      .mockResolvedValueOnce(rowsFor("ada"));
    source.transaction = (callback) => callback({ unsafe, array: (values) => values });

    const payload = await source.fetchDay();

    expect(unsafe.mock.calls[0][0]).not.toContain("analytics.frame_projection_activations");
    expect(unsafe.mock.calls[0][1]).toBeUndefined();
    expect(unsafe.mock.calls[2][0]).toBe(FLAME_SQL);
    expect(payload.snapshot).toMatch(/^v3\./);
  });

  it("selects the 30-second transaction timeout only for the cached timeline", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    const signal = new AbortController().signal;
    source.transaction = vi.fn().mockResolvedValue("timeline");

    await expect(source.fetchDay({ signal })).resolves.toBe("timeline");

    expect(source.transaction).toHaveBeenCalledOnce();
    expect(source.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { signal, statementTimeoutMs: 30_000 },
    );
  });

  it("uses stable prompt identifiers before a mutually unique source-stream bridge", () => {
    const promptSql = FLAME_SQL.slice(
      FLAME_SQL.indexOf("prompt_candidates as materialized"),
      FLAME_SQL.indexOf("prompt_counts as materialized"),
    );
    expect(UNKEYED_PROMPT_MATCH_SECONDS).toBe(2);
    expect(FLAME_SQL).toContain("native_identity_candidates as materialized");
    expect(FLAME_SQL).not.toContain("partition by session_id, native_item_id");
    expect(FLAME_SQL).toContain("'logical:' || canonical_scope_key || ':' || normalizer_version");
    expect(FLAME_SQL).toContain("'native:' || submitted.native_item_id");
    expect(FLAME_SQL).toContain("'native:' || paired.matched_native_item_id");
    expect(FLAME_SQL).toContain("'event:' || submitted.id::text");
    expect(FLAME_SQL).toContain("unkeyed_prompt_pair_candidates as materialized");
    expect(FLAME_SQL).toContain("native.source_stream_key = submitted.source_stream_key");
    expect(FLAME_SQL).toContain("native.generation_seq = submitted.generation_seq");
    expect(FLAME_SQL).toContain("count(*) over (partition by submitted_id)");
    expect(FLAME_SQL).toContain("submitted_degree = 1 and native_degree = 1");
    expect(FLAME_SQL).toContain(
      "native.native_source_observed_at - submitted.source_observed_at",
    );
    expect(FLAME_SQL).toContain("native.native_observed_at matched_native_observed_at");
    expect(promptSql).not.toContain("cross join lateral");
    expect(FLAME_SQL).toContain("interval '2 seconds'");
    expect(FLAME_SQL).not.toContain("date_trunc(\n                          'second'");
    expect(FLAME_SQL).not.toContain("matching_native_item_id");
    expect(FLAME_SQL).not.toContain("has_submitted_user_message");
    expect(FLAME_SQL).not.toContain(
      "unkeyed_native_candidates as materialized",
    );
  });

  it("materializes set-based prompt joins before restoring their original semantics", () => {
    const promptSql = FLAME_SQL.slice(
      FLAME_SQL.indexOf("prompt_candidates as materialized"),
      FLAME_SQL.indexOf("prompt_counts as materialized"),
    );

    expect(promptSql).toContain("prompt_representation_pairs as materialized");
    expect(promptSql).toContain(
      "full join canonical_prompt_candidates previous",
    );
    expect(promptSql).toContain(
      "from prompt_representation_pairs\n   where suppressed_id is not null and previous_id is not null",
    );

    expect(promptSql).toContain("unkeyed_prompt_pair_rows as materialized");
    expect(promptSql).toContain(
      "full join native_identity_candidates native",
    );
    expect(promptSql).toContain(
      "from unkeyed_prompt_pair_rows\n   where submitted_id is not null and native_event_id is not null",
    );

    expect(promptSql).toContain("unkeyed_prompt_source_rows as materialized");
    expect(promptSql).toContain(
      "full join unkeyed_prompt_pairs paired on paired.submitted_id = submitted.id",
    );
    expect(promptSql).toContain(
      "from unkeyed_prompt_source_rows\n   where id is not null",
    );

    expect(promptSql).not.toContain(
      "\n    join canonical_prompt_candidates previous\n      on",
    );
    expect(promptSql).not.toContain(
      "\n    join native_identity_candidates native\n      on",
    );
    expect(promptSql).not.toContain(
      "left join unkeyed_prompt_pairs paired",
    );
  });

  it("collapses only adjacent native-ID-less copies of one submitted prompt", () => {
    expect(UNKEYED_PROMPT_REPRESENTATION_MILLISECONDS).toBe(100);
    expect(FLAME_SQL).toContain("join telemetry.native_records nr");
    expect(FLAME_SQL).toContain(
      "previous.source_record_index = duplicate.source_record_index - 1",
    );
    expect(FLAME_SQL).toContain(
      "previous.source_end_offset = duplicate.source_start_offset",
    );
    expect(FLAME_SQL).toContain("previous.content_sha256 = duplicate.content_sha256");
    expect(FLAME_SQL).toContain("previous.source_native_type = 'event_msg'");
    expect(FLAME_SQL).toContain("previous.source_native_payload_type = 'user_message'");
    expect(FLAME_SQL).toContain("previous.native_item_id is null");
    expect(FLAME_SQL).toContain("duplicate.native_item_id is null");
    expect(FLAME_SQL).toContain("previous.turn_id is null");
    expect(FLAME_SQL).toContain("duplicate.turn_id is null");
    expect(FLAME_SQL).toContain("<= 100 / 1000.0");
  });

  it("accepts stable native prompt evidence without duplicating its identity", () => {
    expect(FLAME_SQL).toContain("native_prompt_sources as materialized");
    expect(FLAME_SQL).toContain(
      "(keyed_submitted or keyed_native_item_id is not null) has_submitted",
    );
    expect(FLAME_SQL).toContain("source_native_type = 'response_item'");
    expect(FLAME_SQL).toContain("source_native_payload_type = 'message'");
    expect(FLAME_SQL).toContain("partition by person_id, prompt_identity");
    for (const sql of [FLAME_SQL, INTERVAL_PROMPTS_SQL]) {
      expect(sql).toContain("e.message_origin = 'human'");
      expect(sql).toContain("sherlock.codex-rollout.v1");
      expect(sql).toContain("<recommended_plugins>");
      expect(sql).toContain("<codex_delegation>");
      expect(sql).toContain("<heartbeat>");
    }
    expect(FLAME_SQL).toContain("native_prompt_candidate");
    expect(PROJECTION_INTERVAL_PROMPTS_SQL).not.toContain("<recommended_plugins>");
  });

  it("cannot let response-only evidence suppress a submitted prompt identity", () => {
    expect(FLAME_SQL).toContain(
      "from prompt_identities\n       where has_submitted",
    );
    expect(FLAME_SQL).toContain(
      "partition by person_id, prompt_identity",
    );
  });

  it("prefers a keyed group's stable native identity across copied sessions", () => {
    expect(FLAME_SQL).toContain(
      "coalesce(\n           'native:' || keyed_native_item_id,",
    );
    expect(FLAME_SQL).toContain(
      "'logical:' || canonical_scope_key || ':' || normalizer_version",
    );
  });

  it("retains native identity donors that canonical winner selection can drop", () => {
    expect(FLAME_SQL).toContain(
      "native_identity_candidates as materialized (\n  select prompt_candidates.*",
    );
    expect(FLAME_SQL).toContain(
      "native_observed_at\n    from prompt_candidates",
    );
  });

  it("uses the same snapshot-pinned canonical activity universe for interval work and detail", () => {
    for (const sql of [INTERVAL_WORK_SQL, WORK_DETAIL_SQL]) {
      expect(sql).toContain("e.workspace_id = p.workspace_id");
      expect(sql).toContain("e.normalizer_version = any(p.normalizer_versions)");
      expect(sql).toContain("not e.is_replay");
      expect(sql).toContain("e.actor_role <> 'automation'");
      expect(sql).toContain("partition by e.session_id, e.canonical_scope_key");
      expect(sql).toContain("e.normalizer_version, e.logical_event_key, e.event_kind");
      expect(sql).toContain("order by e.source_priority desc, e.occurred_at asc nulls last, e.id");
      expect(sql).toContain("where canonical_rank = 1");
      expect(sql).toContain("pg_visible_in_snapshot(e.xmin::text::xid8, p.snapshot)");
      expect(sql).toContain("e.actor_role = 'unknown' and s.parent_session_id is not null");
      expect(sql).toContain("e.actor_role <> 'unknown'");
      expect(sql).toContain("or pg_visible_in_snapshot(s.xmin::text::xid8, p.snapshot)");
      expect(sql).toContain("pg_visible_in_snapshot(s.xmin::text::xid8, p.snapshot)");
      expect(sql).toContain("ib.start_offset source_batch_start_offset");
      expect(sql).toContain("ib.end_offset source_batch_end_offset");
      expect(sql).toContain("ib.record_count source_batch_record_count");
      expect(sql).not.toContain("analytics.activity_spans");
    }
    expect(INTERVAL_WORK_SQL).toContain("group by session_id, semantic_role");
    expect(INTERVAL_WORK_SQL).toContain(
      "event_subtype = 'message' and message_origin = 'human'",
    );
    expect(INTERVAL_WORK_SQL).toContain("and s.person_id = p.person_id");
    expect(INTERVAL_WORK_SQL).toContain("relevant_activity_sessions as materialized");
    expect(INTERVAL_WORK_SQL).toContain(
      "and e.session_id in (select session_id from relevant_activity_sessions)",
    );
    expect(INTERVAL_WORK_SQL).toContain(
      "p.bucket_start - interval '6 seconds'",
    );
    expect(INTERVAL_WORK_SQL).toContain(
      "$8::timestamptz - interval '6 seconds'",
    );
    expect(INTERVAL_WORK_SQL).toContain(
      ") >= date_trunc('milliseconds', s.started_at)",
    );
    expect(INTERVAL_WORK_SQL).toContain("select distinct e.session_id");
    expect(INTERVAL_WORK_SQL).toContain("limit $11");
    expect(WORK_DETAIL_SQL).toContain("and e.session_id = p.session_id");
    expect(WORK_DETAIL_SQL).toContain(
      "bucket_events.event_subtype = 'message'",
    );
    expect(ACTIVITY_REPRESENTATION_NEIGHBORHOOD_SECONDS).toBe(6);
    expect(WORK_DETAIL_SQL).toContain("p.bucket_start - interval '6 seconds'");
    expect(WORK_DETAIL_SQL).toContain("from header left join selected on true");
    expect(WORK_DETAIL_SQL).toContain(") > (p.cursor_at_microseconds, p.cursor_id)");
    expect(WORK_DETAIL_SQL).toContain("order by selected.observed_at nulls first");
    expect(WORK_DETAIL_SQL).toContain("limit $15");
    expect(INTERVAL_PROMPTS_SQL).toContain("e.message_origin = 'human'");
    expect(INTERVAL_PROMPTS_SQL).toContain("e.message_role = 'user'");
    expect(INTERVAL_PROMPTS_SQL).toContain("e.actor_role = 'primary'");
    expect(INTERVAL_PROMPTS_SQL).toContain("and s.person_id = p.person_id");
    expect(INTERVAL_PROMPTS_SQL).toContain("pg_visible_in_snapshot(e.xmin::text::xid8, p.snapshot)");
    expect(INTERVAL_PROMPTS_SQL).toContain("limit $11");
  });

  it("keeps Claude system meta messages out of user summaries and detail", () => {
    for (const sql of [INTERVAL_WORK_SQL, WORK_DETAIL_SQL]) {
      expect(sql).toContain("e.message_role, e.message_origin");
      expect(sql).toContain("message_origin in ('human', 'parent_agent')");
    }
    expect(INTERVAL_WORK_SQL).toContain(
      "and message_origin in ('human', 'parent_agent')",
    );
    expect(WORK_DETAIL_SQL).toContain(
      "bucket_events.message_origin in ('human', 'parent_agent')",
    );
  });

  it("screens session labels without removing submitted prompt evidence", () => {
    expect(INTERVAL_WORK_SQL).toContain("<recommended_plugins>");
    expect(PROJECTION_INTERVAL_WORK_SQL).toContain("<recommended_plugins>");
    expect(PROJECTION_INTERVAL_WORK_SQL).toContain("<codex_delegation>");
    expect(PROJECTION_INTERVAL_WORK_SQL).toContain("is_summary_candidate");
    expect(PROJECTION_INTERVAL_WORK_SQL).toContain(
      "array_agg(source.content_excerpt",
    );
    expect(PROJECTION_INTERVAL_PROMPTS_SQL).not.toContain(
      "<recommended_plugins>",
    );
  });

  it("selects MCP prompt excerpts from the exact canonical prompt universe", () => {
    expect(INTERVAL_PROMPTS_SQL).toContain("prompt_candidates as materialized");
    expect(INTERVAL_PROMPTS_SQL).toContain("e.message_origin = 'human'");
    expect(INTERVAL_PROMPTS_SQL).toContain("e.message_role = 'user'");
    expect(INTERVAL_PROMPTS_SQL).toContain("e.actor_role = 'primary'");
    expect(INTERVAL_PROMPTS_SQL).toContain("where has_submitted");
    expect(INTERVAL_PROMPTS_SQL).toContain("where canonical_rank = 1");
    expect(INTERVAL_PROMPTS_SQL).toContain(
      "pg_visible_in_snapshot(e.xmin::text::xid8, p.snapshot)",
    );
    expect(INTERVAL_PROMPTS_SQL).toContain("and s.person_id = p.person_id");
    expect(INTERVAL_PROMPTS_SQL).toContain("count(*) over ()::bigint");
    expect(INTERVAL_PROMPTS_SQL).toContain("limit $11");
    expect(INTERVAL_PROMPTS_SQL).not.toContain("activity_candidates as materialized");
    expect(INTERVAL_PROMPTS_SQL).not.toContain("context_before");
    expect(MCP_PROMPT_EVIDENCE_LIMIT).toBe(5);
  });

  it("keeps projection reads bounded, snapshot-visible, and semantically exact", () => {
    expect(PROJECTION_FLAME_SQL).toContain("analytics.frame_evidence_revisions");
    expect(PROJECTION_FLAME_SQL).not.toContain("analytics.frame_projection_receipts");
    expect(PROJECTION_FLAME_SQL).not.toContain("telemetry.events");
    expect(PROJECTION_FLAME_SQL).not.toContain("telemetry.sessions");
    for (const query of [
      PROJECTION_INTERVAL_WORK_SQL,
      PROJECTION_INTERVAL_PROMPTS_SQL,
      PROJECTION_WORK_DETAIL_SQL,
    ]) {
      expect(query).toContain("revision.evidence_kind = 'activity'");
      expect(query).toContain(
        `revision.observed_at >= p.start_at - interval '${ACTIVITY_REPRESENTATION_NEIGHBORHOOD_SECONDS} seconds'`,
      );
      expect(query).toContain("revision.evidence_kind = 'prompt'");
      expect(query).toContain(
        `revision.anchor_observed_at >= p.start_at - interval '${UNKEYED_PROMPT_MATCH_SECONDS} seconds'`,
      );
      expect(query).toContain(
        `or revision.observed_at >= p.start_at - interval '${UNKEYED_PROMPT_MATCH_SECONDS} seconds'`,
      );
      expect(query).toContain("pg_visible_in_snapshot(revision.xmin::text::xid8");
      expect(query).not.toContain("frame_projection_receipts");
      expect(query).not.toContain("telemetry.sessions");
      expect(query).not.toContain("telemetry.native_records");
      expect(query).not.toContain("telemetry.ingest_batches");
    }
    expect(PROJECTION_INTERVAL_WORK_SQL.indexOf("limit $10")).toBeLessThan(
      PROJECTION_INTERVAL_WORK_SQL.indexOf("join telemetry.events source"),
    );
    expectSqlInOrder(
      PROJECTION_INTERVAL_WORK_SQL,
      "bucket_events as materialized",
      "evidence.observed_at >= p.bucket_start",
      "grouped as materialized",
      "limit $10",
      "session_summary_candidates as materialized",
      "join projected_activity evidence",
      "session_summaries as materialized",
      "join telemetry.events source",
    );
    expect(PROJECTION_INTERVAL_PROMPTS_SQL.indexOf("limit $10")).toBeLessThan(
      PROJECTION_INTERVAL_PROMPTS_SQL.indexOf("join telemetry.events source"),
    );
    expect(PROJECTION_WORK_DETAIL_SQL.indexOf("limit $12")).toBeLessThan(
      PROJECTION_WORK_DETAIL_SQL.indexOf("left join telemetry.events source"),
    );
    const detailRevisionScope = PROJECTION_WORK_DETAIL_SQL.indexOf(
      "and revision.session_id = p.session_id",
    );
    expect(detailRevisionScope).toBeGreaterThan(
      PROJECTION_WORK_DETAIL_SQL.indexOf("ranked_frame_revisions as materialized"),
    );
    expect(detailRevisionScope).toBeLessThan(
      PROJECTION_WORK_DETAIL_SQL.indexOf("), latest_frame_evidence as materialized"),
    );
    expect(PROJECTION_INTERVAL_WORK_SQL).not.toContain(
      "revision.session_id = p.session_id",
    );
    expect(PROJECTION_FLAME_SQL).toContain(
      "and observed_at >= p.start_at and observed_at < p.read_at",
    );
    expect(PROJECTION_FLAME_SQL).toContain(
      "where evidence.observed_at < p.end_at",
    );
    expect(PROJECTION_FLAME_SQL).toContain(
      "and evidence.observed_at < p.end_at",
    );
    expect(PROJECTION_FLAME_SQL).toContain(
      "latest_frame_evidence.anchor_observed_at,",
    );
    expect(PROJECTION_INTERVAL_PROMPTS_SQL).toContain(
      "latest_frame_evidence.anchor_observed_at,",
    );
    expect(PROJECTION_INTERVAL_WORK_SQL).not.toContain("p.read_at");
  });

  it("excludes projected guardians after latest-revision selection", () => {
    for (const sql of [
      PROJECTION_FLAME_SQL,
      PROJECTION_INTERVAL_WORK_SQL,
      PROJECTION_INTERVAL_PROMPTS_SQL,
      PROJECTION_WORK_DETAIL_SQL,
    ]) {
      expectSqlInOrder(
        sql,
        "ranked_frame_revisions as materialized",
        "latest_frame_evidence as materialized",
        "where latest_rank = 1 and not is_tombstone",
        "projected_activity as materialized",
        "and actor_role <> 'guardian'",
        "projected_prompt_candidates as materialized",
      );
    }
    for (const sql of [
      PROJECTION_INTERVAL_WORK_SQL,
      PROJECTION_WORK_DETAIL_SQL,
    ]) {
      expect(sql).toContain("when actor_role = 'worker' then 'subagent'");
    }
    expect(PROJECTION_FLAME_SQL).toContain(
      "where evidence.actor_role = 'worker'",
    );
  });

  it("bridges only mutually unique immutable-stream representations in work evidence", () => {
    expect(ASSISTANT_REPRESENTATION_MATCH_SECONDS).toBe(3);
    for (const sql of [INTERVAL_WORK_SQL, WORK_DETAIL_SQL]) {
      expect(sql).toContain("join telemetry.native_records nr");
      expect(sql).toContain("cross_format_pair_candidates as materialized");
      expect(sql).toContain("legacy.source_native_type = 'event_msg'");
      expect(sql).toContain("legacy.source_native_payload_type = 'agent_message'");
      expect(sql).toContain("legacy.source_native_item_id is null");
      expect(sql).toContain("structured.source_native_type = 'response_item'");
      expect(sql).toContain("structured.source_native_payload_type = 'message'");
      expect(sql).toContain("structured.content_sha256 = legacy.content_sha256");
      expect(sql).toContain("structured.actor_role = legacy.actor_role");
      expect(sql).toContain("structured.source_stream_key = legacy.source_stream_key");
      expect(sql).toContain("structured.generation_seq = legacy.generation_seq");
      expect(sql).toContain("<= 3");
      expect(sql).toContain("submitted.event_subtype = 'user_message'");
      expect(sql).toContain("submitted.source_native_type = 'event_msg'");
      expect(sql).toContain("submitted.source_native_payload_type = 'user_message'");
      expect(sql).toContain("submitted.source_native_item_id is null");
      expect(sql).toContain("count(*) over (partition by legacy_id)");
      expect(sql).toContain("count(*) over (partition by structured_id)");
      expect(sql).toContain("legacy_degree = 1 and structured_degree = 1");
      expect(sql).toContain("later.source_record_index = earlier.source_record_index + 1");
      expect(sql).toContain("later.source_start_offset = earlier.source_end_offset");
      expect(sql).toContain("left join representation_suppressed");
      expect(sql).not.toContain("partition by content_sha256");
      expect(sql).toContain("source_kind = 'transcript'");
      expect(sql).toContain("source_native_type in ('assistant', 'user')");
      expect(sql).toContain("source_native_payload_type is null");
    }
  });

  it("returns bounded semantic-role work rows for one interval", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    const personId = "22222222-2222-4222-8222-222222222222";
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{ now: new Date("2026-08-17T12:00:02.000Z") }])
      .mockResolvedValueOnce([{
        session_id: sessionId,
        semantic_role: "subagent",
        first_at: new Date("2026-08-16T12:00:09.000Z"),
        last_at: new Date("2026-08-16T12:04:00.000Z"),
        event_count: 4,
        summary: "Inspect the query",
      }])
      .mockResolvedValueOnce([{
        session_id: sessionId,
        repository_full_name: "e3-solutions/sherlock",
        pull_request_number: 54,
      }])
      .mockResolvedValueOnce([{
        prompt_identity: "native:msg_1",
        session_id: sessionId,
        observed_at: new Date("2026-08-16T12:00:10.000Z"),
        content_byte_size: 17,
        content_excerpt: "Inspect the query",
      }]);
    source.transaction = (callback) => callback({
      unsafe,
      array: (values) => values,
    });
    const snapshot = encodeSnapshotToken({ snapshot: PG_SNAPSHOT, read: READ });

    const interval = await source.fetchInterval({
      personId,
      start: START.toISOString(),
      snapshot,
    });

    expect(unsafe.mock.calls[1][0]).toBe(INTERVAL_WORK_SQL);
    expect(unsafe.mock.calls[1][1].at(-1)).toBe(201);
    expect(unsafe.mock.calls[2][0]).toBe(INTERVAL_PULL_REQUESTS_SQL);
    expect(unsafe.mock.calls[2][1]).toEqual([
      source.workspaceId, PG_SNAPSHOT, READ.toISOString(), [sessionId],
    ]);
    expect(unsafe.mock.calls[3][0]).toBe(INTERVAL_PROMPTS_SQL);
    expect(unsafe.mock.calls[3][1].at(-1)).toBe(201);
    expect(interval).toMatchObject({
      personId,
      start: START.toISOString(),
      snapshot,
      work: [{
        id: `${sessionId}:subagent`,
        sessionId,
        role: "subagent",
        eventCount: 4,
        summary: "Inspect the query",
        pullRequest: {
          number: 54,
          url: "https://github.com/e3-solutions/sherlock/pull/54",
        },
      }],
      prompts: [{
        id: "native:msg_1",
        sessionId,
        content: "Inspect the query",
        truncated: false,
      }],
    });
  });

  it("keeps already-issued v1 details on the legacy normalizer universe", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    source.expectedEmailDomain = "e3group.ai";
    const personId = "22222222-2222-4222-8222-222222222222";
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{ now: new Date("2026-08-17T12:00:02.000Z") }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    source.transaction = (callback) => callback({
      unsafe,
      array: (values) => values,
    });
    const legacyBody = Buffer.from(JSON.stringify([
      PG_SNAPSHOT,
      READ.toISOString(),
    ])).toString("base64url");

    await source.fetchInterval({
      personId,
      start: START.toISOString(),
      snapshot: `v1.${legacyBody}`,
    });

    expect(unsafe.mock.calls[1][0]).toBe(INTERVAL_WORK_SQL);
    expect(unsafe.mock.calls[1][1][3]).toEqual(LEGACY_NORMALIZER_VERSIONS);
    expect(unsafe.mock.calls[2][0]).toBe(INTERVAL_PROMPTS_SQL);
    expect(unsafe.mock.calls[2][1][3]).toEqual(LEGACY_NORMALIZER_VERSIONS);
  });

  it("never silently falls a failing v2 interval back to raw SQL", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    const personId = "22222222-2222-4222-8222-222222222222";
    const failure = new Error("projection unavailable");
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{ now: new Date("2026-08-17T12:00:02.000Z") }])
      .mockRejectedValueOnce(failure);
    source.transaction = (callback) => callback({ unsafe });

    await expect(source.fetchInterval({
      personId,
      start: START.toISOString(),
      snapshot: encodeProjectionSnapshotToken({
        snapshot: PG_SNAPSHOT,
        read: READ,
        frameVersion: FRAME_VERSION,
      }),
    })).rejects.toBe(failure);
    expect(unsafe).toHaveBeenCalledTimes(2);
    expect(unsafe.mock.calls[1][0]).toBe(PROJECTION_INTERVAL_WORK_SQL);
  });

  it("keeps interval evidence entirely on frame v2 while v3 backfills", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    source.expectedEmailDomain = "e3group.ai";
    const personId = "22222222-2222-4222-8222-222222222222";
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{ now: new Date("2026-08-17T12:00:02.000Z") }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    source.transaction = (callback) => callback({
      unsafe,
      array: (values) => values,
    });

    await source.fetchInterval({
      personId,
      start: START.toISOString(),
      snapshot: encodeProjectionSnapshotToken({
        snapshot: PG_SNAPSHOT,
        read: READ,
        frameVersion: COMPATIBLE_WORK_FRAME_VERSION,
      }),
    });

    expect(unsafe.mock.calls[1][0]).toBe(PROJECTION_INTERVAL_WORK_SQL);
    expect(unsafe.mock.calls[1][1][1]).toBe(COMPATIBLE_WORK_FRAME_VERSION);
    expect(unsafe.mock.calls[1][1].slice(4, 8)).toEqual([
      START.toISOString(),
      "2026-08-17T12:00:00.000Z",
      START.toISOString(),
      new Date(START.getTime() + 10 * 60 * 1000).toISOString(),
    ]);
    expect(unsafe.mock.calls[2][0]).toBe(PROJECTION_INTERVAL_PROMPTS_SQL);
    expect(unsafe.mock.calls[2][1][1]).toBe(COMPATIBLE_WORK_FRAME_VERSION);
    expect(unsafe.mock.calls[2][1].slice(4, 8)).toEqual([
      START.toISOString(),
      "2026-08-17T12:00:00.000Z",
      START.toISOString(),
      new Date(START.getTime() + 10 * 60 * 1000).toISOString(),
    ]);
    expect(unsafe.mock.calls[2][1][9]).toBe(INTERVAL_PROMPT_LIMIT + 1);
  });

  it("distinguishes an expired snapshot from an invalid frame range", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    const personId = "22222222-2222-4222-8222-222222222222";
    const snapshot = encodeSnapshotToken({ snapshot: PG_SNAPSHOT, read: READ });
    const unsafe = vi.fn().mockResolvedValue([{
      now: new Date(READ.getTime() + 25 * 60 * 60 * 1000 + 1),
    }]);
    source.transaction = (callback) => callback({ unsafe });

    await expect(source.fetchInterval({
      personId, start: START.toISOString(), snapshot,
    })).rejects.toMatchObject({ code: "flame_interval_snapshot_expired" });
    expect(unsafe).toHaveBeenCalledTimes(1);

    unsafe.mockReset().mockResolvedValue([{ now: new Date(READ.getTime() + 1000) }]);
    await expect(source.fetchInterval({
      personId,
      start: new Date(START.getTime() - BUCKET_MS).toISOString(),
      snapshot,
    })).rejects.toMatchObject({ code: "flame_interval_request_out_of_range" });
  });

  it("cancels in-flight work without leaking a cancellation transport rejection", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    source.maxPeople = 10;
    let rejectRows;
    const pendingRows = new Promise((resolve, reject) => { rejectRows = reject; });
    pendingRows.cancel = vi.fn(() => {
      rejectRows(Object.assign(new Error("cancelled"), { code: "57014" }));
      return Promise.reject(new Error("cancel transport failed"));
    });
    const resolved = (value) => {
      const result = Promise.resolve(value);
      result.cancel = vi.fn();
      return result;
    };
    const unsafe = vi.fn()
      .mockImplementationOnce(() => resolved([]))
      .mockImplementationOnce(() => resolved([]))
      .mockImplementationOnce(() => resolved([]))
      .mockImplementationOnce(() => resolved([{
        now: READ,
        snapshot: PG_SNAPSHOT,
      }]))
      .mockImplementationOnce(() => resolved([{
        person_id: "22222222-2222-4222-8222-222222222222",
        display_name: "Ada",
      }]))
      .mockImplementationOnce(() => pendingRows);
    source.sql = {
      begin: (callback) => callback({ unsafe, array: (values) => values }),
    };
    const controller = new AbortController();

    const request = source.fetchDay({ signal: controller.signal });
    await vi.waitFor(() => expect(unsafe).toHaveBeenCalledTimes(6));
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: "flame_request_aborted" });
    expect(pendingRows.cancel).toHaveBeenCalledTimes(1);
  });

  it("reports PostgreSQL statement cancellation as a timeout when the client is connected", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.sql = {
      begin: vi.fn().mockRejectedValue(Object.assign(new Error("statement timeout"), {
        code: "57014",
      })),
    };

    await expect(source.transaction(() => undefined)).rejects.toMatchObject({
      code: "flame_database_timeout",
    });
  });

  it("pages canonical work evidence with an opaque timestamp/event cursor", async () => {
    const header = {
      session_id: SESSION_ID,
      semantic_role: "agent",
      first_at: new Date("2026-08-16T12:00:00.000Z"),
      last_at: new Date("2026-08-16T12:00:03.000Z"),
      event_count: 2,
      summary: "Build it",
    };
    const items = [{
      ...header,
      id: "41",
      observed_at: new Date("2026-08-16T12:00:01.000Z"),
      observed_at_microseconds: "1786881601000000",
      message_role: "user",
      content_byte_size: 8,
      content_excerpt: "Build it",
    }, {
      ...header,
      id: "42",
      observed_at: new Date("2026-08-16T12:00:02.000Z"),
      observed_at_microseconds: "1786881602000000",
      message_role: "assistant",
      content_byte_size: 12,
      content_excerpt: "Patched it.",
    }];
    const { source, unsafe } = mockSource(
      [{ now: new Date("2026-08-17T12:00:02.000Z") }], items,
    );

    const detail = await source.fetchWork(workRequest({ limit: "1" }));

    expect(unsafe.mock.calls).toHaveLength(2);
    expect(unsafe.mock.calls[1][0]).toBe(WORK_DETAIL_SQL);
    expect(unsafe.mock.calls[1][1].at(-1)).toBe(2);
    expect(detail.items).toEqual([expect.objectContaining({
      id: "41",
      role: "user",
      content: "Build it",
      truncated: false,
    })]);
    expect(detail.nextCursor).toMatch(/^v1\./);
    expect(decodeWorkCursor(detail.nextCursor)).toEqual({
      atMicroseconds: "1786881601000000",
      id: "41",
    });
    expect(detail).toMatchObject({
      workId: `${SESSION_ID}:agent`,
      eventCount: 2,
    });
  });

  it("returns detail metadata when the selected conversation page is empty", async () => {
    const { source, unsafe } = mockSource(
      [{ now: new Date("2026-08-17T12:00:02.000Z") }], [{
        session_id: SESSION_ID,
        semantic_role: "unclassified",
        first_at: new Date("2026-08-16T12:00:00.000Z"),
        last_at: new Date("2026-08-16T12:00:03.000Z"),
        event_count: 3,
        summary: null,
        id: null,
        observed_at: null,
        observed_at_microseconds: null,
        message_role: null,
        content_byte_size: null,
        content_excerpt: null,
      }],
    );

    const detail = await source.fetchWork(workRequest({ role: "unclassified" }));

    expect(unsafe).toHaveBeenCalledTimes(2);
    expect(unsafe.mock.calls[1][0]).toBe(WORK_DETAIL_SQL);
    expect(detail).toMatchObject({
      workId: `${SESSION_ID}:unclassified`,
      sessionId: SESSION_ID,
      role: "unclassified",
      eventCount: 3,
      items: [],
      nextCursor: null,
    });

    unsafe.mockReset()
      .mockResolvedValueOnce([{ now: new Date("2026-08-17T12:00:02.000Z") }])
      .mockResolvedValueOnce([]);
    await expect(source.fetchWork(workRequest({ role: "unclassified" })))
      .rejects.toMatchObject({ code: "flame_work_request_not_found" });
    expect(unsafe).toHaveBeenCalledTimes(2);
  });

  it("round-trips work cursors and enforces page bounds", async () => {
    const cursor = encodeWorkCursor({ atMicroseconds: "1786881600123456", id: "99" });
    expect(decodeWorkCursor(cursor)).toEqual({
      atMicroseconds: "1786881600123456",
      id: "99",
    });
    expect(() => decodeWorkCursor("v1.not+base64")).toThrow(FlameSourceError);
    const overflowing = Buffer.from(JSON.stringify([
      "1786881600123456", "9223372036854775808",
    ])).toString("base64url");
    expect(() => decodeWorkCursor(`v1.${overflowing}`)).toThrow(FlameSourceError);
    expect(DEFAULT_WORK_DETAIL_LIMIT).toBe(50);
    expect(MAX_WORK_DETAIL_LIMIT).toBe(100);

    const { source } = mockSource();
    source.transaction = vi.fn();
    await expect(source.fetchWork(workRequest({ limit: "101" })))
      .rejects.toMatchObject({ code: "flame_work_request_invalid" });
    expect(source.transaction).not.toHaveBeenCalled();
  });

  it("returns one capped canonical MCP prompt sample", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    const personId = "22222222-2222-4222-8222-222222222222";
    const rows = Array.from({ length: 5 }, (_, index) => ({
      content_byte_size: index === 0 ? 20 : 8,
      content_excerpt: index === 0 ? "Short" : `Prompt ${index}`,
      eligible_prompt_count: 8,
    }));
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{ now: new Date("2026-08-17T12:00:02.000Z") }])
      .mockResolvedValueOnce(rows);
    const array = vi.fn((values) => values);
    source.transaction = (callback) => callback({ unsafe, array });
    const snapshot = encodeSnapshotToken({ snapshot: PG_SNAPSHOT, read: READ });

    const result = await source.fetchPromptEvidence({
      personId,
      start: START.toISOString(),
      snapshot,
    });

    expect(unsafe.mock.calls[1][0]).toBe(INTERVAL_PROMPTS_SQL);
    expect(array).toHaveBeenCalledWith(NORMALIZER_VERSIONS);
    expect(unsafe.mock.calls[1][1][3]).toEqual(NORMALIZER_VERSIONS);
    expect(unsafe.mock.calls[1][1].at(-1)).toBe(5);
    expect(result.eligiblePromptCount).toBe(8);
    expect(result.prompts).toHaveLength(5);
    expect(result.prompts[0]).toEqual({
      excerpt: "Short",
      excerptTruncated: true,
    });
  });

  it("serves a v2 MCP sample from projected prompt identities", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    const personId = "22222222-2222-4222-8222-222222222222";
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{ now: new Date("2026-08-17T12:00:02.000Z") }])
      .mockResolvedValueOnce([{
        content_byte_size: 9,
        content_excerpt: "Projected",
        eligible_prompt_count: 1,
      }]);
    source.transaction = (callback) => callback({ unsafe });

    const result = await source.fetchPromptEvidence({
      personId,
      start: START.toISOString(),
      snapshot: encodeProjectionSnapshotToken({
        snapshot: PG_SNAPSHOT,
        read: READ,
        frameVersion: FRAME_VERSION,
      }),
    });

    expect(unsafe.mock.calls[1][0]).toBe(PROJECTION_INTERVAL_PROMPTS_SQL);
    expect(unsafe.mock.calls[1][1].at(-1)).toBe(MCP_PROMPT_EVIDENCE_LIMIT);
    expect(result).toMatchObject({
      eligiblePromptCount: 1,
      prompts: [{ excerpt: "Projected", excerptTruncated: false }],
    });
  });

});
