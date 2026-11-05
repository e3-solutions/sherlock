import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ExcerptRateLimitError,
  UNATTRIBUTED_CALLER,
  callerFromHeaders,
  createExcerptGuard,
  excerptReads,
  verifyIdentityPass,
} from "./mcp-excerpt-guard.js";

const SECRET = "k".repeat(32);
// Minted by e3-mcp gateway/identity_pass.py: mint(["ada@e3group.ai"], "standard",
// secret="k"*32, audience="sherlock", principal="ada", request_id=..., now=1800000000).
const GATEWAY_PASS = "e3id.eyJhIjoic2hlcmxvY2siLCJlIjpbImFkYUBlM2dyb3VwLmFpIl0sInAiOiJhZGEiLCJyIjoiMGY4ZmFkNWItZDljYi00NjlmLWExNjUtNzA4Njc3Mjg5NTBlIiwidCI6InN0YW5kYXJkIiwidiI6MSwieCI6MTgwMDAwMDEyMH0.LtkjoZREhG89-1TznbIShfpuNObt102VwbV94A3XQoM";
const PASS_NOW_MS = 1_800_000_000_000;

function mintPass(payload, secret = SECRET) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `e3id.${body}.${signature}`;
}

const LIMITS = {
  windowMs: 60_000,
  callsPerWindow: 3,
  sessionsPerWindow: 2,
  unattributedCallsPerWindow: 4,
  unattributedSessionsPerWindow: 1,
  maxCallers: 2,
};

function caller(principal) {
  return { key: `principal:${principal}`, principal, tier: "standard", requestId: null, attributed: true };
}

describe("identity pass verification", () => {
  it("accepts a pass minted by the Cosmos gateway", () => {
    expect(verifyIdentityPass(GATEWAY_PASS, { secret: SECRET, nowMs: PASS_NOW_MS })).toEqual({
      principal: "ada@e3group.ai",
      verifiedLogin: true,
      tier: "standard",
      requestId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    });
  });

  it("rejects expired, forged, wrong-audience and unsigned passes", () => {
    expect(verifyIdentityPass(GATEWAY_PASS, { secret: SECRET, nowMs: PASS_NOW_MS + 121_000 })).toBeNull();
    expect(verifyIdentityPass(GATEWAY_PASS, { secret: "j".repeat(32), nowMs: PASS_NOW_MS })).toBeNull();
    expect(verifyIdentityPass(GATEWAY_PASS, { secret: "", nowMs: PASS_NOW_MS })).toBeNull();
    const [, body] = GATEWAY_PASS.split(".");
    expect(verifyIdentityPass(`e3id.${body}.`, { secret: SECRET, nowMs: PASS_NOW_MS })).toBeNull();
    const devmetrics = mintPass({ v: 1, a: "devmetrics", e: ["ada@e3group.ai"], p: "ada", x: 1_800_000_120 });
    expect(verifyIdentityPass(devmetrics, { secret: SECRET, nowMs: PASS_NOW_MS })).toBeNull();
    const anonymous = mintPass({ v: 1, a: "sherlock", e: [], x: 1_800_000_120 });
    expect(verifyIdentityPass(anonymous, { secret: SECRET, nowMs: PASS_NOW_MS })).toBeNull();
  });

  it("keys on the verified login, so same-named principals do not share a bucket", () => {
    const pass = mintPass({ v: 1, a: "sherlock", e: ["Bo@e3group.ai"], p: "bo", t: "admin", x: 1_800_000_120 });
    expect(callerFromHeaders({ "x-e3-identity-pass": pass }, { secret: SECRET, nowMs: PASS_NOW_MS }))
      .toEqual({ key: "login:bo@e3group.ai", principal: "bo@e3group.ai", tier: "admin", requestId: null, attributed: true });
    const token = mintPass({ v: 1, a: "sherlock", e: [], p: "bo", x: 1_800_000_120 });
    expect(callerFromHeaders({ "x-e3-identity-pass": token }, { secret: SECRET, nowMs: PASS_NOW_MS }))
      .toMatchObject({ key: "principal:bo", principal: "bo" });
    expect(callerFromHeaders({}, { secret: SECRET })).toBe(UNATTRIBUTED_CALLER);
    expect(callerFromHeaders({ "x-e3-identity-pass": pass }, { secret: "" })).toBe(UNATTRIBUTED_CALLER);
  });
});

describe("excerpt guard", () => {
  it("limits distinct sessions per caller and reports when to retry", () => {
    let at = 1_000;
    const events = [];
    const guard = createExcerptGuard({
      limits: { ...LIMITS, callsPerWindow: 10 }, now: () => at, log: (event) => events.push(event),
    });
    const ada = caller("ada");
    guard.admit(ada, { tool: "get_session_evidence", sessionId: "s1" });
    at = 2_000;
    guard.admit(ada, { tool: "get_session_evidence", sessionId: "s2" });
    // Re-reading a session already in the window costs a call, not a session.
    guard.admit(ada, { tool: "get_session_evidence", sessionId: "s1" });
    expect(() => guard.admit(ada, { tool: "get_session_evidence", sessionId: "s3" }))
      .toThrow(ExcerptRateLimitError);
    expect(events.at(-1)).toMatchObject({
      event: "sherlock_excerpt_rate_limited", caller: "ada", sessionId: "s3", sessionsInWindow: 2,
      retryAfterSeconds: 60,
    });
    // Another caller has its own budget.
    guard.admit(caller("bo"), { tool: "get_session_evidence", sessionId: "s3" });
    at = 62_001;
    guard.admit(ada, { tool: "get_session_evidence", sessionId: "s3" });
  });

  it("limits calls per caller and shares one tighter bucket for unattributed callers", () => {
    let at = 0;
    const guard = createExcerptGuard({ limits: LIMITS, now: () => at, log: () => {} });
    const ada = caller("ada");
    for (let index = 0; index < 3; index += 1) guard.admit(ada, { tool: "search_sessions" });
    let error;
    try { guard.admit(ada, { tool: "search_sessions" }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ExcerptRateLimitError);
    expect(error.retryAfterSeconds).toBe(60);

    guard.admit(UNATTRIBUTED_CALLER, { tool: "get_session_evidence", sessionId: "s1" });
    expect(() => guard.admit(UNATTRIBUTED_CALLER, { tool: "get_session_evidence", sessionId: "s2" }))
      .toThrow(ExcerptRateLimitError);
    for (let index = 0; index < 3; index += 1) guard.admit(UNATTRIBUTED_CALLER, { tool: "search_sessions" });
    expect(() => guard.admit(UNATTRIBUTED_CALLER, { tool: "search_sessions" }))
      .toThrow(ExcerptRateLimitError);
    at = 60_001;
    guard.admit(UNATTRIBUTED_CALLER, { tool: "get_session_evidence", sessionId: "s2" });
  });

  it("bounds the number of tracked callers", () => {
    const guard = createExcerptGuard({ limits: LIMITS, now: () => 0, log: () => {} });
    for (let index = 0; index < 3; index += 1) guard.admit(caller("ada"), { tool: "search_sessions" });
    guard.admit(caller("bo"), { tool: "search_sessions" });
    guard.admit(caller("cy"), { tool: "search_sessions" });
    // ada was evicted as the least recently seen caller, so its window restarted.
    guard.admit(caller("ada"), { tool: "search_sessions" });
  });

  it("never limits admin callers", () => {
    const guard = createExcerptGuard({ limits: LIMITS, now: () => 0, log: () => {} });
    const admin = { ...caller("root"), tier: "admin" };
    for (let index = 0; index < 20; index += 1) {
      guard.admit(admin, { tool: "get_session_evidence", sessionId: `s${index}` });
    }
    // An unsigned "admin" claim is not possible: only attributed callers carry a tier.
    expect(() => {
      for (let index = 0; index < 5; index += 1) {
        guard.admit({ ...UNATTRIBUTED_CALLER, tier: "admin" }, { tool: "search_sessions" });
      }
    }).toThrow(ExcerptRateLimitError);
  });

  it("logs identifiers only and queues one audit row per session read", () => {
    const events = [];
    const rows = [];
    const guard = createExcerptGuard({
      limits: LIMITS, now: () => 0, log: (event) => events.push(event), audit: { push: (batch) => rows.push(...batch) },
    });
    guard.record({ ...caller("ada"), requestId: "req-1" }, {
      tool: "search_sessions", outcome: "ok", reads: [
        { sessionId: "s1", ownerPersonId: "p1" }, { sessionId: "s1", ownerPersonId: "p1" },
        { sessionId: "s2", ownerPersonId: "p1" },
      ],
    });
    guard.record(UNATTRIBUTED_CALLER, { tool: "search_sessions", outcome: "rate_limited", reads: [] });
    expect(events[0]).toEqual({
      event: "sherlock_excerpt_read", tool: "search_sessions", outcome: "ok", caller: "ada",
      tier: "standard", attributed: true, requestId: "req-1", sessionIds: ["s1", "s2"], ownerPersonIds: ["p1"],
    });
    expect(rows).toEqual([
      { read_at: "1970-01-01T00:00:00.000Z", tool: "search_sessions", outcome: "ok", caller: "ada",
        caller_tier: "standard", request_id: "req-1", session_id: "s1", owner_person_id: "p1" },
      { read_at: "1970-01-01T00:00:00.000Z", tool: "search_sessions", outcome: "ok", caller: "ada",
        caller_tier: "standard", request_id: "req-1", session_id: "s2", owner_person_id: "p1" },
      { read_at: "1970-01-01T00:00:00.000Z", tool: "search_sessions", outcome: "rate_limited", caller: null,
        caller_tier: null, request_id: null, session_id: null, owner_person_id: null },
    ]);
  });

  it("extracts session and owner pairs from each excerpt tool result", () => {
    expect(excerptReads("get_session_evidence", { sessionId: "S1" }, {
      session: { sessionId: "s1", personId: "p1" }, events: [{ contentExcerpt: "secret" }],
    })).toEqual([{ sessionId: "s1", ownerPersonId: "p1" }]);
    expect(excerptReads("get_session_evidence", { sessionId: "S1" }, null))
      .toEqual([{ sessionId: "s1", ownerPersonId: null }]);
    expect(excerptReads("search_sessions", {}, {
      results: [{ sessionId: "s1", personId: "p1", excerptGroup: { alternativeSources: [{ sessionId: "s2" }] } }],
    })).toEqual([{ sessionId: "s1", ownerPersonId: "p1" }, { sessionId: "s2", ownerPersonId: "p1" }]);
    expect(excerptReads("search_sessions", { sessionId: "s9" }, null))
      .toEqual([{ sessionId: "s9", ownerPersonId: null }]);
    expect(excerptReads("search_sessions", {}, null)).toEqual([]);
    expect(excerptReads("list_prompt_evidence", { personId: "p3" }, { prompts: [] }))
      .toEqual([{ sessionId: null, ownerPersonId: "p3" }]);
  });
});
