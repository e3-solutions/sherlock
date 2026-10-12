import { createHash } from "node:crypto";

import {
  FlameSourceError,
  NORMALIZER_VERSION,
  dashboardWorkSummary,
} from "./flame-source.js";
import {
  activeNormalizerPredicate,
  canonicalWinnerPredicate,
  queryWindow,
  runQuery,
} from "./mcp-query-source.js";

export const SEARCH_SCHEMA_VERSION = "sherlock.search.v1";
export const SEARCH_CANDIDATE_BUDGET = 500;
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 20;
export const SEARCH_DEFAULT_PER_SESSION_LIMIT = 2;
export const SEARCH_MAX_PER_SESSION_LIMIT = 5;
export const SEARCH_MAX_QUERY_TOKENS = 8;
export const PERSON_DEFAULT_LIMIT = 10;
export const PERSON_MAX_LIMIT = 10;
export const EVIDENCE_DEFAULT_LIMIT = 30;
export const EVIDENCE_MAX_LIMIT = 50;
export const EVIDENCE_SCAN_BUDGET = 300;
export const EVIDENCE_MAX_CHILD_SESSIONS = 20;
export const MAX_EXCERPT_SOURCE_BYTES = 1024;
export const MAX_EXCERPT_CHARS = 1100;
export const CONTENT_TRUST = "untrusted_session_content";

const ROSTER_SQL_LIMIT = 1000;
const STATEMENT_TIMEOUT_MS = 10_000;
const EVIDENCE_CURSOR_VERSION = "e1";
const MAX_CURSOR_LENGTH = 512;
const MAX_BIGINT = 9223372036854775807n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const MICROS_PATTERN = /^-?[0-9]{1,17}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const CONTROL_PATTERN = /\p{Cc}/u;
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const HELPER_ERROR_PATTERN = /^excerpt_search_([a-z0-9_]{1,48})(?![a-z0-9_])/;
const ROLES = new Set(["user", "assistant", "system", "developer"]);
const ORIGINS = new Set([
  "human", "parent_agent", "worker", "system", "resumed_context", "unknown",
]);
const REDACTED = "[REDACTED]";
// Best-effort shapes only: a pattern miss is not proof that an excerpt is clean.
const CREDENTIAL_PATTERNS = Object.freeze([
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  [/\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, `$1${REDACTED}@`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, `$1${REDACTED}`],
]);

// Product-view redaction. Raw telemetry and stored excerpts are never changed.
export function redactCredentials(value) {
  let text = String(value);
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return { text, redacted: text !== String(value) };
}

export function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function truncateChars(value, maxChars) {
  if (value.length <= maxChars) return value;
  const cut = value.slice(0, maxChars);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function boundedText(value) {
  return truncateChars(truncateUtf8(String(value), MAX_EXCERPT_SOURCE_BYTES), MAX_EXCERPT_CHARS);
}

// Truncation compares the stored excerpt's original UTF-8 size with the full
// content size; the hash stays the source content hash, not a redacted hash.
export function excerptView(excerpt, fullContentBytes) {
  if (excerpt === null || excerpt === undefined) {
    return {
      contentExcerpt: null,
      excerptTruncated: fullContentBytes !== null && fullContentBytes > 0,
      excerptRedacted: false,
      fullContentBytes,
    };
  }
  const original = String(excerpt);
  const originalBytes = Buffer.byteLength(original, "utf8");
  const { text, redacted } = redactCredentials(truncateUtf8(original, MAX_EXCERPT_SOURCE_BYTES));
  const contentExcerpt = truncateChars(text, MAX_EXCERPT_CHARS);
  return {
    contentExcerpt,
    excerptTruncated: originalBytes > MAX_EXCERPT_SOURCE_BYTES ||
      contentExcerpt.length < text.length ||
      (fullContentBytes !== null && fullContentBytes > originalBytes),
    excerptRedacted: redacted,
    fullContentBytes,
  };
}

function invalid() {
  return new FlameSourceError("flame_mcp_query_request_invalid");
}

function cursorInvalid() {
  return new FlameSourceError("flame_mcp_query_cursor_invalid");
}

function resultInvalid() {
  return new FlameSourceError("flame_database_result_invalid");
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid();
  return value;
}

function optionalUuid(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw invalid();
  return value.toLowerCase();
}

export function parseEventId(value) {
  if (typeof value !== "string" || !EVENT_ID_PATTERN.test(value) ||
      BigInt(value) > MAX_BIGINT) throw invalid();
  return value;
}

function compareIds(left, right) {
  const difference = BigInt(left) - BigInt(right);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

function nullableCount(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw resultInvalid();
  return number;
}

function nullableHash(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value.toLowerCase() : null;
}

export function microsToIso(micros) {
  if (typeof micros !== "string" || !MICROS_PATTERN.test(micros)) throw resultInvalid();
  let milliseconds = BigInt(micros) / 1000n;
  let remainder = BigInt(micros) % 1000n;
  if (remainder < 0n) {
    milliseconds -= 1n;
    remainder += 1000n;
  }
  const date = new Date(Number(milliseconds));
  if (!Number.isFinite(date.getTime())) throw resultInvalid();
  return `${date.toISOString().slice(0, -1)}${String(remainder).padStart(3, "0")}Z`;
}

function providerFromSource(value) {
  if (value === "claude_code") return "claude";
  if (value === "codex") return "codex";
  return "unknown";
}

function providerFromVersion(value) {
  if (typeof value !== "string") return "unknown";
  if (value.startsWith("sherlock.claude-code-transcript.")) return "claude";
  if (value.startsWith("sherlock.codex-rollout.")) return "codex";
  return "unknown";
}

function messageRole(row) {
  if (ROLES.has(row.message_role)) return row.message_role;
  if (row.event_kind === "agent_message" &&
      (row.message_role === null || row.message_role === undefined)) return "assistant";
  return "unknown";
}

// Injected runtime context in user turns is not a human instruction.
function isRuntimeContext(row) {
  return messageRole(row) === "user" && row.content_excerpt !== null &&
    row.content_excerpt !== undefined && dashboardWorkSummary(row.content_excerpt) === null;
}

function excerptFromRow(row) {
  return {
    eventId: String(row.event_id),
    sessionId: String(row.session_id),
    personId: String(row.person_id),
    displayName: boundedText(row.display_name),
    provider: providerFromSource(row.source_provider),
    role: messageRole(row),
    origin: ORIGINS.has(row.message_origin) ? row.message_origin : "unknown",
    occurredAt: row.occurred_at_us === null || row.occurred_at_us === undefined
      ? null
      : microsToIso(String(row.occurred_at_us)),
    contentTrust: CONTENT_TRUST,
    ...excerptView(row.content_excerpt, nullableCount(row.content_byte_size)),
    contentSha256: nullableHash(row.content_sha256),
    source: {
      sourceRecordId: String(row.source_record_id),
      recordSha256: nullableHash(row.record_sha256),
      normalizerVersion: boundedText(row.normalizer_version),
    },
  };
}

function roster(people, domainParam) {
  return `${people}.github_id is distinct from 'sherlock-smoke'
     and split_part(${people}.email, '@', 2) = ${domainParam}
     and split_part(${people}.email, '@', 3) = ''`;
}

const MESSAGE_KINDS = "('message', 'agent_message')";

const EXCERPT_COLUMNS = `
  e.id::text event_id, e.session_id::text session_id, s.person_id::text person_id,
  coalesce(nullif(btrim(pe.display_name), ''), 'Unknown') display_name,
  ib.source_provider, e.event_kind, e.message_role, e.message_origin,
  (extract(epoch from e.occurred_at) * 1000000)::bigint::text occurred_at_us,
  e.content_excerpt, e.content_byte_size, e.content_sha256,
  nr.id::text source_record_id, nr.record_sha256, e.normalizer_version`;

const EXCERPT_JOINS = `
  join telemetry.sessions s on s.workspace_id = e.workspace_id and s.id = e.session_id
  join telemetry.people pe on pe.workspace_id = s.workspace_id and pe.id = s.person_id
  join telemetry.native_records nr
    on nr.workspace_id = e.workspace_id and nr.id = e.source_record_id
  join telemetry.ingest_batches ib
    on ib.workspace_id = nr.workspace_id and ib.id = nr.batch_id
  left join analytics.normalizer_cutovers c
    on c.workspace_id = e.workspace_id and c.source_provider = ib.source_provider
   and c.to_normalizer_version = '${NORMALIZER_VERSION}'`;

const CANONICAL = `${activeNormalizerPredicate("e", "s", "ib", "c")}
   and ${canonicalWinnerPredicate("e", "s")}`;

export const PERSON_ROSTER_SQL = `
select pe.id::text person_id,
       coalesce(nullif(btrim(pe.display_name), ''), 'Unknown') display_name,
       split_part(pe.email, '@', 1) email_local_part
  from telemetry.people pe
 where pe.workspace_id = $1 and ${roster("pe", "$2")}
 order by pe.id
 limit $3
`;

// The helper only nominates IDs. Every returned fact is re-read below under
// the caller's RLS with the canonical rules unchanged.
export const SEARCH_CANDIDATES_SQL = `
select candidate.event_id::text event_id, candidate.score
  from analytics.search_excerpt_candidates(
    $1::uuid, $2::text, $3::timestamptz, $4::timestamptz, $5::timestamptz,
    $6::text, $7::uuid, $8::uuid, $9::integer
  ) candidate
 limit ${SEARCH_CANDIDATE_BUDGET + 1}
`;

export const SEARCH_MATCHES_SQL = `
select ${EXCERPT_COLUMNS}
  from telemetry.events e ${EXCERPT_JOINS}
 where e.workspace_id = $1 and e.id = any($2::bigint[])
   and e.event_kind in ${MESSAGE_KINDS} and not e.is_replay
   and e.content_excerpt is not null
   and e.occurred_at >= $3::timestamptz and e.occurred_at < $4::timestamptz
   and e.server_received_at <= $5::timestamptz
   and ${roster("pe", "$6")}
   and ($7::uuid is null or s.person_id = $7::uuid)
   and ($8::uuid is null or e.session_id = $8::uuid)
   and s.actor_role not in ('guardian', 'automation')
   and ${CANONICAL}
`;

export const EVIDENCE_SESSION_SQL = `
select s.id::text session_id, s.person_id::text person_id,
       coalesce(nullif(btrim(pe.display_name), ''), 'Unknown') display_name,
       s.started_at, s.ended_at, parent.id::text parent_session_id,
       (s.parent_session_id is not null and parent.id is null) parent_omitted,
       first_message.normalizer_version,
       array(
         select child.id::text
           from telemetry.sessions child
           join telemetry.people child_person
             on child_person.workspace_id = child.workspace_id
            and child_person.id = child.person_id
          where child.workspace_id = s.workspace_id and child.parent_session_id = s.id
            and child.actor_role not in ('guardian', 'automation')
            and ${roster("child_person", "$3")}
          order by child.started_at, child.id
          limit ${EVIDENCE_MAX_CHILD_SESSIONS + 1}
       ) child_session_ids,
       (select count(*) from (
          select 1 from telemetry.events untimed
           where untimed.workspace_id = s.workspace_id and untimed.session_id = s.id
             and untimed.occurred_at is null and not untimed.is_replay
             and untimed.event_kind in ${MESSAGE_KINDS}
           limit 101
        ) bounded_untimed)::int untimed_messages
  from telemetry.sessions s
  join telemetry.people pe on pe.workspace_id = s.workspace_id and pe.id = s.person_id
  left join lateral (
    select parent.id
      from telemetry.sessions parent
      join telemetry.people parent_person
        on parent_person.workspace_id = parent.workspace_id
       and parent_person.id = parent.person_id
     where parent.workspace_id = s.workspace_id and parent.id = s.parent_session_id
       and parent.actor_role not in ('guardian', 'automation')
       and ${roster("parent_person", "$3")}
  ) parent on true
  left join lateral (
    select e.normalizer_version
      from telemetry.events e
     where e.workspace_id = s.workspace_id and e.session_id = s.id
       and e.event_kind in ${MESSAGE_KINDS} and not e.is_replay
     order by e.occurred_at, e.id
     limit 1
  ) first_message on true
 where s.workspace_id = $1 and s.id = $2 and ${roster("pe", "$3")}
   and s.actor_role not in ('guardian', 'automation')
`;

// The anchor is the exact stored source row, never a substitute; whether it is
// canonical at read time is reported rather than required.
export const EVIDENCE_ANCHOR_SQL = `
select ${EXCERPT_COLUMNS}, (${CANONICAL}) canonical_at_read
  from telemetry.events e ${EXCERPT_JOINS}
 where e.workspace_id = $1 and e.session_id = $2 and e.id = $3::bigint
   and e.event_kind in ${MESSAGE_KINDS} and not e.is_replay
   and ${roster("pe", "$4")}
`;

// Walk events_session_occurred_idx for at most the scan budget, then apply the
// canonical rules to that bounded set only.
// The key time is bound as text: the driver would round a timestamptz
// parameter to JavaScript milliseconds and cannot carry -infinity.
function evidenceContextSql(direction) {
  const [operator, order] = direction === "after" ? [">", "asc"] : ["<", "desc"];
  return `
with scanned as materialized (
  select e.id, e.occurred_at
    from telemetry.events e
   where e.workspace_id = $1 and e.session_id = $2
     and e.occurred_at is not null
     and (e.occurred_at, e.id) ${operator} ($3::text::timestamptz, $4::bigint)
     and e.event_kind in ${MESSAGE_KINDS} and not e.is_replay
     and e.server_received_at <= $5::timestamptz
   order by e.occurred_at ${order}, e.id ${order}
   limit ${EVIDENCE_SCAN_BUDGET}
)
select scanned.id::text scanned_id,
       (extract(epoch from scanned.occurred_at) * 1000000)::bigint::text scanned_at_us,
       ${EXCERPT_COLUMNS},
       case when e.id is null then false
            else (${roster("pe", "$6")} and ${CANONICAL}) end canonical
  from scanned
  left join (telemetry.events e ${EXCERPT_JOINS})
    on e.workspace_id = $1 and e.id = scanned.id
 order by scanned.occurred_at ${order}, scanned.id ${order}
`;
}

export const EVIDENCE_AFTER_SQL = evidenceContextSql("after");
export const EVIDENCE_BEFORE_SQL = evidenceContextSql("before");

function helperError(error) {
  const match = HELPER_ERROR_PATTERN.exec(String(error?.message ?? ""));
  return match ? new FlameSourceError(`flame_mcp_query_search_${match[1]}`) : error;
}

function parseQuery(value) {
  if (typeof value !== "string") throw invalid();
  const query = value.trim();
  const length = [...query].length;
  const words = query.match(WORD_PATTERN) ?? [];
  if (length < 2 || length > 256 || CONTROL_PATTERN.test(query) ||
      words.length === 0 || words.length > SEARCH_MAX_QUERY_TOKENS) throw invalid();
  return query;
}

function parseName(value) {
  if (typeof value !== "string") throw invalid();
  const name = value.trim();
  const length = [...name].length;
  if (length < 1 || length > 128 || CONTROL_PATTERN.test(name)) throw invalid();
  return foldCase(name);
}

function foldCase(value) {
  return String(value).normalize("NFKC").toLowerCase();
}

const MATCH_RANK = Object.freeze({ exact: 0, prefix: 1, substring: 2 });

function matchKind(candidate, needle) {
  if (candidate === needle) return "exact";
  if (candidate.startsWith(needle)) return "prefix";
  if (candidate.includes(needle)) return "substring";
  return null;
}

function bestPersonMatch(row, needle) {
  let best = null;
  for (const [matchedOn, value] of [
    ["displayName", row.display_name],
    ["emailLocalPart", row.email_local_part],
  ]) {
    const kind = matchKind(foldCase(value ?? ""), needle);
    if (kind !== null && (best === null || MATCH_RANK[kind] < MATCH_RANK[best.matchKind])) {
      best = { matchKind: kind, matchedOn };
    }
  }
  return best;
}

function bySessionRank(left, right) {
  return right.score - left.score ||
    right.occurredAt.localeCompare(left.occurredAt) ||
    compareIds(right.eventId, left.eventId);
}

function byRecency(left, right) {
  return right.occurredAt.localeCompare(left.occurredAt) ||
    compareIds(right.eventId, left.eventId);
}

// Keep the strongest hits per session. Identical text is not merged: repeated
// instructions are legitimate evidence and transport duplicates are already
// removed by the canonical rules.
function diversify(matches, perSessionLimit) {
  const sessions = new Map();
  for (const match of matches) {
    const hits = sessions.get(match.sessionId) ?? [];
    hits.push(match);
    sessions.set(match.sessionId, hits);
  }
  return [...sessions.values()].flatMap((hits) => hits
    .sort(bySessionRank)
    .slice(0, perSessionLimit)
    .map((hit) => ({ ...hit, sessionMatchCount: hits.length })));
}

function readCandidates(rows) {
  const scores = new Map();
  for (const row of rows) {
    const eventId = String(row.event_id);
    const score = Number(row.score);
    if (!EVENT_ID_PATTERN.test(eventId) || BigInt(eventId) > MAX_BIGINT ||
        !Number.isFinite(score) || scores.has(eventId)) throw resultInvalid();
    scores.set(eventId, score);
  }
  return scores;
}

function evidenceFingerprint(source, sessionId) {
  return createHash("sha256").update(JSON.stringify([
    source.workspaceId,
    source.expectedEmailDomain,
    sessionId,
  ])).digest("base64url").slice(0, 22);
}

export function encodeEvidenceCursor({ sessionId, atMicroseconds, id, readAt, fingerprint }) {
  const body = Buffer.from(JSON.stringify([
    sessionId, atMicroseconds, id, readAt.toISOString(), fingerprint,
  ]), "utf8").toString("base64url");
  const cursor = `${EVIDENCE_CURSOR_VERSION}.${body}`;
  if (cursor.length > MAX_CURSOR_LENGTH) throw cursorInvalid();
  return cursor;
}

export function decodeEvidenceCursor(cursor, { sessionId, fingerprint, now }) {
  if (typeof cursor !== "string" || cursor.length > MAX_CURSOR_LENGTH) throw cursorInvalid();
  let value;
  try {
    const [version, body, extra] = cursor.split(".");
    if (version !== EVIDENCE_CURSOR_VERSION || !body || extra !== undefined ||
        !/^[A-Za-z0-9_-]+$/.test(body)) throw cursorInvalid();
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== body) throw cursorInvalid();
    value = JSON.parse(decoded);
  } catch {
    throw cursorInvalid();
  }
  if (!Array.isArray(value) || value.length !== 5 ||
      value[0] !== sessionId || value[4] !== fingerprint ||
      typeof value[1] !== "string" || !MICROS_PATTERN.test(value[1]) ||
      typeof value[2] !== "string" || !EVENT_ID_PATTERN.test(value[2]) ||
      BigInt(value[2]) > MAX_BIGINT || typeof value[3] !== "string") throw cursorInvalid();
  const readAt = new Date(value[3]);
  if (!Number.isFinite(readAt.getTime()) || readAt.toISOString() !== value[3] ||
      readAt > now) throw cursorInvalid();
  return { atMicroseconds: value[1], id: value[2], readAt };
}

// Take canonical text turns in scan order. Exhausting the scan budget means
// "unknown beyond here", never "no more events".
function takeContext(rows, want) {
  const events = [];
  let lastKey = null;
  let hasMore = false;
  let nonCanonical = 0;
  let runtimeContext = 0;
  for (const row of rows) {
    if (row.canonical === true && events.length === want) {
      hasMore = true;
      break;
    }
    lastKey = { atMicroseconds: String(row.scanned_at_us), id: String(row.scanned_id) };
    if (row.canonical !== true) nonCanonical += 1;
    else if (isRuntimeContext(row)) runtimeContext += 1;
    else events.push(excerptFromRow(row));
  }
  const scanBudgetReached = !hasMore && rows.length >= EVIDENCE_SCAN_BUDGET;
  return {
    events,
    hasMore: hasMore || scanBudgetReached,
    lastKey,
    scanBudgetReached,
    nonCanonical,
    runtimeContext,
  };
}

function sessionFromRow(row) {
  const children = (row.child_session_ids ?? []).map(String);
  return {
    sessionId: String(row.session_id),
    personId: String(row.person_id),
    displayName: boundedText(row.display_name),
    provider: providerFromVersion(row.normalizer_version),
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: row.ended_at === null || row.ended_at === undefined
      ? null
      : new Date(row.ended_at).toISOString(),
    parentSessionId: row.parent_session_id === null || row.parent_session_id === undefined
      ? null
      : String(row.parent_session_id),
    parentOmitted: row.parent_omitted === true,
    childSessionIds: children.slice(0, EVIDENCE_MAX_CHILD_SESSIONS),
    childSessionsTruncated: children.length > EVIDENCE_MAX_CHILD_SESSIONS,
  };
}

export function createSherlockSearchSource(source) {
  if (typeof source?.transaction !== "function" ||
      typeof source.workspaceId !== "string" || !UUID_PATTERN.test(source.workspaceId) ||
      typeof source.expectedEmailDomain !== "string" || source.expectedEmailDomain === "" ||
      !Number.isSafeInteger(source.maxPeople) || source.maxPeople < 1 ||
      source.maxPeople > ROSTER_SQL_LIMIT) {
    throw new TypeError("A direct Sherlock source is required");
  }
  const read = (signal, callback) => source.transaction(
    callback, { signal, statementTimeoutMs: STATEMENT_TIMEOUT_MS },
  );

  async function openSession(tx, sessionId, signal) {
    const rows = await runQuery(tx, EVIDENCE_SESSION_SQL, [
      source.workspaceId, sessionId, source.expectedEmailDomain,
    ], signal);
    if (rows.length !== 1) throw new FlameSourceError("flame_mcp_query_not_found");
    return rows[0];
  }

  async function context(tx, direction, { sessionId, at, id, readAt, want, signal }) {
    const rows = await runQuery(tx, direction === "after" ? EVIDENCE_AFTER_SQL : EVIDENCE_BEFORE_SQL, [
      source.workspaceId, sessionId, at, id, readAt.toISOString(), source.expectedEmailDomain,
    ], signal);
    return takeContext(rows, want);
  }

  return Object.freeze({
    async resolvePerson({ name, limit, signal } = {}) {
      const needle = parseName(name);
      const pageSize = boundedInteger(limit, PERSON_DEFAULT_LIMIT, 1, PERSON_MAX_LIMIT);
      const rows = await read(signal, async (tx) => await runQuery(tx, PERSON_ROSTER_SQL, [
        source.workspaceId, source.expectedEmailDomain, source.maxPeople + 1,
      ], signal));
      if (rows.length > source.maxPeople) {
        throw new FlameSourceError("flame_mcp_query_roster_too_large");
      }
      const classified = rows
        .map((row) => ({ row, match: bestPersonMatch(row, needle) }))
        .filter(({ match }) => match !== null);
      const bestRank = Math.min(...classified.map(({ match }) => MATCH_RANK[match.matchKind]));
      const matches = classified
        .filter(({ match }) => MATCH_RANK[match.matchKind] === bestRank)
        .map(({ row, match }) => ({
          personId: String(row.person_id),
          displayName: boundedText(row.display_name),
          ...match,
        }))
        .sort((left, right) => foldCase(left.displayName).localeCompare(foldCase(right.displayName)) ||
          left.personId.localeCompare(right.personId));
      return {
        schemaVersion: SEARCH_SCHEMA_VERSION,
        matches: matches.slice(0, pageSize),
        matchCount: matches.length,
        ambiguous: matches.length > 1,
        truncated: matches.length > pageSize,
      };
    },

    async searchSessions({
      query, personId, sessionId, start, end, limit, order = "relevance",
      perSessionLimit, signal, now,
    } = {}) {
      const text = parseQuery(query);
      const person = optionalUuid(personId);
      const session = optionalUuid(sessionId);
      const pageSize = boundedInteger(limit, SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
      const perSession = boundedInteger(
        perSessionLimit, SEARCH_DEFAULT_PER_SESSION_LIMIT, 1, SEARCH_MAX_PER_SESSION_LIMIT,
      );
      if (order !== "relevance" && order !== "recent") throw invalid();
      const window = queryWindow({ start, end }, now);
      const bounds = [
        window.startAt.toISOString(), window.endAt.toISOString(), window.readAt.toISOString(),
      ];
      const { candidates, rows } = await read(signal, async (tx) => {
        let candidateRows;
        try {
          candidateRows = await runQuery(tx, SEARCH_CANDIDATES_SQL, [
            source.workspaceId, text, ...bounds, source.expectedEmailDomain,
            person, session, SEARCH_CANDIDATE_BUDGET,
          ], signal);
        } catch (error) {
          throw helperError(error);
        }
        const scores = readCandidates(candidateRows);
        const ids = [...scores.keys()].slice(0, SEARCH_CANDIDATE_BUDGET);
        const matchRows = ids.length === 0 ? [] : await runQuery(tx, SEARCH_MATCHES_SQL, [
          source.workspaceId, ids, ...bounds, source.expectedEmailDomain, person, session,
        ], signal);
        return { candidates: { scores, examined: ids.length }, rows: matchRows };
      });
      const budgetReached = candidates.scores.size > SEARCH_CANDIDATE_BUDGET;
      const matches = rows
        .filter((row) => !isRuntimeContext(row))
        .map((row) => {
          const score = candidates.scores.get(String(row.event_id));
          if (score === undefined || row.occurred_at_us === null) throw resultInvalid();
          return { ...excerptFromRow(row), score };
        });
      const diverse = diversify(matches, perSession)
        .sort(order === "recent" ? byRecency : bySessionRank);
      const results = diverse.slice(0, pageSize);
      const reasons = [
        "stored_excerpts_only",
        "no_hit_not_absence",
        "canonical_source_verified_not_full_transcript",
        "context_not_snapshot_frozen",
        "product_view_omissions",
      ];
      if (budgetReached) reasons.push("candidate_budget_exceeded");
      if (diverse.length > pageSize) reasons.push("result_capped");
      return {
        schemaVersion: SEARCH_SCHEMA_VERSION,
        window: {
          startInclusive: bounds[0],
          endExclusive: bounds[1],
          readAt: bounds[2],
        },
        order,
        results,
        matchCount: matches.length,
        matchedSessions: new Set(matches.map((match) => match.sessionId)).size,
        budgetReached,
        coverage: {
          state: "partial",
          reasons,
          candidateBudget: SEARCH_CANDIDATE_BUDGET,
          candidatesExamined: candidates.examined,
          canonicalMatches: matches.length,
          returnedMatches: results.length,
          limit: pageSize,
          perSessionLimit: perSession,
        },
      };
    },

    async readSessionEvidence({
      sessionId, anchorEventId, cursor, limit, signal, now,
    } = {}) {
      if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) throw invalid();
      const targetSession = sessionId.toLowerCase();
      if (anchorEventId !== undefined && cursor !== undefined) throw invalid();
      const anchorId = anchorEventId === undefined ? null : parseEventId(anchorEventId);
      const pageSize = boundedInteger(limit, EVIDENCE_DEFAULT_LIMIT, 1, EVIDENCE_MAX_LIMIT);
      const requestNow = new Date(now ?? Date.now());
      if (!Number.isFinite(requestNow.getTime())) throw invalid();
      const fingerprint = evidenceFingerprint(source, targetSession);
      const position = cursor === undefined
        ? null
        : decodeEvidenceCursor(cursor, { sessionId: targetSession, fingerprint, now: requestNow });
      const readAt = position?.readAt ?? requestNow;

      const page = await read(signal, async (tx) => {
        const sessionRow = await openSession(tx, targetSession, signal);
        const request = { sessionId: targetSession, readAt, signal };
        if (anchorId === null) {
          const after = await context(tx, "after", {
            ...request,
            at: position ? microsToIso(position.atMicroseconds) : "-infinity",
            id: position?.id ?? "0",
            want: pageSize,
          });
          return { sessionRow, anchor: null, before: null, after };
        }
        const anchorRows = await runQuery(tx, EVIDENCE_ANCHOR_SQL, [
          source.workspaceId, targetSession, anchorId, source.expectedEmailDomain,
        ], signal);
        if (anchorRows.length !== 1 || String(anchorRows[0].event_id) !== anchorId) {
          throw new FlameSourceError("flame_mcp_query_not_found");
        }
        const anchor = anchorRows[0];
        if (anchor.occurred_at_us === null || anchor.occurred_at_us === undefined) {
          return { sessionRow, anchor, before: null, after: null };
        }
        const prior = Math.floor(pageSize / 3);
        const key = { at: microsToIso(String(anchor.occurred_at_us)), id: anchorId };
        const before = await context(tx, "before", { ...request, ...key, want: prior });
        const after = await context(tx, "after", {
          ...request, ...key, want: pageSize - prior - 1,
        });
        return { sessionRow, anchor, before, after };
      });

      const seen = new Set();
      const events = [
        ...(page.before?.events.toReversed() ?? []),
        ...(page.anchor === null ? [] : [{
          ...excerptFromRow(page.anchor),
          isAnchor: true,
          canonicalAtRead: page.anchor.canonical_at_read === true,
        }]),
        ...(page.after?.events ?? []),
      ].map((event) => ({ isAnchor: false, canonicalAtRead: true, ...event }))
        .filter((event) => !seen.has(event.eventId) && seen.add(event.eventId));
      const walks = [page.before, page.after].filter(Boolean);
      const scanBudgetReached = walks.some((walk) => walk.scanBudgetReached);
      const untimed = nullableCount(page.sessionRow.untimed_messages) ?? 0;
      const truncatedExcerpts = events.filter((event) => event.excerptTruncated).length;
      const runtimeContextOmitted = walks.reduce((sum, walk) => sum + walk.runtimeContext, 0);
      const reasons = [
        "stored_excerpts_only",
        "canonical_source_verified_not_full_transcript",
        "context_not_snapshot_frozen",
        "product_view_omissions",
      ];
      if (truncatedExcerpts > 0) reasons.push("excerpts_truncated");
      if (untimed > 0) reasons.push("untimed_messages_excluded");
      if (page.anchor !== null && page.after === null) reasons.push("anchor_timestamp_missing");
      if (scanBudgetReached) reasons.push("scan_budget_reached");
      if (runtimeContextOmitted > 0) reasons.push("runtime_context_omitted");
      if (page.anchor !== null && page.anchor.canonical_at_read !== true) {
        reasons.push("anchor_not_canonical_at_read");
      }
      const next = page.after;
      // limit:1 consumes only the anchor. If later rows exist, resume after
      // the anchor even when the zero-sized walk consumed no scan position.
      const nextKey = next?.lastKey ?? (page.anchor?.occurred_at_us == null ? null : {
        atMicroseconds: String(page.anchor.occurred_at_us), id: anchorId,
      });
      return {
        schemaVersion: SEARCH_SCHEMA_VERSION,
        session: sessionFromRow(page.sessionRow),
        readAt: readAt.toISOString(),
        anchorEventId: anchorId,
        events,
        hasEarlier: page.before === null ? null : page.before.hasMore,
        nextCursor: next?.hasMore && nextKey !== null ? encodeEvidenceCursor({
          sessionId: targetSession,
          ...nextKey,
          readAt,
          fingerprint,
        }) : null,
        coverage: {
          state: "partial",
          reasons,
          readAt: readAt.toISOString(),
          returnedEvents: events.length,
          truncatedExcerpts,
          redactedExcerpts: events.filter((event) => event.excerptRedacted).length,
          scanBudget: EVIDENCE_SCAN_BUDGET,
          scanBudgetReached,
          nonCanonicalSkipped: walks.reduce((sum, walk) => sum + walk.nonCanonical, 0),
          runtimeContextOmitted,
          untimedMessages: Math.min(untimed, 100),
          untimedMessagesCapped: untimed > 100,
        },
      };
    },
  });
}
