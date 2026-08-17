import { describe, expect, it } from "vitest";

import {
  BUCKET_COUNT,
  BUCKET_MS,
  FlameDataError,
  adaptFlamePayload,
  adaptPromptEvidence,
  createTimeAxisTicks,
  getGlobalPeak,
} from "./flame-data.js";

function buckets() {
  return Array.from({ length: BUCKET_COUNT }, () => [0, 0, 0, 0]);
}

function person(overrides = {}) {
  return {
    id: "person-1",
    name: "Ada",
    total: [3, 2, 1],
    buckets: buckets(),
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    start: "2026-03-08T08:00:00.000Z",
    read: "2026-03-09T08:00:01.000Z",
    snapshot: "v1.snapshot-token",
    latest: null,
    coverage: {
      evidence: "observed_events",
      state: "partial",
      reason: "event_presence_not_continuous_attention",
    },
    people: [person()],
    ...overrides,
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

describe("adaptFlamePayload", () => {
  it("preserves person and bucket order while deriving exact interval timestamps", () => {
    const firstBuckets = buckets();
    firstBuckets[0] = [1, 0, 0, 4];
    firstBuckets[1] = [0, 2, 1, 0];
    firstBuckets[72] = [3, 0, 0, 1];
    firstBuckets[143] = [0, 1, 0, 0];
    const source = payload({
      people: [
        person({ id: "z", name: "First", buckets: firstBuckets }),
        person({ id: "a", name: "Second" }),
      ],
    });

    const result = adaptFlamePayload(source);
    const startMs = Date.parse(source.start);

    expect(result.people.map(({ id }) => id)).toEqual(["z", "a"]);
    expect(result.coverage).toEqual({
      evidence: "observed_events",
      state: "partial",
      reason: "event_presence_not_continuous_attention",
    });
    expect(result.snapshot).toBe("v1.snapshot-token");
    expect(result.people[0].buckets.map(({ index }) => index)).toEqual(
      Array.from({ length: BUCKET_COUNT }, (_, index) => index),
    );
    for (const index of [0, 1, 72, 143]) {
      expect(result.people[0].buckets[index]).toMatchObject({
        index,
        startMs: startMs + index * BUCKET_MS,
        endMs: startMs + (index + 1) * BUCKET_MS,
      });
    }
    expect(result.people[0].buckets[1]).toMatchObject({
      agent: 0,
      subagent: 2,
      unclassified: 1,
      prompts: 0,
      activity: 3,
    });
  });

  it("uses absolute elapsed time through a DST boundary", () => {
    const source = payload({
      start: "2026-03-08T00:00:00-08:00",
      read: "2026-03-09T01:00:00-07:00",
    });

    const result = adaptFlamePayload(source);

    expect(result.people[0].buckets[12].startMs - result.startMs).toBe(
      2 * 60 * 60 * 1000,
    );
    expect(result.people[0].buckets[143].endMs - result.startMs).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(result.axisTicks.at(-1) - result.axisTicks[0]).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  it("preserves prompt-only, all-zero, and repeated-thread buckets", () => {
    const sourceBuckets = buckets();
    sourceBuckets[0] = [1, 0, 0, 0];
    sourceBuckets[1] = [1, 0, 0, 0];
    sourceBuckets[2] = [0, 0, 0, 7];
    const result = adaptFlamePayload(
      payload({
        people: [
          person({ total: [1, 0, 0], buckets: sourceBuckets }),
          person({ id: "person-2", name: "Zero", total: [0, 0, 0] }),
        ],
      }),
    );

    expect(result.people[0].total).toEqual([1, 0, 0]);
    expect(result.people[0].buckets[0].activity).toBe(1);
    expect(result.people[0].buckets[1].activity).toBe(1);
    expect(result.people[0].buckets[2]).toMatchObject({ prompts: 7, activity: 0 });
    expect(result.people[0].buckets[3]).toMatchObject({ prompts: 0, activity: 0 });
    expect(result.people[1].total).toEqual([0, 0, 0]);
    expect(result.people[1].buckets.every(({ activity }) => activity === 0)).toBe(true);
    expect(result.globalPeak).toBe(1);
  });

  it("does not mutate or retain compact input arrays", () => {
    const source = deepFreeze(payload());
    const result = adaptFlamePayload(source);

    expect(result.people[0].total).not.toBe(source.people[0].total);
    expect(result.people[0].buckets).not.toBe(source.people[0].buckets);
    expect(source.people[0].buckets[0]).toEqual([0, 0, 0, 0]);
  });

  it.each([
    ["non-object payload", null],
    ["invalid start", payload({ start: "not-a-date" })],
    ["invalid read", payload({ read: null })],
    ["invalid latest", payload({ latest: "not-a-date" })],
    ["empty people", payload({ people: [] })],
    ["non-string id", payload({ people: [person({ id: 17 })] })],
    ["blank id", payload({ people: [person({ id: "  " })] })],
    ["blank name", payload({ people: [person({ name: "" })] })],
    ["short total", payload({ people: [person({ total: [1, 2] })] })],
    ["negative total", payload({ people: [person({ total: [-1, 2, 3] })] })],
    ["fractional total", payload({ people: [person({ total: [1.5, 2, 3] })] })],
    [
      "unsafe total",
      payload({ people: [person({ total: [Number.MAX_SAFE_INTEGER + 1, 2, 3] })] }),
    ],
    ["short buckets", payload({ people: [person({ buckets: buckets().slice(1) })] })],
    [
      "long buckets",
      payload({ people: [person({ buckets: [...buckets(), [0, 0, 0, 0]] })] }),
    ],
    [
      "short tuple",
      (() => {
        const values = buckets();
        values[4] = [0, 0, 0];
        return payload({ people: [person({ buckets: values })] });
      })(),
    ],
    [
      "negative bucket count",
      (() => {
        const values = buckets();
        values[4] = [-1, 0, 0, 0];
        return payload({ people: [person({ buckets: values })] });
      })(),
    ],
    [
      "fractional bucket count",
      (() => {
        const values = buckets();
        values[4] = [0, 0, 0, 0.5];
        return payload({ people: [person({ buckets: values })] });
      })(),
    ],
    [
      "bucket role above daily total",
      (() => {
        const values = buckets();
        values[4] = [4, 0, 0, 0];
        return payload({ people: [person({ buckets: values })] });
      })(),
    ],
  ])("rejects %s", (_description, source) => {
    expect(() => adaptFlamePayload(source)).toThrow(FlameDataError);
  });

  it("rejects duplicate stable person ids", () => {
    const source = payload({
      people: [person(), person({ name: "Grace" })],
    });

    expect(() => adaptFlamePayload(source)).toThrow(/id must be unique/);
  });

  it("preserves explicit observed-event coverage", () => {
    const result = adaptFlamePayload(payload({
      coverage: {
        evidence: "observed_events",
        state: "partial",
        reason: "event_presence_not_continuous_attention",
      },
    }));

    expect(result.coverage.evidence).toBe("observed_events");
    expect(result.coverage.reason).toBe("event_presence_not_continuous_attention");
  });

  it("rejects missing or legacy aggregate coverage", () => {
    const missing = payload();
    delete missing.coverage;
    expect(() => adaptFlamePayload(missing)).toThrow(FlameDataError);
    expect(() => adaptFlamePayload(payload({
      coverage: { evidence: "aggregate", state: "partial", reason: "legacy" },
    }))).toThrow(FlameDataError);
  });
});

describe("adaptPromptEvidence", () => {
  const startMs = Date.parse("2026-08-17T16:10:00.000Z");
  const snapshot = "v1.snapshot-token";

  it("validates and expands every prompt in the selected bucket", () => {
    expect(adaptPromptEvidence({
      personId: "person-1",
      start: new Date(startMs).toISOString(),
      snapshot,
      prompts: [
        {
          id: "10",
          at: "2026-08-17T16:10:08.631Z",
          content: "Investigate the dashboard counts",
          truncated: false,
        },
        {
          id: "11",
          at: "2026-08-17T16:19:59.999Z",
          content: "A long stored excerpt",
          truncated: true,
        },
      ],
    }, { personId: "person-1", startMs, snapshot })).toEqual([
      {
        id: "10",
        atMs: Date.parse("2026-08-17T16:10:08.631Z"),
        content: "Investigate the dashboard counts",
        truncated: false,
      },
      {
        id: "11",
        atMs: Date.parse("2026-08-17T16:19:59.999Z"),
        content: "A long stored excerpt",
        truncated: true,
      },
    ]);
  });

  it.each([
    ["wrong person", { personId: "other", start: new Date(startMs).toISOString(), snapshot, prompts: [] }],
    ["wrong bucket", { personId: "person-1", start: new Date(startMs + BUCKET_MS).toISOString(), snapshot, prompts: [] }],
    ["wrong snapshot", { personId: "person-1", start: new Date(startMs).toISOString(), snapshot: "v1.other", prompts: [] }],
    ["prompt outside bucket", {
      personId: "person-1",
      start: new Date(startMs).toISOString(),
      snapshot,
      prompts: [{ id: "10", at: new Date(startMs + BUCKET_MS).toISOString(), content: "x", truncated: false }],
    }],
  ])("rejects %s", (_label, value) => {
    expect(() => adaptPromptEvidence(value, { personId: "person-1", startMs, snapshot }))
      .toThrow(FlameDataError);
  });
});

describe("chart helpers", () => {
  it("builds inclusive two-hour axis ticks", () => {
    const ticks = createTimeAxisTicks(Date.parse("2026-01-01T00:00:00Z"));

    expect(ticks).toHaveLength(13);
    expect(ticks[1] - ticks[0]).toBe(2 * 60 * 60 * 1000);
    expect(ticks.at(-1) - ticks[0]).toBe(24 * 60 * 60 * 1000);
  });

  it("finds a global peak including unclassified activity", () => {
    const values = buckets();
    values[9] = [1, 2, 3, 100];
    const adapted = adaptFlamePayload(
      payload({ people: [person({ total: [1, 2, 3], buckets: values })] }),
    );

    expect(getGlobalPeak(adapted.people)).toBe(6);
    expect(adapted.globalPeak).toBe(6);
  });
});
