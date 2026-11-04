import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ExcerptRateLimitError,
  UNATTRIBUTED_CALLER,
  callerFromHeaders,
  createExcerptGuard,
  excerptReadIds,
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
      principal: "ada",
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

  it("falls back to the first email and maps headers to a caller bucket", () => {
    const pass = mintPass({ v: 1, a: "sherlock", e: ["bo@e3group.ai"], t: "admin", x: 1_800_000_120 });
    expect(callerFromHeaders({ "x-e3-identity-pass": pass }, { secret: SECRET, nowMs: PASS_NOW_MS }))
      .toEqual({ key: "principal:bo@e3group.ai", principal: "bo@e3group.ai", tier: "admin", requestId: null, attributed: true });
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

  it("logs identifiers only", () => {
    const events = [];
    const guard = createExcerptGuard({ limits: LIMITS, now: () => 0, log: (event) => events.push(event) });
    guard.record({ ...caller("ada"), requestId: "req-1" }, {
      tool: "search_sessions", outcome: "ok", sessionIds: ["s1", "s1", "s2"], ownerPersonIds: ["p1", "p1"],
    });
    expect(events).toEqual([{
      event: "sherlock_excerpt_read", tool: "search_sessions", outcome: "ok", caller: "ada",
      tier: "standard", attributed: true, requestId: "req-1", sessionIds: ["s1", "s2"], ownerPersonIds: ["p1"],
    }]);
  });

  it("extracts session and owner ids from each excerpt tool result", () => {
    expect(excerptReadIds("get_session_evidence", { sessionId: "s1" }, {
      session: { sessionId: "s1", personId: "p1" }, events: [{ contentExcerpt: "secret" }],
    })).toEqual({ sessionIds: ["s1"], ownerPersonIds: ["p1"] });
    expect(excerptReadIds("get_session_evidence", { sessionId: "s1" }, null))
      .toEqual({ sessionIds: ["s1"], ownerPersonIds: [] });
    expect(excerptReadIds("search_sessions", {}, {
      results: [{ sessionId: "s1", personId: "p1", alternativeSources: [{ sessionId: "s2" }] }],
    })).toEqual({ sessionIds: ["s1", "s2"], ownerPersonIds: ["p1"] });
    expect(excerptReadIds("list_prompt_evidence", { personId: "p3" }, { prompts: [] }))
      .toEqual({ sessionIds: [], ownerPersonIds: ["p3"] });
  });
});
