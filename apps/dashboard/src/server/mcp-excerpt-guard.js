import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";

// Cosmos signs the verified caller into this header (e3-mcp identity_pass.py,
// format e3id.<b64url(payload)>.<b64url(HMAC-SHA256(secret, b64url(payload)))>).
// It is trusted only after the shared bearer has been verified.
export const IDENTITY_PASS_HEADER = "x-e3-identity-pass";
export const IDENTITY_PASS_AUDIENCE = "sherlock";
export const IDENTITY_PASS_SECRET_MIN_LENGTH = 32;
const IDENTITY_PASS_MAX_LENGTH = 4096;
const PRINCIPAL_MAX_LENGTH = 256;

export const EXCERPT_TOOLS = Object.freeze(new Set([
  "search_sessions",
  "get_session_evidence",
  "list_prompt_evidence",
]));

// Picked from 30 days of Cosmos audit rows (Oct 5 - Nov 4, 2026). Ordinary
// caller-hours peaked at 41 distinct sessions read (p99 28) and 371 excerpt
// calls (p99 290); the three bulk sweeps read 216, 262 and 3,042 sessions.
// Callers without a valid pass share one bucket; every caller together never
// exceeded 41 sessions or 372 calls in an hour.
export const EXCERPT_LIMITS = Object.freeze({
  windowMs: 60 * 60 * 1000,
  callsPerWindow: 400,
  sessionsPerWindow: 60,
  unattributedCallsPerWindow: 800,
  unattributedSessionsPerWindow: 120,
  maxCallers: 1000,
});

export const UNATTRIBUTED_CALLER = Object.freeze({
  key: "unattributed",
  principal: null,
  tier: null,
  requestId: null,
  attributed: false,
});

const requestCaller = new AsyncLocalStorage();

export function runWithCaller(caller, callback) {
  return requestCaller.run(caller, callback);
}

export function currentCaller() {
  return requestCaller.getStore() ?? UNATTRIBUTED_CALLER;
}

function b64url(buffer) {
  return buffer.toString("base64url");
}

function boundedString(value, max) {
  return typeof value === "string" && value.trim() !== "" && value.length <= max
    ? value.trim()
    : null;
}

export function verifyIdentityPass(token, { secret, nowMs = Date.now() } = {}) {
  if (typeof secret !== "string" || secret.length < IDENTITY_PASS_SECRET_MIN_LENGTH) return null;
  if (typeof token !== "string" || token.length > IDENTITY_PASS_MAX_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "e3id") return null;
  const [, body, signature] = parts;
  const expected = Buffer.from(b64url(createHmac("sha256", secret).update(body, "utf8").digest()));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || payload.v !== 1) return null;
  if (payload.a !== IDENTITY_PASS_AUDIENCE) return null;
  if (!Number.isSafeInteger(payload.x) || payload.x <= Math.floor(nowMs / 1000)) return null;
  const emails = Array.isArray(payload.e)
    ? payload.e.map((email) => boundedString(email, PRINCIPAL_MAX_LENGTH)).filter(Boolean)
    : [];
  const principal = boundedString(payload.p, PRINCIPAL_MAX_LENGTH) ?? emails[0] ?? null;
  if (principal === null) return null;
  return {
    principal,
    tier: boundedString(payload.t, 32) ?? "standard",
    requestId: boundedString(payload.r, 128),
  };
}

export function callerFromHeaders(headers, { secret, nowMs } = {}) {
  const raw = headers?.[IDENTITY_PASS_HEADER];
  const pass = verifyIdentityPass(Array.isArray(raw) ? raw[0] : raw, { secret, nowMs });
  if (pass === null) return UNATTRIBUTED_CALLER;
  return Object.freeze({ key: `principal:${pass.principal}`, ...pass, attributed: true });
}

export class ExcerptRateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super("Sherlock excerpt rate limit reached");
    this.name = "ExcerptRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isAdminCaller(caller) {
  return caller?.attributed === true && caller.tier === "admin";
}

// Sliding one-hour window per caller, held in memory on the single dashboard
// instance. A restart forgets the window, which only ever loosens the limit.
// Cosmos admin callers are not limited, but every read is still audited.
export function createExcerptGuard({
  limits = EXCERPT_LIMITS,
  now = Date.now,
  log = (event) => console.log(JSON.stringify(event)),
  audit = null,
} = {}) {
  const callers = new Map();

  function bucket(caller) {
    let entry = callers.get(caller.key);
    if (entry === undefined) {
      if (callers.size >= limits.maxCallers) callers.delete(callers.keys().next().value);
      entry = { calls: [], sessions: new Map() };
    } else {
      callers.delete(caller.key);
    }
    callers.set(caller.key, entry);
    return entry;
  }

  function prune(entry, cutoff) {
    while (entry.calls.length > 0 && entry.calls[0] <= cutoff) entry.calls.shift();
    for (const [sessionId, seenAt] of entry.sessions) {
      if (seenAt > cutoff) break;
      entry.sessions.delete(sessionId);
    }
  }

  return Object.freeze({
    // Counts the call (and a newly requested session) before any read runs,
    // so failed or slow reads still consume budget.
    admit(caller, { tool, sessionId = null }) {
      if (isAdminCaller(caller)) return;
      const at = now();
      const entry = bucket(caller);
      prune(entry, at - limits.windowMs);
      const callLimit = caller.attributed ? limits.callsPerWindow : limits.unattributedCallsPerWindow;
      const sessionLimit = caller.attributed
        ? limits.sessionsPerWindow
        : limits.unattributedSessionsPerWindow;
      const newSession = sessionId !== null && !entry.sessions.has(sessionId);
      let resetAt = null;
      if (entry.calls.length >= callLimit) resetAt = entry.calls[0] + limits.windowMs;
      else if (newSession && entry.sessions.size >= sessionLimit) {
        resetAt = entry.sessions.values().next().value + limits.windowMs;
      }
      if (resetAt !== null) {
        const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - at) / 1000));
        log({
          event: "sherlock_excerpt_rate_limited",
          tool,
          caller: caller.principal,
          attributed: caller.attributed,
          requestId: caller.requestId,
          sessionId,
          callsInWindow: entry.calls.length,
          sessionsInWindow: entry.sessions.size,
          retryAfterSeconds,
        });
        throw new ExcerptRateLimitError(retryAfterSeconds);
      }
      entry.calls.push(at);
      if (sessionId !== null) {
        entry.sessions.delete(sessionId);
        entry.sessions.set(sessionId, at);
      }
    },

    // Audit trail: identifiers only, never excerpt content. One durable row
    // per session read (or one row when no session was resolved).
    record(caller, { tool, outcome, reads = [] }) {
      const readAt = new Date(now()).toISOString();
      const unique = [...new Map(reads.map((read) => [
        `${read.sessionId ?? ""}:${read.ownerPersonId ?? ""}`, read,
      ])).values()];
      log({
        event: "sherlock_excerpt_read",
        tool,
        outcome,
        caller: caller.principal,
        tier: caller.tier,
        attributed: caller.attributed,
        requestId: caller.requestId,
        sessionIds: [...new Set(unique.map((read) => read.sessionId).filter(Boolean))],
        ownerPersonIds: [...new Set(unique.map((read) => read.ownerPersonId).filter(Boolean))],
      });
      audit?.push((unique.length > 0 ? unique : [{ sessionId: null, ownerPersonId: null }])
        .map((read) => ({
          read_at: readAt,
          tool,
          outcome,
          caller: caller.principal,
          caller_tier: caller.tier,
          request_id: caller.requestId,
          session_id: read.sessionId ?? null,
          owner_person_id: read.ownerPersonId ?? null,
        })));
    },
  });
}

function requestedSession(args) {
  return typeof args?.sessionId === "string" ? args.sessionId.toLowerCase() : null;
}

// (session, owner) pairs an excerpt call read, from its result or, when the
// call failed or was refused, from its arguments.
export function excerptReads(tool, args, result) {
  if (tool === "get_session_evidence") {
    const sessionId = result?.session?.sessionId ?? requestedSession(args);
    return sessionId ? [{ sessionId, ownerPersonId: result?.session?.personId ?? null }] : [];
  }
  if (tool === "search_sessions") {
    if (!result) {
      const sessionId = requestedSession(args);
      return sessionId ? [{ sessionId, ownerPersonId: null }] : [];
    }
    const reads = [];
    // Identical-excerpt groups are per person, so alternatives share the owner.
    for (const match of result.results ?? []) {
      reads.push({ sessionId: match.sessionId, ownerPersonId: match.personId });
      for (const alternative of match.excerptGroup?.alternativeSources ?? match.alternativeSources ?? []) {
        reads.push({ sessionId: alternative.sessionId, ownerPersonId: match.personId });
      }
    }
    return reads.filter((read) => read.sessionId);
  }
  return typeof args?.personId === "string"
    ? [{ sessionId: null, ownerPersonId: args.personId.toLowerCase() }]
    : [];
}
