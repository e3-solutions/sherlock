import { describe, expect, it } from "vitest";

import {
  BUCKET_COUNT,
  BUCKET_MS,
  FLAME_SQL,
  PEOPLE_SQL,
  PROMPT_DETAIL_SQL,
  FlameSourceError,
  buildFlamePayload,
} from "./flame-source.js";

const START = new Date("2026-08-16T12:00:00.000Z");

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
      },
    });
    for (const row of ada) {
      row.day_agent = 1;
      row.day_subagent = 2;
      row.day_other = 1;
      row.latest = new Date("2026-08-16T12:09:00.000Z");
    }
    const zero = rowsFor("zero");
    const payload = buildFlamePayload({
      rows: [...ada, ...zero],
      roster: [
        { person_id: "ada", display_name: "Ada" },
        { person_id: "zero", display_name: "Zero Activity" },
      ],
      start: START,
      read: new Date("2026-08-17T12:00:01.000Z"),
    });

    expect(payload.people).toHaveLength(2);
    expect(payload.people[0]).toMatchObject({
      id: "ada",
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
  });

  it("rejects incomplete result grids", () => {
    expect(() => buildFlamePayload({
      rows: rowsFor("ada").slice(1),
      roster: [{ person_id: "ada", display_name: "Ada" }],
      start: START,
      read: START,
    })).toThrow(FlameSourceError);
  });

  it("uses observed event evidence instead of inferred continuous spans", () => {
    expect(FLAME_SQL).toContain("e.workspace_id = p.workspace_id");
    expect(FLAME_SQL).toContain("date_bin(interval '10 minutes', a.observed_at");
    expect(FLAME_SQL).toContain("s.actor_role = 'primary'");
    expect(FLAME_SQL).not.toContain("analytics.activity_spans");
    expect(FLAME_SQL).toContain("$1::uuid");
    expect(FLAME_SQL).not.toContain("content_excerpt");
    expect(FLAME_SQL).not.toContain("email");
  });

  it("excludes stable smoke identities from the complete roster", () => {
    expect(PEOPLE_SQL).toContain("github_id is distinct from 'sherlock-smoke'");
    expect(FLAME_SQL).toContain("github_id is distinct from 'sherlock-smoke'");
  });

  it("deduplicates primary prompts by stable native item before returning details", () => {
    expect(FLAME_SQL).toContain("matching_native_item_id");
    expect(FLAME_SQL).toContain("has_submitted_user_message");
    expect(FLAME_SQL).toContain("partition by session_id, prompt_identity");
    expect(PROMPT_DETAIL_SQL).toContain("content_excerpt");
    expect(PROMPT_DETAIL_SQL).toContain("where person_id = $5::uuid");
    expect(PROMPT_DETAIL_SQL).toContain("limit $6");
  });
});
