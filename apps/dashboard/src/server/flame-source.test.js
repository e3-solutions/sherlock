import { describe, expect, it, vi } from "vitest";

import {
  BUCKET_COUNT,
  BUCKET_MS,
  FLAME_SQL,
  PEOPLE_SQL,
  PROMPT_DETAIL_SQL,
  DirectFlameSource,
  UNKEYED_PROMPT_MATCH_SECONDS,
  FlameSourceError,
  buildFlamePayload,
  decodeSnapshotToken,
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

  it("rejects incomplete result grids", () => {
    expect(() => buildFlamePayload({
      rows: rowsFor("ada").slice(1),
      roster: [{ person_id: "ada", display_name: "Ada" }],
      start: START,
      read: START,
      snapshot: PG_SNAPSHOT,
    })).toThrow(FlameSourceError);
  });

  it("uses observed event evidence instead of inferred continuous spans", () => {
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

  it("excludes stable smoke identities from the complete roster", () => {
    expect(PEOPLE_SQL).toContain("github_id is distinct from 'sherlock-smoke'");
    expect(FLAME_SQL).toContain("github_id is distinct from 'sherlock-smoke'");
  });

  it("canonically selects submitted primary prompts before returning details", () => {
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
    expect(PROMPT_DETAIL_SQL).toContain("content_excerpt");
    expect(PROMPT_DETAIL_SQL).toContain("$5::pg_snapshot snapshot");
    expect(PROMPT_DETAIL_SQL).toContain(
      "pg_visible_in_snapshot(e.xmin::text::xid8, p.snapshot)",
    );
    expect(PROMPT_DETAIL_SQL).toContain("where person_id = $6::uuid");
    expect(PROMPT_DETAIL_SQL).toContain("$7::timestamptz bucket_start");
    expect(PROMPT_DETAIL_SQL).toContain("observed_at >= (select bucket_start from p)");
    expect(PROMPT_DETAIL_SQL).toContain("limit $9");
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
  });

  it("pins prompt details to the aggregate snapshot and echoes its receipt", async () => {
    const source = Object.create(DirectFlameSource.prototype);
    source.workspaceId = "11111111-1111-4111-8111-111111111111";
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{ now: new Date("2026-08-17T12:00:02.000Z") }])
      .mockResolvedValueOnce([{
        id: "17",
        observed_at: new Date("2026-08-16T12:00:08.000Z"),
        content: "Stable snapshot prompt",
        content_byte_size: 22,
        excerpt_byte_size: 22,
      }]);
    source.transaction = (callback) => callback({ unsafe });
    const snapshot = encodeSnapshotToken({ snapshot: PG_SNAPSHOT, read: READ });

    const detail = await source.fetchPrompts({
      personId: "22222222-2222-4222-8222-222222222222",
      start: START.toISOString(),
      snapshot,
    });

    expect(unsafe.mock.calls[1][0]).toBe(PROMPT_DETAIL_SQL);
    expect(unsafe.mock.calls[1][1]).toEqual([
      source.workspaceId,
      START.toISOString(),
      "2026-08-17T12:00:00.000Z",
      "sherlock.codex-rollout.v1",
      PG_SNAPSHOT,
      "22222222-2222-4222-8222-222222222222",
      START.toISOString(),
      new Date(START.getTime() + BUCKET_MS).toISOString(),
      501,
    ]);
    expect(detail).toMatchObject({
      personId: "22222222-2222-4222-8222-222222222222",
      start: START.toISOString(),
      snapshot,
      prompts: [{ id: "17", content: "Stable snapshot prompt" }],
    });
  });

  it("uses stable prompt identifiers before a bounded unkeyed format bridge", () => {
    expect(UNKEYED_PROMPT_MATCH_SECONDS).toBe(2);
    expect(FLAME_SQL).toContain("native_identity_candidates as materialized");
    expect(FLAME_SQL).not.toContain("partition by session_id, native_item_id");
    expect(FLAME_SQL).toContain("'logical:' || canonical_scope_key || ':' || normalizer_version");
    expect(FLAME_SQL).toContain("'native:' || submitted.native_item_id");
    expect(FLAME_SQL).toContain("'native:' || paired.matched_native_item_id");
    expect(FLAME_SQL).toContain("'event:' || submitted.id::text");
    expect(FLAME_SQL).toContain("cross join lateral");
    expect(FLAME_SQL).toContain(
      "candidate.native_source_observed_at - submitted.source_observed_at",
    );
    expect(FLAME_SQL).toContain("native.native_observed_at matched_native_observed_at");
    expect(FLAME_SQL).toContain("candidate.native_item_id, candidate.id");
    expect(FLAME_SQL).toContain("interval '2 seconds'");
    expect(FLAME_SQL).not.toContain("date_trunc(\n                          'second'");
    expect(FLAME_SQL).not.toContain("matching_native_item_id");
    expect(FLAME_SQL).not.toContain("has_submitted_user_message");
    expect(FLAME_SQL).not.toContain(
      "unkeyed_native_candidates as materialized",
    );
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
});
