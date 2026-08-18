import { describe, expect, it } from "vitest";

import {
  BUCKET_COUNT,
  BUCKET_MS,
  FlameDataError,
  adaptFlamePayload,
  adaptIntervalEvidence,
  adaptWorkEvidence,
  createTimeAxisTicks,
  getGlobalPeak,
  getPersonActivityStatus,
} from "./flame-data.js";

function buckets() {
  return Array.from({ length: BUCKET_COUNT }, () => [0, 0, 0, 0]);
}

function person(overrides = {}) {
  return {
    id: "person-1",
    name: "Ada",
    activeSeconds: 0,
    lastActivity: null,
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
        person({ id: "z", name: "First", activeSeconds: 2_400, buckets: firstBuckets }),
        person({ id: "a", name: "Second" }),
      ],
    });

    const result = adaptFlamePayload(source);
    const startMs = Date.parse(source.start);

    expect(result.people.map(({ id }) => id)).toEqual(["z", "a"]);
    expect(result.people.map(({ lastActivityMs }) => lastActivityMs)).toEqual([
      null,
      null,
    ]);
    expect(result.people.map(({ activeSeconds }) => activeSeconds)).toEqual([2_400, 0]);
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
          person({ activeSeconds: 1_200, total: [1, 0, 0], buckets: sourceBuckets }),
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
    ["missing active seconds", payload({ people: [person({ activeSeconds: undefined })] })],
    ["negative active seconds", payload({ people: [person({ activeSeconds: -1 })] })],
    ["fractional active seconds", payload({ people: [person({ activeSeconds: 1.5 })] })],
    ["more than 24 hours active", payload({ people: [person({ activeSeconds: 86_401 })] })],
    [
      "active seconds disagree with occupied buckets",
      (() => {
        const values = buckets();
        values[0] = [1, 0, 0, 0];
        return payload({
          people: [person({ activeSeconds: 0, total: [1, 0, 0], buckets: values })],
        });
      })(),
    ],
    ["missing last activity", payload({ people: [person({ lastActivity: undefined })] })],
    ["future last activity", payload({
      people: [person({ lastActivity: "2026-03-09T08:00:02.000Z" })],
    })],
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

describe("getPersonActivityStatus", () => {
  const readMs = Date.parse("2026-03-09T08:00:01.000Z");

  function adaptedPerson(lastActivity) {
    return adaptFlamePayload(payload({
      people: [person({ lastActivity })],
    })).people[0];
  }

  it("is active when canonical activity was observed in the last ten minutes", () => {
    const adapted = adaptedPerson("2026-03-09T07:50:01.000Z");

    expect(getPersonActivityStatus(adapted, readMs)).toBe("active");
  });

  it("is recent when canonical activity was observed ten to thirty minutes ago", () => {
    const adapted = adaptedPerson("2026-03-09T07:30:01.000Z");

    expect(getPersonActivityStatus(adapted, readMs)).toBe("recent");
  });

  it("is inactive when activity is older than thirty minutes or absent", () => {
    const old = adaptedPerson("2026-03-09T07:30:00.000Z");
    const absent = adaptedPerson(null);

    expect(getPersonActivityStatus(old, readMs)).toBe("inactive");
    expect(getPersonActivityStatus(absent, readMs)).toBe("inactive");
  });
});

describe("interval and work evidence adapters", () => {
  const startMs = Date.parse("2026-08-17T16:10:00.000Z");
  const expected = {
    personId: "person-1", startMs, snapshot: "v1.snapshot-token", promptCount: 1,
  };

  it("validates source-backed work rows", () => {
    const result = adaptIntervalEvidence({
      personId: expected.personId,
      start: new Date(startMs).toISOString(),
      snapshot: expected.snapshot,
      work: [{
        id: "s1:agent", sessionId: "s1", role: "agent",
        firstAt: new Date(startMs + 1000).toISOString(),
        lastAt: new Date(startMs + 5000).toISOString(), eventCount: 2,
        summary: "Investigate the cursor",
      }],
      prompts: [{
        id: "native:msg-1", sessionId: "s1",
        at: new Date(startMs + 1500).toISOString(),
        content: "Investigate the cursor", truncated: false,
      }],
    }, expected);

    expect(result.work[0]).toMatchObject({
      id: "s1:agent", sessionId: "s1", role: "agent", eventCount: 2,
    });
    expect(result.prompts).toEqual([expect.objectContaining({
      id: "native:msg-1", content: "Investigate the cursor",
    })]);
  });

  it("rejects prompt rows whose identities do not match the aggregate count", () => {
    expect(() => adaptIntervalEvidence({
      personId: expected.personId,
      start: new Date(startMs).toISOString(),
      snapshot: expected.snapshot,
      work: [],
      prompts: [],
    }, expected)).toThrow(/exactly 1 canonical prompt rows/);
  });

  it("preserves equal conversation text under distinct source event ids", () => {
    const result = adaptWorkEvidence({
      personId: expected.personId,
      start: new Date(startMs).toISOString(),
      snapshot: expected.snapshot,
      workId: "s1:agent",
      sessionId: "s1",
      role: "agent",
      firstAt: new Date(startMs + 1000).toISOString(),
      lastAt: new Date(startMs + 5000).toISOString(),
      eventCount: 2,
      items: [{
        id: "e1", at: new Date(startMs + 2000).toISOString(), role: "assistant",
        content: "Tracing it now", truncated: false,
      }, {
        id: "e2", at: new Date(startMs + 3000).toISOString(), role: "assistant",
        content: "Tracing it now", truncated: false,
      }],
      nextCursor: "cursor-2",
    }, { ...expected, workId: "s1:agent", sessionId: "s1", role: "agent" });

    expect(result.items[0]).toMatchObject({ role: "assistant" });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.id)).toEqual(["e1", "e2"]);
    expect(result.nextCursor).toBe("cursor-2");
  });

  it.each([
    ["unsupported semantic role", { role: "supervisor" }],
  ])("rejects %s", (_label, mutation) => {
    const work = {
      id: "s1:agent", sessionId: "s1", role: "agent",
      firstAt: new Date(startMs + 1000).toISOString(),
      lastAt: new Date(startMs + 5000).toISOString(), eventCount: 2,
      summary: null,
    };
    const source = {
      personId: expected.personId,
      start: new Date(startMs).toISOString(),
      snapshot: expected.snapshot,
      work: [{ ...work, ...mutation }],
    };
    expect(() => adaptIntervalEvidence(source, expected)).toThrow(FlameDataError);
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
      payload({
        people: [person({ activeSeconds: 600, total: [1, 2, 3], buckets: values })],
      }),
    );

    expect(getGlobalPeak(adapted.people)).toBe(6);
    expect(adapted.globalPeak).toBe(6);
  });
});
