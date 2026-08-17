import { describe, expect, it } from "vitest";

import {
  BUCKET_COUNT,
  BUCKET_MS,
  FLAME_SQL,
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
      evidence: "aggregate",
      state: "partial",
      reason: "workspace_snapshot_activation_unavailable",
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

  it("keeps the SQL tenant-scoped, bounded, content-free, and parameterized", () => {
    expect(FLAME_SQL).toContain("e.workspace_id = p.workspace_id");
    expect(FLAME_SQL).toContain("a.started_at < p.end_at");
    expect(FLAME_SQL).toContain("$1::uuid");
    expect(FLAME_SQL).not.toContain("content_excerpt");
    expect(FLAME_SQL).not.toContain("email");
  });
});
