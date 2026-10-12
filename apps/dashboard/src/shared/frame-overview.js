// Compact per-person day overview for flame-source previews.
// Pure module: no I/O, no logging, and inputs are never mutated.

const VERSION = 1;
const BUCKET_COUNT = 144;
const BUCKET_MS = 10 * 60 * 1000; // 144 x 10 min = one semantic day
const MAX_EPOCH_MS = 8.64e15; // ECMAScript Date range
const MAX_PREVIEW_CODE_POINTS = 160;
const MAX_OVERVIEW_BYTES = 128 * 1024;
const MAX_WORK_LIMIT = 10_000;
const RECOVERED_SUMMARY = 'Recovered cloud turn activity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL_ID = /^[1-9][0-9]{0,18}$/;
const EXACT_COUNT = /^(0|[1-9][0-9]{0,15})$/;
const EVIDENCE_SOURCES = new Set(['completed_turn_interval', 'observed_ongoing_turn_interval']);
const ROLE_SLOT = new Map([['agent', 0], ['subagent', 1], ['unclassified', 2]]);

// Authorization metadata is keyed by the frozen overview this module built, so it
// is never serialized and a lookalike object cannot claim it.
const authorizationByOverview = new WeakMap();

class InvalidOverviewInput extends Error {}

function check(condition) {
  if (!condition) throw new InvalidOverviewInput();
}

function isUuid(value) {
  // Lowercase canonical form only, so one session never splits into two dictionary entries.
  return typeof value === 'string' && UUID.test(value);
}

function isDecimalId(value) {
  // Event ids are bigint columns; pg returns them as strings and they must stay exact.
  return typeof value === 'string' && DECIMAL_ID.test(value);
}

function toEpochMs(value) {
  let ms = NaN;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'number') ms = value;
  else if (typeof value === 'string' && value.length <= 64) ms = Date.parse(value);
  check(Number.isSafeInteger(ms) && ms >= 0 && ms <= MAX_EPOCH_MS);
  return ms;
}

function toCount(value, min) {
  // pg returns count/bigint as strings; accept them only when they convert exactly.
  const n = typeof value === 'string' && EXACT_COUNT.test(value) ? Number(value) : value;
  check(Number.isSafeInteger(n) && n >= min);
  return n;
}

// Single-line preview capped by code points so surrogate pairs never split.
// Iterates lazily because summaries carry full source text.
export function previewSummary(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  const points = [];
  for (const point of normalized) {
    points.push(point);
    if (points.length > MAX_PREVIEW_CODE_POINTS) break;
  }
  if (points.length === 0) return null;
  if (points.length <= MAX_PREVIEW_CODE_POINTS) return points.join('');
  return `${points.slice(0, MAX_PREVIEW_CODE_POINTS - 1).join('').trimEnd()}…`;
}

function indexSummaries(summaries) {
  check(Array.isArray(summaries));
  const byWorkId = new Map();
  for (const s of summaries) {
    check(s !== null && typeof s === 'object');
    check(isUuid(s.session_id) && ROLE_SLOT.has(s.semantic_role));
    const workId = `${s.session_id}:${s.semantic_role}`;
    // The caller picks exactly one summary per session+role; duplicates mean a bad join.
    check(!byWorkId.has(workId));
    if (s.summary === null) {
      check(s.summary_event_id === null || isDecimalId(s.summary_event_id));
      byWorkId.set(workId, null);
      continue;
    }
    // Shown text must be traceable to the exact event the caller re-authorizes.
    check(typeof s.summary === 'string' && isDecimalId(s.summary_event_id));
    const preview = previewSummary(s.summary);
    byWorkId.set(workId, preview === null ? null : { preview, eventId: s.summary_event_id });
  }
  return byWorkId;
}

// [agent, subagent, other, prompts]; prompts are validated but not reconciled to work rows.
function readCounts(tuple) {
  check(Array.isArray(tuple) && tuple.length === 4);
  return tuple.map((n) => toCount(n, 0));
}

function readWork(work, startMs) {
  check(work !== null && typeof work === 'object');
  const recovered = typeof work.id === 'string' && work.id.startsWith('recovery:');
  const sessionId = recovered ? work.sessionId : work.session_id;
  const role = recovered ? work.role : work.semantic_role;
  check(isUuid(sessionId) && ROLE_SLOT.has(role));

  const firstMs = toEpochMs(recovered ? work.firstAt : work.first_at);
  const lastMs = toEpochMs(recovered ? work.lastAt : work.last_at);
  // Activity must sit inside its own [start, start + 10 min) bucket.
  check(startMs <= firstMs && firstMs <= lastMs && lastMs < startMs + BUCKET_MS);

  if (recovered) {
    check(work.id === `recovery:${sessionId}:${role}`);
    // Recovered manifests carry no exact counts; a number here would be invented.
    check(work.eventCount === null);
    // Only the fixed label is allowed: recovered text is not covered by summary authorization.
    check(work.summary === null || work.summary === RECOVERED_SUMMARY);
    check(typeof work.evidenceSource === 'string' && EVIDENCE_SOURCES.has(work.evidenceSource));
    return {
      id: work.id, sessionId, role, firstMs, lastMs,
      count: null, automated: 0, evidenceSource: work.evidenceSource, summary: work.summary,
    };
  }

  check(typeof work.is_automated_run === 'boolean' && isDecimalId(work.frame_revision_id));
  return {
    id: `${sessionId}:${role}`, sessionId, role, firstMs, lastMs,
    count: toCount(work.event_count, 1), automated: work.is_automated_run ? 1 : 0,
    evidenceSource: null, summary: null, frameRevisionId: work.frame_revision_id,
  };
}

function compareWork(a, b) {
  return a.firstMs - b.firstMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function build(rows, summaries, counts, workLimit, personId, automatedRuns, recoveryHashes) {
  check(isUuid(personId));
  check(Array.isArray(recoveryHashes) && recoveryHashes.every(hash => /^[0-9a-f]{64}$/.test(hash)));
  check(Array.isArray(rows) && rows.length === BUCKET_COUNT);
  check(Array.isArray(counts) && counts.length === BUCKET_COUNT);
  check(Number.isSafeInteger(workLimit) && workLimit >= 1 && workLimit <= MAX_WORK_LIMIT);
  const summaryByWorkId = indexSummaries(summaries);

  const sessions = [];
  const previews = [];
  const buckets = {};
  const omitted = [];
  const sessionRefs = new Map();
  const previewRefs = new Map();
  const nativeSessionIds = new Set();
  const frameBySession = new Map();
  const summaryEventIds = new Set();

  const previewIndex = (text) => {
    let index = previewRefs.get(text);
    if (index === undefined) {
      index = previews.length;
      previews.push(text);
      previewRefs.set(text, index);
    }
    return index;
  };

  const sessionRef = (w) => {
    const known = sessionRefs.get(w.id);
    if (known) {
      // One dictionary entry per work id; conflicting provenance means a bad merge.
      check(known.recovered === (w.evidenceSource !== null) && known.summary === w.summary);
      return known.ref;
    }
    let summary = null;
    if (w.evidenceSource === null) {
      nativeSessionIds.add(w.sessionId);
      if (!frameBySession.has(w.sessionId)) frameBySession.set(w.sessionId, w.frameRevisionId);
      summary = summaryByWorkId.get(w.id) ?? null;
      if (summary) summaryEventIds.add(summary.eventId);
    } else if (w.summary !== null) {
      summary = { preview: w.summary };
    }
    const ref = sessions.length;
    sessions.push([w.sessionId, w.role, summary ? previewIndex(summary.preview) : null, w.evidenceSource !== null]);
    sessionRefs.set(w.id, { ref, recovered: w.evidenceSource !== null, summary: w.summary });
    return ref;
  };

  let previousStart = 0;
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const row = rows[i];
    check(row !== null && typeof row === 'object' && row.person_id === personId);
    const startMs = toEpochMs(row.bucket_start);
    // Buckets must be the contiguous ascending 10-minute grid the timeline renders.
    check(i === 0 || startMs === previousStart + BUCKET_MS);
    previousStart = startMs;

    const tally = readCounts(counts[i]);
    const rawWork = row.work_rows ?? []; // json_agg yields NULL for empty buckets
    check(Array.isArray(rawWork));
    // Validate every row, even in buckets we omit: bad data anywhere rejects the preview.
    const work = rawWork.map((w) => readWork(w, startMs));

    // Counts are the merged (native + recovered) per-role work-row tallies.
    const perRole = [0, 0, 0];
    const ids = new Set();
    for (const w of work) {
      perRole[ROLE_SLOT.get(w.role)]++;
      ids.add(w.id);
    }
    const automatedSessions = new Set(work.filter(w => w.automated).map(w => w.sessionId));
    const consistent = ids.size === work.length && perRole.every((n, slot) => n === tally[slot]) &&
      automatedSessions.size === (automatedRuns[i] ?? 0);
    // Disagreement or overflow hides this bucket's detail, never the whole timeline.
    if (!consistent || work.length > workLimit) {
      omitted.push(i);
      continue;
    }
    if (work.length === 0) continue; // empty buckets are implied by absence

    work.sort(compareWork);
    buckets[i] = work.map((w) => [sessionRef(w), w.firstMs, w.lastMs, w.count, w.automated, w.evidenceSource]);
  }

  const overview = { version: VERSION, sessions, summaries: previews, buckets, omitted };
  // Per-person payload budget: an oversized day drops the preview rather than shipping it.
  if (new TextEncoder().encode(JSON.stringify(overview)).length > MAX_OVERVIEW_BYTES) return null;

  // Frozen so the authorization recorded below always describes what is served.
  deepFreeze(overview);
  check(!sessions.some(entry => entry[3]) || recoveryHashes.length > 0);
  authorizationByOverview.set(overview, Object.freeze({
    personId, frameRevisionIds: Object.freeze([...frameBySession.values()]), recoveryHashes: Object.freeze([...new Set(recoveryHashes)]),
    // Recovered sessions are excluded: they have no native session rows, and the
    // caller gates them by person while the recovered manifest already holds that scope.
    sessionIds: Object.freeze([...nativeSessionIds]),
    summaryEventIds: Object.freeze([...summaryEventIds]),
  }));
  return overview;
}

export function buildFrameOverview({ rows, summaries, counts, workLimit = 200, personId, automatedRuns = [], recoveryHashes = [] } = {}) {
  try {
    return build(rows, summaries, counts, workLimit, personId, automatedRuns, recoveryHashes);
  } catch {
    return null; // reject only the preview; the caller still renders the timeline
  }
}

export function getOverviewAuthorization(overview) {
  // WeakMap ownership is the only trust signal; unknown objects and primitives get null.
  const auth = authorizationByOverview.get(overview);
  if (!auth) return null;
  return { personId: auth.personId, frameRevisionIds: [...auth.frameRevisionIds], recoveryHashes: [...auth.recoveryHashes], sessionIds: [...auth.sessionIds], summaryEventIds: [...auth.summaryEventIds] };
}

// Accept arrays or Sets from the caller's fresh query; non-string ids never match.
function toIdSet(ids) {
  if (!(ids instanceof Set) && !Array.isArray(ids)) return null;
  const set = new Set();
  for (const id of ids) if (typeof id === 'string') set.add(id);
  return set;
}

// All-or-nothing: masking individual rows would leave bucket counts inconsistent.
export function filterAuthorizedOverview(overview, grant) {
  const auth = authorizationByOverview.get(overview);
  if (!auth) return null;
  if (auth.personId !== grant?.personId) return null;
  const allowedRecovery = toIdSet(grant?.recoveryHashes);
  if (!allowedRecovery || !auth.recoveryHashes.every(hash => allowedRecovery.has(hash))) return null;
  const allowedSessions = toIdSet(grant?.sessionIds);
  const allowedSummaries = toIdSet(grant?.summaryEventIds);
  if (!allowedSessions || !allowedSummaries) return null;
  const authorized =
    auth.sessionIds.every((id) => allowedSessions.has(id)) &&
    auth.summaryEventIds.every((id) => allowedSummaries.has(id));
  return authorized ? overview : null;
}

// Untrusted wire data is decoded independently of the server's WeakMap ownership.
// Invalid optional previews fall back to the established interval request path.
export function decodeFrameOverview(overview, { startMs, counts, automatedRuns = [] }) {
  try {
    check(overview?.version === VERSION && Array.isArray(overview.sessions) && Array.isArray(overview.summaries));
    check(overview.buckets && typeof overview.buckets === 'object' && !Array.isArray(overview.buckets));
    check(Array.isArray(overview.omitted) && counts.length === BUCKET_COUNT);
    check(new TextEncoder().encode(JSON.stringify(overview)).length <= MAX_OVERVIEW_BYTES);
    const omitted = new Set(overview.omitted);
    check(omitted.size === overview.omitted.length);
    for (const index of omitted) check(Number.isInteger(index) && index >= 0 && index < BUCKET_COUNT);
    for (const key of Object.keys(overview.buckets)) {
      check(/^(0|[1-9]\d*)$/.test(key) && Number(key) < BUCKET_COUNT && !omitted.has(Number(key)));
    }
    for (const text of overview.summaries) check(typeof text === 'string' && [...text].length <= MAX_PREVIEW_CODE_POINTS);
    const dictionaryIds = new Set();
    for (const entry of overview.sessions) {
      check(Array.isArray(entry) && entry.length === 4);
      const [id, role, summary, recovered] = entry;
      check(isUuid(id) && ROLE_SLOT.has(role) && typeof recovered === 'boolean');
      check(summary === null || Number.isInteger(summary) && summary >= 0 && summary < overview.summaries.length);
      const workId = `${recovered ? 'recovery:' : ''}${id}:${role}`;
      check(!dictionaryIds.has(workId));
      dictionaryIds.add(workId);
    }
    return Array.from({ length: BUCKET_COUNT }, (_, index) => {
      if (omitted.has(index)) return null;
      const start = startMs + index * BUCKET_MS;
      const tuples = overview.buckets[index] ?? [];
      check(Array.isArray(tuples) && tuples.length <= 200);
      const ids = new Set(), roleCounts = [0, 0, 0];
      let previous = null;
      const automated = new Set();
      const work = tuples.map(tuple => {
        check(Array.isArray(tuple) && tuple.length === 6);
        const [ref, firstAtMs, lastAtMs, eventCount, automation, evidenceSource] = tuple;
        check(Number.isInteger(ref) && ref >= 0 && ref < overview.sessions.length);
        const [sessionId, role, summaryIndex, recovered] = overview.sessions[ref];
        check(Number.isSafeInteger(firstAtMs) && Number.isSafeInteger(lastAtMs));
        check(firstAtMs >= start && firstAtMs <= lastAtMs && lastAtMs < start + BUCKET_MS);
        check(automation === 0 || automation === 1);
        check(recovered ? eventCount === null && automation === 0 && EVIDENCE_SOURCES.has(evidenceSource)
          : evidenceSource === null && Number.isSafeInteger(eventCount) && eventCount > 0);
        const id = `${recovered ? 'recovery:' : ''}${sessionId}:${role}`;
        check(!ids.has(id)); ids.add(id); roleCounts[ROLE_SLOT.get(role)]++; if (automation) automated.add(sessionId);
        const row = { id, sessionId, role, firstAtMs, lastAtMs, eventCount,
          summary: summaryIndex === null ? null : overview.summaries[summaryIndex],
          evidenceSource, pullRequest: null, ...(automation ? { automatedRun: true } : {}) };
        check(previous === null || previous.firstAtMs < firstAtMs ||
          previous.firstAtMs === firstAtMs && previous.id <= id);
        previous = row;
        return row;
      });
      const tally = readCounts(counts[index]);
      check(roleCounts.every((n, slot) => n === tally[slot]));
      if (automated.size !== (automatedRuns[index] ?? 0)) return null;
      return work;
    });
  } catch {
    return null;
  }
}

export function overviewMatchesEvidence(preview, evidence) {
  const actualById = new Map(evidence.map(row => [row.id, row]));
  return preview.length === evidence.length && actualById.size === evidence.length && preview.every(row => {
    const actual = actualById.get(row.id);
    return actual && ['id', 'sessionId', 'role', 'firstAtMs', 'lastAtMs', 'eventCount', 'evidenceSource']
      .every(key => row[key] === actual[key]) &&
      Boolean(row.automatedRun) === Boolean(actual.automatedRun) &&
      row.summary === (actual.summary === null ? null : previewSummary(actual.summary));
  });
}

// Bound additional in-memory and wire data independently of workspace size.
export function limitFrameOverviewPayload(payload, maxBytes = 1024 * 1024) {
  let remaining = maxBytes, changed = false;
  const people = payload.people.map(person => {
    if (!person.overview) return person;
    const bytes = new TextEncoder().encode(JSON.stringify(person.overview)).length;
    if (bytes <= remaining) { remaining -= bytes; return person; }
    changed = true;
    const { overview, ...plain } = person;
    return plain;
  });
  return changed ? { ...payload, people } : payload;
}
