export const BUCKET_COUNT = 144;
export const BUCKET_MS = 10 * 60 * 1000;

const TOTAL_COUNT = 3;
const BUCKET_VALUE_COUNT = 4;
const AXIS_INTERVAL_BUCKETS = 12;
const MAX_ACTIVE_SECONDS = 24 * 60 * 60;

export class FlameDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "FlameDataError";
  }
}

function fail(path, expectation) {
  throw new FlameDataError(`${path} must be ${expectation}`);
}

function requireObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "an object");
  }
  return value;
}

function requireNonemptyString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "a nonempty string");
  }
  return value;
}

function requireDate(value, path, nullable = false) {
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, nullable ? "null or a parseable date" : "a parseable date");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail(path, nullable ? "null or a parseable date" : "a parseable date");
  }
  return parsed;
}

function requireCount(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(path, "a nonnegative safe integer");
  }
  return value;
}

function requireFixedCounts(value, length, path) {
  if (!Array.isArray(value) || value.length !== length) {
    fail(path, `an array of exactly ${length} counts`);
  }
  return value.map((count, index) => requireCount(count, `${path}[${index}]`));
}

function safeActivity(agent, subagent, unclassified, path) {
  const activity = agent + subagent + unclassified;
  if (!Number.isSafeInteger(activity)) {
    fail(path, "counts whose sum is a safe integer");
  }
  return activity;
}

/**
 * Returns the 13 two-hour tick timestamps spanning the complete 24-hour window.
 */
export function createTimeAxisTicks(startMs) {
  if (!Number.isSafeInteger(startMs)) {
    fail("startMs", "a safe integer timestamp");
  }
  return Array.from(
    { length: BUCKET_COUNT / AXIS_INTERVAL_BUCKETS + 1 },
    (_, index) => startMs + index * AXIS_INTERVAL_BUCKETS * BUCKET_MS,
  );
}

/**
 * Finds the shared activity scale for already-adapted people without changing it.
 */
export function getGlobalPeak(people) {
  if (!Array.isArray(people)) {
    fail("people", "an array");
  }
  let peak = 0;
  for (const person of people) {
    if (!person || !Array.isArray(person.buckets)) {
      fail("people", "an array of adapted people");
    }
    for (const bucket of person.buckets) {
      if (!bucket || !Number.isSafeInteger(bucket.activity) || bucket.activity < 0) {
        fail("people", "an array of adapted people");
      }
      peak = Math.max(peak, bucket.activity);
    }
  }
  return peak;
}

/**
 * Classifies recent observed session evidence relative to the exact API read.
 */
export function getPersonActivityStatus(person, readMs) {
  if (!person || !(person.lastActivityMs === null ||
      Number.isSafeInteger(person.lastActivityMs))) {
    fail("person", "an adapted person with a nullable activity timestamp");
  }
  if (!Number.isSafeInteger(readMs)) {
    fail("readMs", "a safe integer timestamp");
  }
  if (person.lastActivityMs === null) return "inactive";
  const elapsed = readMs - person.lastActivityMs;
  if (elapsed < 0) fail("person.lastActivityMs", "at or before readMs");
  if (elapsed <= BUCKET_MS) return "active";
  if (elapsed <= 3 * BUCKET_MS) return "recent";
  return "inactive";
}

/**
 * Validates and expands the compact /api/flame response into chart-ready points.
 * The operation is one-to-one: it never sorts, rebuckets, or derives daily totals.
 */
export function adaptFlamePayload(value) {
  const payload = requireObject(value, "payload");
  const startMs = requireDate(payload.start, "start");
  const readMs = requireDate(payload.read, "read");
  const snapshot = requireNonemptyString(payload.snapshot, "snapshot");
  const latestMs = requireDate(payload.latest, "latest", true);
  const rawCoverage = requireObject(payload.coverage, "coverage");
  const coverage = {
    evidence: requireNonemptyString(rawCoverage.evidence, "coverage.evidence"),
    state: requireNonemptyString(rawCoverage.state, "coverage.state"),
    reason: rawCoverage.reason === null || rawCoverage.reason === undefined
      ? null
      : requireNonemptyString(rawCoverage.reason, "coverage.reason"),
  };
  if (coverage.evidence !== "observed_events") {
    fail("coverage.evidence", '"observed_events"');
  }
  if (!["complete", "partial"].includes(coverage.state)) {
    fail("coverage.state", '"complete" or "partial"');
  }

  if (!Array.isArray(payload.people) || payload.people.length === 0) {
    fail("people", "a nonempty array");
  }

  const ids = new Set();
  const people = payload.people.map((rawPerson, personIndex) => {
    const path = `people[${personIndex}]`;
    const person = requireObject(rawPerson, path);
    const id = requireNonemptyString(person.id, `${path}.id`);
    if (ids.has(id)) {
      throw new FlameDataError(`${path}.id must be unique`);
    }
    ids.add(id);

    const name = requireNonemptyString(person.name, `${path}.name`);
    const activeSeconds = requireCount(person.activeSeconds, `${path}.activeSeconds`);
    if (activeSeconds > MAX_ACTIVE_SECONDS) {
      fail(`${path}.activeSeconds`, `no greater than ${MAX_ACTIVE_SECONDS}`);
    }
    const lastActivityMs = requireDate(
      person.lastActivity,
      `${path}.lastActivity`,
      true,
    );
    if (lastActivityMs !== null && (lastActivityMs < startMs || lastActivityMs > readMs)) {
      fail(`${path}.lastActivity`, "inside the dashboard read window");
    }
    const total = requireFixedCounts(person.total, TOTAL_COUNT, `${path}.total`);
    if (!Array.isArray(person.buckets) || person.buckets.length !== BUCKET_COUNT) {
      fail(`${path}.buckets`, `an array of exactly ${BUCKET_COUNT} buckets`);
    }

    const buckets = person.buckets.map((rawBucket, bucketIndex) => {
      const bucketPath = `${path}.buckets[${bucketIndex}]`;
      const [agent, subagent, unclassified, prompts] = requireFixedCounts(
        rawBucket,
        BUCKET_VALUE_COUNT,
        bucketPath,
      );
      const roleCounts = [agent, subagent, unclassified];
      roleCounts.forEach((count, roleIndex) => {
        if (count > total[roleIndex]) {
          throw new FlameDataError(
            `${bucketPath}[${roleIndex}] cannot exceed ${path}.total[${roleIndex}]`,
          );
        }
      });

      const bucketStartMs = startMs + bucketIndex * BUCKET_MS;
      return {
        index: bucketIndex,
        startMs: bucketStartMs,
        endMs: bucketStartMs + BUCKET_MS,
        agent,
        subagent,
        unclassified,
        prompts,
        activity: safeActivity(agent, subagent, unclassified, bucketPath),
      };
    });
    const expectedActiveSeconds = buckets.reduce(
      (seconds, bucket) => seconds + (bucket.activity > 0 ? BUCKET_MS / 1000 : 0),
      0,
    );
    if (activeSeconds !== expectedActiveSeconds) {
      fail(
        `${path}.activeSeconds`,
        `equal to ${expectedActiveSeconds} seconds from occupied activity buckets`,
      );
    }

    return { id, name, activeSeconds, lastActivityMs, total, buckets };
  });

  return {
    start: payload.start,
    read: payload.read,
    snapshot,
    latest: payload.latest,
    startMs,
    readMs,
    latestMs,
    coverage,
    bucketCount: BUCKET_COUNT,
    windowMinutes: 24 * 60,
    axisTicks: createTimeAxisTicks(startMs),
    globalPeak: getGlobalPeak(people),
    people,
  };
}

export function adaptPromptEvidence(value, { personId, startMs, snapshot }) {
  const payload = requireObject(value, "prompt evidence");
  if (requireNonemptyString(payload.personId, "prompt evidence.personId") !== personId) {
    fail("prompt evidence.personId", "the selected person id");
  }
  if (requireDate(payload.start, "prompt evidence.start") !== startMs) {
    fail("prompt evidence.start", "the selected bucket start");
  }
  if (requireNonemptyString(payload.snapshot, "prompt evidence.snapshot") !== snapshot) {
    fail("prompt evidence.snapshot", "the timeline snapshot");
  }
  if (!Array.isArray(payload.prompts)) {
    fail("prompt evidence.prompts", "an array");
  }
  const ids = new Set();
  return payload.prompts.map((value, index) => {
    const path = `prompt evidence.prompts[${index}]`;
    const prompt = requireObject(value, path);
    const id = requireNonemptyString(prompt.id, `${path}.id`);
    if (ids.has(id)) fail(`${path}.id`, "unique");
    ids.add(id);
    const atMs = requireDate(prompt.at, `${path}.at`);
    if (atMs < startMs || atMs >= startMs + BUCKET_MS) {
      fail(`${path}.at`, "inside the selected bucket");
    }
    if (typeof prompt.content !== "string") fail(`${path}.content`, "a string");
    if (typeof prompt.truncated !== "boolean") fail(`${path}.truncated`, "a boolean");
    return { id, atMs, content: prompt.content, truncated: prompt.truncated };
  });
}
