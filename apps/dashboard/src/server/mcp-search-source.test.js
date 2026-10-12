import { describe, expect, it } from "vitest";

import { FlameSourceError } from "./flame-source.js";
import {
  activeNormalizerPredicate,
  canonicalWinnerPredicate,
} from "./mcp-query-source.js";
import {
  EVIDENCE_AFTER_SQL,
  EVIDENCE_ANCHOR_SQL,
  EVIDENCE_BEFORE_SQL,
  EVIDENCE_SCAN_BUDGET,
  EVIDENCE_SESSION_SQL,
  PERSON_ROSTER_SQL,
  SEARCH_CANDIDATES_SQL,
  SEARCH_CANDIDATE_BUDGET,
  SEARCH_MATCHES_SQL,
  SEARCH_SCHEMA_VERSION,
  createSherlockSearchSource,
  decodeEvidenceCursor,
  encodeEvidenceCursor,
  excerptView,
  microsToIso,
  redactCredentials,
} from "./mcp-search-source.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const HASH = "a".repeat(64);

function fakeSource(handlers, { maxPeople = 5 } = {}) {
  const calls = [];
  const transactions = [];
  const tx = {
    unsafe(text, params) {
      calls.push({ text, params });
      const handler = handlers.get(text);
      const result = handler
        ? Promise.resolve().then(() => handler(params))
        : Promise.reject(new Error("unexpected query"));
      result.cancel = () => {};
      return result;
    },
  };
  return {
    calls,
    transactions,
    source: createSherlockSearchSource({
      workspaceId: WORKSPACE,
      expectedEmailDomain: "e3group.ai",
      maxPeople,
      async transaction(callback, options) {
        transactions.push(options);
        return await callback(tx);
      },
    }),
  };
}

function eventRow(id, overrides = {}) {
  return {
    event_id: String(id),
    session_id: SESSION,
    person_id: PERSON,
    display_name: "Ada Lovelace",
    source_provider: "codex",
    event_kind: "message",
    message_role: "user",
    message_origin: "human",
    occurred_at_us: String(1_790_000_000_000_000 + id),
    content_excerpt: `excerpt ${id}`,
    content_byte_size: 10,
    content_sha256: HASH,
    source_record_id: String(9000 + id),
    record_sha256: "B".repeat(64),
    normalizer_version: "sherlock.codex-rollout.v3",
    ...overrides,
  };
}

function scannedRow(id, canonical = true, overrides = {}) {
  const row = eventRow(id, overrides);
  return { ...row, scanned_id: row.event_id, scanned_at_us: row.occurred_at_us, canonical };
}

const SESSION_ROW = {
  session_id: SESSION,
  person_id: PERSON,
  display_name: "Ada Lovelace",
  started_at: "2026-09-01T00:00:00.000Z",
  ended_at: null,
  parent_session_id: null,
  normalizer_version: "sherlock.codex-rollout.v3",
  child_session_ids: Array.from({ length: 21 }, (_, index) =>
    `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`),
  untimed_messages: 2,
};

describe("credential redaction", () => {
  it("redacts obvious credential formats without touching ordinary text", () => {
    const secrets = [
      "sk-proj-abc123DEF456ghi789JKL",
      "ghp_0123456789abcdefghijABCDEFGHIJ",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      "AKIAIOSFODNN7EXAMPLE",
      "ASIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ];
    for (const secret of secrets) {
      const result = redactCredentials(`token=${secret} done`);
      expect(result).toEqual({ text: "token=[REDACTED] done", redacted: true });
    }
    expect(redactCredentials("Authorization: Bearer abcdefghijklmnop0123456789").text)
      .toBe("Authorization: Bearer [REDACTED]");
    expect(redactCredentials("postgres://reader:hunter2@db.internal:5432/app").text)
      .toBe("postgres://reader:[REDACTED]@db.internal:5432/app");
    for (const ordinary of [
      "use sk-learn-style pipelines for task-management-system",
      "https://example.com:8080/path@section",
      "Bearer token",
    ]) {
      expect(redactCredentials(ordinary)).toEqual({ text: ordinary, redacted: false });
    }
  });

  it("bounds multibyte excerpts by source bytes and reports truncation from original bytes", () => {
    const full = "é".repeat(600);
    const view = excerptView(full, 1200);
    expect(Buffer.byteLength(view.contentExcerpt, "utf8")).toBe(1024);
    expect(view.contentExcerpt).toBe("é".repeat(512));
    expect(view.excerptTruncated).toBe(true);

    expect(excerptView("é".repeat(10), 20)).toMatchObject({ excerptTruncated: false });
    expect(excerptView("é".repeat(10), 21)).toMatchObject({ excerptTruncated: true });
    expect(excerptView("😀".repeat(300), 1200).contentExcerpt).toBe("😀".repeat(256));

    const expanding = Array.from({ length: 200 }, () => "x://u:p@").join("");
    const redacted = excerptView(expanding, Buffer.byteLength(expanding));
    expect(redacted.excerptRedacted).toBe(true);
    expect(redacted.contentExcerpt.length).toBeLessThanOrEqual(1100);
    expect(redacted.excerptTruncated).toBe(true);
  });
});

describe("resolvePerson", () => {
  const roster = [
    { person_id: "p-1", display_name: "Sharad Rao", email_local_part: "sharad" },
    { person_id: "p-2", display_name: "Sharad Mehta", email_local_part: "smehta" },
    { person_id: "p-3", display_name: "Sharada", email_local_part: "sharada.k" },
    { person_id: "p-4", display_name: "Bo", email_local_part: "robo" },
  ];

  it("prefers the strongest match class, flags ambiguity, and never returns email", async () => {
    const { source, calls, transactions } = fakeSource(new Map([[PERSON_ROSTER_SQL, () => roster]]));
    const exact = await source.resolvePerson({ name: "  SHARAD " });
    expect(exact).toEqual({
      schemaVersion: SEARCH_SCHEMA_VERSION,
      matches: [{
        personId: "p-1", displayName: "Sharad Rao", matchKind: "exact", matchedOn: "emailLocalPart",
      }],
      matchCount: 1,
      ambiguous: false,
      truncated: false,
    });
    expect(calls[0].params).toEqual([WORKSPACE, "e3group.ai", 6]);
    expect(transactions[0]).toMatchObject({ statementTimeoutMs: 10_000 });

    const prefix = await source.resolvePerson({ name: "shara", limit: 2 });
    expect(prefix.matches.map((match) => match.personId)).toEqual(["p-2", "p-1"]);
    expect(prefix).toMatchObject({ matchCount: 3, ambiguous: true, truncated: true });
    expect(JSON.stringify(prefix)).not.toContain("smehta");

    const substring = await source.resolvePerson({ name: "obo" });
    expect(substring.matches).toEqual([
      { personId: "p-4", displayName: "Bo", matchKind: "substring", matchedOn: "emailLocalPart" },
    ]);
  });

  it("rejects invalid names and oversized rosters", async () => {
    const { source, calls } = fakeSource(new Map([[PERSON_ROSTER_SQL, () => roster]]), {
      maxPeople: 3,
    });
    for (const name of ["", "   ", "a\u0000b", "x".repeat(129), 7]) {
      await expect(source.resolvePerson({ name })).rejects.toThrow("flame_mcp_query_request_invalid");
    }
    await expect(source.resolvePerson({ name: "a", limit: 11 })).rejects.toThrow(FlameSourceError);
    expect(calls).toHaveLength(0);
    await expect(source.resolvePerson({ name: "sharad" }))
      .rejects.toThrow("flame_mcp_query_roster_too_large");
  });
});

describe("searchSessions", () => {
  function searchSource(candidates, matches) {
    return fakeSource(new Map([
      [SEARCH_CANDIDATES_SQL, typeof candidates === "function" ? candidates : () => candidates],
      [SEARCH_MATCHES_SQL, () => matches],
    ]));
  }

  it("rejects invalid input without querying or echoing the query", async () => {
    const { source, calls } = searchSource([], []);
    const invalidRequests = [
      { query: "a" },
      { query: "x".repeat(257) },
      { query: "secret-canary one two three four five six seven eight" },
      { query: "line\nbreak" },
      { query: "!!" },
      { query: "secret-canary", personId: "not-a-uuid" },
      { query: "secret-canary", sessionId: "1" },
      { query: "secret-canary", limit: 21 },
      { query: "secret-canary", perSessionLimit: 6 },
      { query: "secret-canary", order: "oldest" },
      { query: "secret-canary", end: "2026-10-01T12:00:00.001Z", now: NOW },
    ];
    for (const request of invalidRequests) {
      const error = await source.searchSessions(request).catch((caught) => caught);
      expect(error).toBeInstanceOf(FlameSourceError);
      expect(error.message).not.toContain("canary");
    }
    expect(calls).toHaveLength(0);
  });

  it("verifies helper candidates canonically under the reader and diversifies sessions", async () => {
    const candidates = [
      { event_id: "1", score: 0.9 },
      { event_id: "2", score: 0.8 },
      { event_id: "3", score: 0.7 },
      { event_id: "4", score: 0.95 },
      { event_id: "5", score: 0.99 },
      { event_id: "6", score: 0.5 },
    ];
    const matches = [
      eventRow(1, { content_excerpt: "repeat the eval" }),
      eventRow(2, { content_excerpt: "repeat the eval" }),
      eventRow(3),
      eventRow(4, { session_id: OTHER_SESSION, event_kind: "agent_message", message_role: null }),
      eventRow(5, { content_excerpt: "<environment_context>cwd</environment_context>" }),
    ];
    const { source, calls } = searchSource(candidates, matches);
    const result = await source.searchSessions({
      query: "  eval or \"ocr accuracy\" -pdf ",
      personId: PERSON,
      start: "2026-01-01T00:00:00.000Z",
      limit: 2,
      now: NOW,
    });

    expect(calls[0].params).toEqual([
      WORKSPACE, "eval or \"ocr accuracy\" -pdf", "2026-01-01T00:00:00.000Z",
      NOW.toISOString(), NOW.toISOString(), "e3group.ai", PERSON, null, SEARCH_CANDIDATE_BUDGET,
    ]);
    expect(calls[1].params).toEqual([
      WORKSPACE, ["1", "2", "3", "4", "5", "6"], "2026-01-01T00:00:00.000Z",
      NOW.toISOString(), NOW.toISOString(), "e3group.ai", PERSON, null,
    ]);
    expect(result.results.map((hit) => [hit.eventId, hit.score, hit.sessionMatchCount]))
      .toEqual([["4", 0.95, 1], ["1", 0.9, 3]]);
    expect(result.results[0]).toMatchObject({
      role: "assistant",
      origin: "human",
      provider: "codex",
      contentTrust: "untrusted_session_content",
      contentSha256: HASH,
      source: { sourceRecordId: "9004", recordSha256: "b".repeat(64) },
    });
    expect(result).toMatchObject({
      matchCount: 4,
      matchedSessions: 2,
      budgetReached: false,
      coverage: {
        state: "partial",
        reasons: [
          "stored_excerpts_only",
          "no_hit_not_absence",
          "canonical_source_verified_not_full_transcript",
          "context_not_snapshot_frozen",
          "product_view_omissions",
          "result_capped",
          "identical_excerpts_grouped",
        ],
        candidateBudget: SEARCH_CANDIDATE_BUDGET,
        candidatesExamined: 6,
        canonicalMatches: 4,
        returnedMatches: 2,
      },
    });

    const recent = await source.searchSessions({
      query: "eval", order: "recent", perSessionLimit: 3, groupIdenticalExcerpts: false, now: NOW,
    });
    expect(recent.results.map((hit) => hit.eventId)).toEqual(["4", "3", "2", "1"]);
    expect(recent.results.filter((hit) => hit.contentExcerpt === "repeat the eval")).toHaveLength(2);

    const diverse = await source.searchSessions({ query: "eval", perSessionLimit: 1, now: NOW });
    expect(diverse.results.map((hit) => hit.eventId)).toEqual(["4", "1"]);
    expect(diverse.coverage.reasons).not.toContain("result_capped");
  });

  it("groups copied excerpts before page limits and retains source locations with different full-message tails", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => eventRow(i + 1, {
      session_id: `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`,
      content_excerpt: "OCR experiment question",
      content_byte_size: 2000 + i,
      content_sha256: String(i).repeat(64),
    }));
    rows.push(eventRow(7, { content_excerpt: "OCR experiment results" }));
    const candidates = rows.map((row, i) => ({ event_id: row.event_id, score: 1 - i / 10 }));
    const { source, calls } = searchSource(candidates, rows);
    const grouped = await source.searchSessions({ query: "ocr", limit: 2, now: NOW });
    expect(grouped.results.map((hit) => hit.eventId)).toEqual(["1", "7"]);
    expect(grouped.results[0].excerptGroup).toMatchObject({
      kind: "identical_visible_excerpt", occurrences: 6, sessionCount: 6,
      alternativeSources: [
        { eventId: "2", sessionId: rows[1].session_id, fullContentBytes: 2001, contentSha256: "1".repeat(64), source: { sourceRecordId: "9002" } },
        { eventId: "3" }, { eventId: "4" }, { eventId: "5" }, { eventId: "6" },
      ],
      alternativesTruncated: false,
    });
    expect(grouped).toMatchObject({ matchCount: 7, matchedSessions: 7,
      coverage: { groupIdenticalExcerpts: true, excerptGroups: 2, groupedOccurrences: 5 } });
    expect(grouped.coverage.reasons).toContain("identical_excerpts_grouped");
    expect(calls).toHaveLength(2);
    const ungrouped = await source.searchSessions({ query: "ocr", limit: 10,
      groupIdenticalExcerpts: false, now: NOW });
    expect(ungrouped.results).toHaveLength(7);
    expect(ungrouped.results.every((hit) => hit.excerptGroup.occurrences === 1)).toBe(true);
    expect(ungrouped.coverage.groupedOccurrences).toBe(0);
  });

  it("keeps identical excerpts from different people, roles and origins separate", async () => {
    const rows = [
      eventRow(1, { content_excerpt: "same OCR text" }),
      eventRow(2, { content_excerpt: "same OCR text", person_id: OTHER_SESSION }),
      eventRow(3, { content_excerpt: "same OCR text", message_role: "assistant" }),
      eventRow(4, { content_excerpt: "same OCR text", message_origin: "worker" }),
    ];
    const { source } = searchSource(rows.map((r) => ({ event_id: r.event_id, score: 1 })), rows);
    const result = await source.searchSessions({ query: "ocr", perSessionLimit: 5, now: NOW });
    expect(result.results).toHaveLength(4);
    expect(result.coverage.groupedOccurrences).toBe(0);
  });

  it("does not merge redaction collisions and bounds alternative source output", async () => {
    const rows = [1, 2].map((id) => eventRow(id, {
      content_excerpt: `OCR token ghp_${String(id).repeat(30)}`,
    }));
    rows.push(...Array.from({ length: 9 }, (_, i) => eventRow(i + 3, {
      session_id: OTHER_SESSION, content_excerpt: "copied OCR evidence",
    })));
    const { source } = searchSource(rows.map((r) => ({ event_id: r.event_id, score: 1 })), rows);
    const result = await source.searchSessions({ query: "ocr", perSessionLimit: 5, now: NOW });
    expect(result.results.filter((hit) => hit.excerptRedacted)).toHaveLength(2);
    expect(result.results.find((hit) => !hit.excerptRedacted).excerptGroup).toMatchObject({
      occurrences: 9, sessionCount: 1, alternativesTruncated: true,
    });
    expect(result.results.find((hit) => !hit.excerptRedacted).excerptGroup.alternativeSources).toHaveLength(5);
    await expect(source.searchSessions({ query: "ocr", groupIdenticalExcerpts: "yes", now: NOW }))
      .rejects.toThrow("flame_mcp_query_request_invalid");
  });

  it("selects strongest representatives before display ordering and preserves raw session match counts", async () => {
    const rows = [eventRow(1, { content_excerpt: "OCR copy" }),
      eventRow(2, { content_excerpt: "OCR copy" }), eventRow(3)];
    const { source } = searchSource([
      { event_id: "1", score: 1 }, { event_id: "2", score: 0.5 }, { event_id: "3", score: 0.4 },
    ], rows);
    const relevant = await source.searchSessions({ query: "ocr", now: NOW });
    expect(relevant.results.map((hit) => hit.eventId)).toEqual(["1", "3"]);
    expect(relevant.results[0].sessionMatchCount).toBe(3);
    const recent = await source.searchSessions({ query: "ocr", order: "recent", now: NOW });
    expect(recent.results.map((hit) => hit.eventId)).toEqual(["3", "1"]);
    expect(recent.results[1].excerptGroup.alternativeSources[0].eventId).toBe("2");
  });

  it("preserves occurrence selection for distinct excerpts under either order and session cap", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => eventRow(i + 1, {
      session_id: i % 2 ? OTHER_SESSION : SESSION,
      content_excerpt: `distinct OCR evidence ${i}`,
    }));
    const { source } = searchSource(rows.map((r, i) => ({ event_id: r.event_id, score: 1 / (i + 1) })), rows);
    for (const order of ["recent", "relevance"]) {
      for (const perSessionLimit of [1, 2, 3, 5]) {
        const request = { query: "ocr", order, perSessionLimit, limit: 20, now: NOW };
        const grouped = await source.searchSessions(request);
        const individual = await source.searchSessions({ ...request, groupIdenticalExcerpts: false });
        expect(grouped.results.map(x => x.eventId)).toEqual(individual.results.map(x => x.eventId));
        expect(grouped.coverage.groupedOccurrences).toBe(0);
      }
    }
  });

  it("does not group a complete message with an identical truncated prefix or normalize near matches", async () => {
    const rows = [
      eventRow(1, { content_excerpt: "OCR text", content_byte_size: 8 }),
      eventRow(2, { content_excerpt: "OCR text", content_byte_size: 100 }),
      eventRow(3, { content_excerpt: "OCR text\n", content_byte_size: 9 }),
    ];
    const { source } = searchSource(rows.map((r) => ({ event_id: r.event_id, score: 1 })), rows);
    const result = await source.searchSessions({ query: "ocr", perSessionLimit: 5, now: NOW });
    expect(result.results).toHaveLength(3);
    expect(result.coverage.groupedOccurrences).toBe(0);
  });

  it("uses an alternate session when the strongest copy's session has filled its slots", async () => {
    const rows = [eventRow(1), eventRow(2),
      eventRow(3, { content_excerpt: "OCR copied evidence" }),
      eventRow(4, { content_excerpt: "OCR copied evidence", session_id: OTHER_SESSION })];
    const candidates = rows.map((r, i) => ({ event_id: r.event_id, score: 1 - i / 10 }));
    const { source } = searchSource(candidates, rows);
    const result = await source.searchSessions({ query: "ocr", now: NOW });
    expect(result.results.map((hit) => hit.eventId)).toEqual(["1", "2", "4"]);
    expect(result.results[2].excerptGroup.alternativeSources[0].eventId).toBe("3");
    const shuffled = searchSource([...candidates].reverse(), [...rows].reverse());
    expect(await shuffled.source.searchSessions({ query: "ocr", now: NOW })).toEqual(result);
  });

  it("does not let a weak copy displace stronger distinct evidence in an alternate session", async () => {
    const rows = [eventRow(1), eventRow(2, { content_excerpt: "OCR copy" }),
      eventRow(3, { content_excerpt: "OCR copy", session_id: OTHER_SESSION }),
      eventRow(4, { content_excerpt: "OCR distinct result", session_id: OTHER_SESSION })];
    const candidates = [
      { event_id: "1", score: 0.95 }, { event_id: "2", score: 0.9 },
      { event_id: "3", score: 0.3 }, { event_id: "4", score: 0.8 },
    ];
    const { source } = searchSource(candidates, rows);
    const result = await source.searchSessions({ query: "ocr", perSessionLimit: 1, now: NOW });
    expect(result.results.map((hit) => hit.eventId)).toEqual(["1", "4"]);
  });

  it("keeps canonical predicates and query-independent filters in the verification SQL", () => {
    expect(SEARCH_MATCHES_SQL).toContain(activeNormalizerPredicate("e", "s", "ib", "c"));
    expect(SEARCH_MATCHES_SQL).toContain(canonicalWinnerPredicate("e", "s"));
    expect(SEARCH_MATCHES_SQL).toContain("e.event_kind in ('message', 'agent_message')");
    expect(SEARCH_MATCHES_SQL).toContain("not e.is_replay");
    expect(SEARCH_MATCHES_SQL).toContain("e.id = any($2::bigint[])");
    expect(SEARCH_MATCHES_SQL).toContain("split_part(pe.email, '@', 3) = ''");
    expect(SEARCH_MATCHES_SQL).not.toMatch(/websearch_to_tsquery|message_search|usage/);
    expect(EVIDENCE_AFTER_SQL).toContain(canonicalWinnerPredicate("e", "s"));
    expect(EVIDENCE_AFTER_SQL).toContain(`limit ${EVIDENCE_SCAN_BUDGET}`);
    // Driver timestamptz binding rounds to milliseconds; keyset times stay text.
    expect(EVIDENCE_AFTER_SQL).toContain("($3::text::timestamptz, $4::bigint)");
    expect(EVIDENCE_BEFORE_SQL).toContain("($3::text::timestamptz, $4::bigint)");
  });

  it("caps examined candidates at the budget and flags overflow", async () => {
    const candidates = Array.from({ length: SEARCH_CANDIDATE_BUDGET + 1 }, (_, index) => ({
      event_id: String(index + 1), score: 0.1,
    }));
    const { source, calls } = searchSource(candidates, []);
    const result = await source.searchSessions({ query: "test", now: NOW });
    expect(calls[1].params[1]).toHaveLength(SEARCH_CANDIDATE_BUDGET);
    expect(calls[1].params[1].at(-1)).toBe(String(SEARCH_CANDIDATE_BUDGET));
    expect(result).toMatchObject({ budgetReached: true, matchCount: 0, results: [] });
    expect(result.coverage.reasons).toContain("candidate_budget_exceeded");
  });

  it("skips verification for no candidates and rejects unsafe helper rows", async () => {
    const empty = searchSource([], []);
    const result = await empty.source.searchSessions({ query: "zzqxv", now: NOW });
    expect(empty.calls).toHaveLength(1);
    expect(result.coverage).toMatchObject({ candidatesExamined: 0, canonicalMatches: 0 });

    for (const row of [
      { event_id: "9223372036854775808", score: 1 },
      { event_id: "0", score: 1 },
      { event_id: "1", score: "NaN" },
    ]) {
      const { source } = searchSource([row], []);
      await expect(source.searchSessions({ query: "test", now: NOW }))
        .rejects.toThrow("flame_database_result_invalid");
    }
  });

  it("maps helper errors to safe codes and never turns failures into empty results", async () => {
    const helper = searchSource(() => {
      throw Object.assign(new Error("excerpt_search_policy_unrecognized"), { code: "P0001" });
    }, []);
    await expect(helper.source.searchSessions({ query: "test", now: NOW }))
      .rejects.toMatchObject({ code: "flame_mcp_query_search_policy_unrecognized" });

    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    const timedOut = searchSource(() => { throw timeout; }, []);
    await expect(timedOut.source.searchSessions({ query: "test", now: NOW })).rejects.toBe(timeout);

    const aborted = searchSource([], []);
    const controller = new AbortController();
    controller.abort();
    await expect(aborted.source.searchSessions({
      query: "test", now: NOW, signal: controller.signal,
    })).rejects.toThrow("flame_request_aborted");
    expect(aborted.calls).toHaveLength(0);
  });
});

describe("readSessionEvidence", () => {
  function evidenceSource({ session = [SESSION_ROW], anchor = [], before = [], after = [] } = {}) {
    return fakeSource(new Map([
      [EVIDENCE_SESSION_SQL, () => session],
      [EVIDENCE_ANCHOR_SQL, () => anchor],
      [EVIDENCE_BEFORE_SQL, () => before],
      [EVIDENCE_AFTER_SQL, typeof after === "function" ? after : () => after],
    ]));
  }

  it("validates session, anchor, cursor exclusivity, and bigint event IDs", async () => {
    const { source, calls } = evidenceSource();
    for (const request of [
      { sessionId: "x" },
      { sessionId: SESSION, anchorEventId: "9223372036854775808" },
      { sessionId: SESSION, anchorEventId: "01" },
      { sessionId: SESSION, anchorEventId: "12345678901234567890" },
      { sessionId: SESSION, anchorEventId: 12 },
      { sessionId: SESSION, anchorEventId: "1", cursor: "e1.x" },
      { sessionId: SESSION, limit: 51 },
    ]) {
      await expect(source.readSessionEvidence(request)).rejects.toThrow(FlameSourceError);
    }
    expect(calls).toHaveLength(0);
  });

  it("returns the same not_found for unknown sessions and unmatched anchors", async () => {
    const missing = evidenceSource({ session: [] });
    await expect(missing.source.readSessionEvidence({ sessionId: SESSION }))
      .rejects.toThrow("flame_mcp_query_not_found");
    const substituted = evidenceSource({ anchor: [eventRow(8)] });
    await expect(substituted.source.readSessionEvidence({
      sessionId: SESSION, anchorEventId: "7",
    })).rejects.toThrow("flame_mcp_query_not_found");
  });

  it("builds a chronological anchor window around the exact stored anchor", async () => {
    const { source, calls } = evidenceSource({
      anchor: [{ ...eventRow(50), canonical_at_read: false }],
      before: [scannedRow(49), scannedRow(48, false), scannedRow(47), scannedRow(46)],
      after: [scannedRow(51), scannedRow(52, true, {
        content_excerpt: "<permissions instructions>x",
      }), scannedRow(53), scannedRow(54)],
    });
    const result = await source.readSessionEvidence({
      sessionId: SESSION, anchorEventId: "50", limit: 7, now: NOW,
    });
    expect(result.events.map((event) => [event.eventId, event.isAnchor, event.canonicalAtRead]))
      .toEqual([
        ["47", false, true], ["49", false, true], ["50", true, false],
        ["51", false, true], ["53", false, true], ["54", false, true],
      ]);
    expect(calls.find((call) => call.text === EVIDENCE_BEFORE_SQL).params).toEqual([
      WORKSPACE, SESSION, microsToIso(eventRow(50).occurred_at_us), "50",
      NOW.toISOString(), "e3group.ai",
    ]);
    expect(result).toMatchObject({
      anchorEventId: "50",
      hasEarlier: true,
      nextCursor: null,
      session: { childSessionsTruncated: true, provider: "codex" },
      coverage: {
        state: "partial",
        nonCanonicalSkipped: 1,
        runtimeContextOmitted: 1,
        untimedMessages: 2,
        scanBudgetReached: false,
      },
    });
    expect(result.session.childSessionIds).toHaveLength(20);
    expect(result.coverage.reasons).toEqual(expect.arrayContaining([
      "stored_excerpts_only", "untimed_messages_excluded", "anchor_not_canonical_at_read",
    ]));
  });

  it("pages forward with a bound microsecond cursor and reports scan budget exhaustion", async () => {
    let afterParams;
    const page = Array.from({ length: 3 }, (_, index) => scannedRow(index + 1));
    const { source } = evidenceSource({
      after: (params) => {
        afterParams = params;
        return page;
      },
    });
    const first = await source.readSessionEvidence({ sessionId: SESSION, limit: 2, now: NOW });
    expect(afterParams.slice(2, 4)).toEqual(["-infinity", "0"]);
    expect(first.events.map((event) => event.eventId)).toEqual(["1", "2"]);
    expect(first.hasEarlier).toBeNull();

    const later = new Date(NOW.getTime() + 60_000);
    await source.readSessionEvidence({
      sessionId: SESSION, cursor: first.nextCursor, limit: 2, now: later,
    });
    expect(afterParams.slice(2, 5)).toEqual([
      microsToIso(page[1].occurred_at_us), "2", NOW.toISOString(),
    ]);
    expect(microsToIso("1000001")).toBe("1970-01-01T00:00:01.000001Z");
    expect(microsToIso("-1")).toBe("1969-12-31T23:59:59.999999Z");

    await expect(source.readSessionEvidence({
      sessionId: OTHER_SESSION, cursor: first.nextCursor, now: later,
    })).rejects.toThrow("flame_mcp_query_cursor_invalid");
    await expect(source.readSessionEvidence({
      sessionId: SESSION, cursor: first.nextCursor, now: new Date(NOW.getTime() - 1),
    })).rejects.toThrow("flame_mcp_query_cursor_invalid");
    await expect(source.readSessionEvidence({
      sessionId: SESSION, cursor: `${first.nextCursor}x`, now: later,
    })).rejects.toThrow("flame_mcp_query_cursor_invalid");

    const skipped = Array.from({ length: EVIDENCE_SCAN_BUDGET }, (_, index) =>
      scannedRow(index + 1, index === 0));
    const budget = evidenceSource({ after: skipped });
    const exhausted = await budget.source.readSessionEvidence({ sessionId: SESSION, now: NOW });
    expect(exhausted.events).toHaveLength(1);
    expect(exhausted.coverage).toMatchObject({
      scanBudgetReached: true, nonCanonicalSkipped: EVIDENCE_SCAN_BUDGET - 1,
    });
    expect(exhausted.coverage.reasons).toContain("scan_budget_reached");
    const resume = decodeEvidenceCursor(exhausted.nextCursor, {
      sessionId: SESSION,
      fingerprint: JSON.parse(Buffer.from(exhausted.nextCursor.slice(3), "base64url").toString())[4],
      now: NOW,
    });
    expect(resume).toMatchObject({ id: String(EVIDENCE_SCAN_BUDGET) });
  });

  it("rejects cursors bound to another workspace target", () => {
    const cursor = encodeEvidenceCursor({
      sessionId: SESSION, atMicroseconds: "1", id: "1", readAt: NOW, fingerprint: "a",
    });
    expect(() => decodeEvidenceCursor(cursor, { sessionId: SESSION, fingerprint: "b", now: NOW }))
      .toThrow("flame_mcp_query_cursor_invalid");
    expect(decodeEvidenceCursor(cursor, { sessionId: SESSION, fingerprint: "a", now: NOW }))
      .toEqual({ atMicroseconds: "1", id: "1", readAt: NOW });
  });
});
