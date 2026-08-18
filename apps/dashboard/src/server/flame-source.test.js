import { describe, expect, it, vi } from "vitest";

import {
  BUCKET_COUNT,
  BUCKET_MS,
  DEFAULT_WORK_DETAIL_LIMIT,
  FLAME_SQL,
  INTERVAL_WORK_SQL,
  MAX_WORK_DETAIL_LIMIT,
  PEOPLE_SQL,
  WORK_DETAIL_SQL,
  ASSISTANT_REPRESENTATION_MATCH_SECONDS,
  DirectFlameSource,
  UNKEYED_PROMPT_REPRESENTATION_MILLISECONDS,
  UNKEYED_PROMPT_MATCH_SECONDS,
  FlameSourceError,
  buildFlamePayload,
  decodeWorkCursor,
  decodeSnapshotToken,
  encodeWorkCursor,
  encodeSnapshotToken,
} from "./flame-source.js";

const START = new Date("2026-08-16T12:00:00.000Z");
const READ = new Date("2026-08-17T12:00:01.000Z");
const PG_SNAPSHOT = "730:741:733,739";

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

describe("Sherlock Flame payload", () => {
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

  it("rejects incomplete result grids", () => {
    expect(() => buildFlamePayload({
      rows: rowsFor("ada").slice(1),
      roster: [{ person_id: "ada", display_name: "Ada" }],
      start: START,
      read: START,
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
    expect(FLAME_SQL).toContain(
      "where canonical_rank = 1\n     and observed_at >= date_trunc('milliseconds', session_started_at)",
    );
    expect(FLAME_SQL).toContain("'task_started', 'task_complete', 'turn_started', 'turn_complete'");
    expect(FLAME_SQL).not.toContain("analytics.activity_spans");
    expect(FLAME_SQL).toContain("$1::uuid");
    expect(FLAME_SQL).not.toContain("content_excerpt");
    expect(FLAME_SQL).not.toContain("email");
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

  it("excludes stable smoke identities from the complete roster", () => {
    expect(PEOPLE_SQL).toContain("github_id is distinct from 'sherlock-smoke'");
    expect(FLAME_SQL).toContain("github_id is distinct from 'sherlock-smoke'");
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

    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(decodeSnapshotToken(token)).toEqual({ snapshot: PG_SNAPSHOT, read: READ });
  });

  it.each([
    "",
    "v2.Zm9v",
    "v1.not+base64url",
    "v1.WyIxOjI6MyIsIjIwMjYtMDgtMTdUMTI6MDA6MDEuMDAwWiJd",
  ])("rejects invalid prompt snapshot token %s", (token) => {
    expect(() => decodeSnapshotToken(token)).toThrow(FlameSourceError);
  });

  it("captures the aggregate snapshot in the same transaction as its rows", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    source.maxPeople = 5;
    const roster = [{ person_id: "ada", display_name: "Ada" }];
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{ now: READ, snapshot: PG_SNAPSHOT }])
      .mockResolvedValueOnce(roster)
      .mockResolvedValueOnce(rowsFor("ada"));
    source.transaction = (callback) => callback({ unsafe });

    const payload = await source.fetchDay();

    expect(unsafe.mock.calls[0][0]).toContain("pg_current_snapshot()::text as snapshot");
    expect(decodeSnapshotToken(payload.snapshot)).toEqual({
      snapshot: PG_SNAPSHOT,
      read: READ,
    });
    expect(unsafe.mock.calls[2][1]).toEqual([
      source.workspaceId,
      START.toISOString(),
      "2026-08-17T12:00:00.000Z",
      "sherlock.codex-rollout.v1",
      READ.toISOString(),
    ]);
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
      expect(sql).toContain("e.normalizer_version = p.normalizer_version");
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
      expect(sql).not.toContain("analytics.activity_spans");
    }
    expect(INTERVAL_WORK_SQL).toContain("group by session_id, semantic_role");
    expect(INTERVAL_WORK_SQL).toContain("and s.person_id = p.person_id");
    expect(INTERVAL_WORK_SQL).toContain("limit $10");
    expect(WORK_DETAIL_SQL).toContain("and e.session_id = p.session_id");
    expect(WORK_DETAIL_SQL).toContain(") > (p.cursor_at_microseconds, p.cursor_id)");
    expect(WORK_DETAIL_SQL).toContain("order by selected.observed_at, selected.id");
    expect(WORK_DETAIL_SQL).toContain("limit $14");
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
      }]);
    source.transaction = (callback) => callback({ unsafe });
    const snapshot = encodeSnapshotToken({ snapshot: PG_SNAPSHOT, read: READ });

    const interval = await source.fetchInterval({
      personId,
      start: START.toISOString(),
      snapshot,
    });

    expect(unsafe.mock.calls[1][0]).toBe(INTERVAL_WORK_SQL);
    expect(unsafe.mock.calls[1][1].at(-1)).toBe(201);
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
      }],
    });
  });

  it("pages canonical work evidence with an opaque timestamp/event cursor", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    const personId = "22222222-2222-4222-8222-222222222222";
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const header = {
      session_id: sessionId,
      semantic_role: "agent",
      first_at: new Date("2026-08-16T12:00:00.000Z"),
      last_at: new Date("2026-08-16T12:00:03.000Z"),
      event_count: 2,
      summary: "Build it",
    };
    const items = [{
      id: "41",
      observed_at: new Date("2026-08-16T12:00:01.000Z"),
      observed_at_microseconds: "1786881601000000",
      message_role: "user",
      content_byte_size: 8,
      content_excerpt: "Build it",
    }, {
      id: "42",
      observed_at: new Date("2026-08-16T12:00:02.000Z"),
      observed_at_microseconds: "1786881602000000",
      message_role: "assistant",
      content_byte_size: 12,
      content_excerpt: "Patched it.",
    }];
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{ now: new Date("2026-08-17T12:00:02.000Z") }])
      .mockResolvedValueOnce([header])
      .mockResolvedValueOnce(items);
    source.transaction = (callback) => callback({ unsafe });
    const snapshot = encodeSnapshotToken({ snapshot: PG_SNAPSHOT, read: READ });

    const detail = await source.fetchWork({
      personId,
      start: START.toISOString(),
      sessionId,
      role: "agent",
      snapshot,
      limit: "1",
    });

    expect(unsafe.mock.calls[2][0]).toBe(WORK_DETAIL_SQL);
    expect(unsafe.mock.calls[2][1].at(-1)).toBe(2);
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
      workId: `${sessionId}:agent`,
      eventCount: 2,
    });
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

    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    source.transaction = vi.fn();
    await expect(source.fetchWork({
      personId: "22222222-2222-4222-8222-222222222222",
      start: START.toISOString(),
      sessionId: "33333333-3333-4333-8333-333333333333",
      role: "agent",
      snapshot: encodeSnapshotToken({ snapshot: PG_SNAPSHOT, read: READ }),
      limit: "101",
    })).rejects.toMatchObject({ code: "flame_work_request_invalid" });
    expect(source.transaction).not.toHaveBeenCalled();
  });
});
