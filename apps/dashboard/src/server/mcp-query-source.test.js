import { describe, expect, it, vi } from "vitest";

import { FlameSourceError } from "./flame-source.js";
import {
  MCP_QUERY_HISTORY_START,
  buildUsageResult,
  createSherlockQuerySource,
  decodeSessionCursor,
  encodeSessionCursor,
  queryWindow,
} from "./mcp-query-source.js";

const NOW = new Date("2026-09-01T20:00:00.000Z");
const START = new Date(MCP_QUERY_HISTORY_START);
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("Sherlock MCP query source", () => {
  it("defaults to all history, accepts longer windows, and rejects invalid bounds", () => {
    expect(queryWindow({}, NOW)).toMatchObject({ startAt: START, endAt: NOW, readAt: NOW });
    expect(queryWindow({
      start: "2026-08-01T20:00:00.000Z",
      end: NOW.toISOString(),
    }, NOW)).toMatchObject({
      startAt: new Date("2026-08-01T20:00:00.000Z"),
      endAt: NOW,
      readAt: NOW,
    });
    expect(() => queryWindow({
      start: START.toISOString(),
      end: new Date(NOW.getTime() + 1).toISOString(),
    }, NOW)).toThrow(FlameSourceError);
    expect(() => queryWindow({
      start: NOW.toISOString(),
      end: START.toISOString(),
    }, NOW)).toThrow(FlameSourceError);
  });

  it("binds session cursors to the original filters and window", () => {
    const cursor = encodeSessionCursor({
      readAt: NOW,
      createdAt: START,
      sessionId: SESSION_ID,
      fingerprint: "bound-query",
    });
    expect(decodeSessionCursor(cursor, "bound-query")).toEqual({
      readAt: NOW,
      createdAt: START,
      sessionId: SESSION_ID,
    });
    expect(() => decodeSessionCursor(cursor, "different-query"))
      .toThrowError(new FlameSourceError("flame_mcp_query_cursor_invalid"));
  });

  it("keeps omitted session bounds pinned to the first page read time", async () => {
    const secondSessionId = "22222222-2222-4222-8222-222222222222";
    const row = (sessionId, createdAt) => ({
      session_id: sessionId,
      person_id: "33333333-3333-4333-8333-333333333333",
      display_name: "Ada",
      normalizer_version: "sherlock.codex-rollout.v2",
      actor_role: "primary",
      model: "gpt-5.6-sol",
      started_at: createdAt,
      ended_at: null,
      parent_session_id: null,
      created_at: createdAt,
    });
    const unsafe = vi.fn()
      .mockResolvedValueOnce([
        row(SESSION_ID, "2026-08-01T10:00:00.000Z"),
        row(secondSessionId, "2026-07-01T10:00:00.000Z"),
      ])
      .mockResolvedValueOnce([]);
    const source = {
      workspaceId: "44444444-4444-4444-8444-444444444444",
      expectedEmailDomain: "e3group.ai",
      maxPeople: 500,
      readiness: vi.fn(),
      transaction: vi.fn(async (callback) => await callback({ unsafe })),
    };
    const querySource = createSherlockQuerySource(source);

    const first = await querySource.fetchSessions({ limit: 1, now: NOW });
    const later = new Date(NOW.getTime() + 60_000);
    const second = await querySource.fetchSessions({
      limit: 1,
      cursor: first.nextCursor,
      now: later,
    });

    expect(first.window).toMatchObject({
      startInclusive: MCP_QUERY_HISTORY_START,
      endExclusive: NOW.toISOString(),
      readAt: NOW.toISOString(),
    });
    expect(second.window).toEqual(first.window);
    expect(unsafe.mock.calls[1][1].slice(1, 4)).toEqual([
      MCP_QUERY_HISTORY_START,
      NOW.toISOString(),
      NOW.toISOString(),
    ]);
  });

  it("rejects a cursor that claims a future server read time", async () => {
    const future = new Date(NOW.getTime() + 60_000);
    const cursor = encodeSessionCursor({
      readAt: future,
      createdAt: NOW,
      sessionId: SESSION_ID,
      fingerprint: "caller-forged",
    });
    const source = {
      workspaceId: "44444444-4444-4444-8444-444444444444",
      expectedEmailDomain: "e3group.ai",
      maxPeople: 500,
      readiness: vi.fn(),
      transaction: vi.fn(),
    };

    await expect(createSherlockQuerySource(source).fetchSessions({ cursor, now: NOW }))
      .rejects.toThrowError(new FlameSourceError("flame_mcp_query_cursor_invalid"));
    expect(source.transaction).not.toHaveBeenCalled();
  });

  it("continues a 24-hour cursor issued before the all-history default", async () => {
    const legacyStart = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const row = (sessionId, createdAt) => ({
      session_id: sessionId,
      person_id: "33333333-3333-4333-8333-333333333333",
      display_name: "Ada",
      normalizer_version: "sherlock.codex-rollout.v2",
      actor_role: "primary",
      model: "gpt-5.6-sol",
      started_at: createdAt,
      ended_at: null,
      parent_session_id: null,
      created_at: createdAt,
    });
    const unsafe = vi.fn()
      .mockResolvedValueOnce([
        row(SESSION_ID, "2026-09-01T10:00:00.000Z"),
        row("22222222-2222-4222-8222-222222222222", "2026-09-01T09:00:00.000Z"),
      ])
      .mockResolvedValueOnce([]);
    const source = {
      workspaceId: "44444444-4444-4444-8444-444444444444",
      expectedEmailDomain: "e3group.ai",
      maxPeople: 500,
      readiness: vi.fn(),
      transaction: vi.fn(async (callback) => await callback({ unsafe })),
    };
    const querySource = createSherlockQuerySource(source);
    const first = await querySource.fetchSessions({
      start: legacyStart.toISOString(),
      end: NOW.toISOString(),
      limit: 1,
      now: NOW,
    });

    const second = await querySource.fetchSessions({
      cursor: first.nextCursor,
      limit: 1,
      now: new Date(NOW.getTime() + 60_000),
    });

    expect(second.window).toEqual(first.window);
    expect(second.window.startInclusive).toBe(legacyStart.toISOString());
  });

  it("keeps coverage partial when cumulative baselines or normalization are missing", () => {
    const result = buildUsageResult([{
      person_id: SESSION_ID,
      display_name: "Ada",
      provider: "codex",
      model: "gpt-5.6-sol",
      input_tokens: 40,
      cached_input_tokens: 0,
      output_tokens: 30,
      reasoning_tokens: 5,
      total_tokens: 75,
      session_count: 1,
      usage_event_count: 3,
      session_ids: [SESSION_ID],
      stream_ids: [`${SESSION_ID}:sherlock.codex-rollout.v2:main`],
      missing_baseline_count: 1,
      regression_count: 0,
      missing_token_components: [],
    }], {
      pending_normalize_count: 2,
      raw_watermark: NOW,
      canonical_watermark: START,
    }, {
      groupBy: "person_model",
      startAt: START,
      endAt: NOW,
      readAt: NOW,
    });

    expect(result.groups).toEqual([{
      personId: SESSION_ID,
      displayName: "Ada",
      provider: "codex",
      model: "gpt-5.6-sol",
      tokens: { input: 40, cachedInput: 0, output: 30, reasoning: 5, total: 75 },
      sessionCount: 1,
      usageEventCount: 3,
    }]);
    expect(result.coverage).toMatchObject({
      state: "partial",
      pendingNormalizationJobs: 2,
      missingCumulativeBaselines: 1,
      regressedCumulativeStreams: 0,
      missingTokenComponents: [],
      reasons: [
        "collector_presence_not_proven",
        "normalization_failures_not_assessed",
        "normalization_pending",
        "cumulative_baseline_missing",
      ],
    });
  });

  it("returns a missing token component as null instead of observed zero", () => {
    const result = buildUsageResult([{
      person_id: SESSION_ID,
      display_name: "Ada",
      provider: "codex",
      model: "gpt-5.6-sol",
      input_tokens: 40,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 5,
      total_tokens: 45,
      usage_event_count: 1,
      session_ids: [SESSION_ID],
      stream_ids: [`${SESSION_ID}:main:true`],
      missing_baseline_count: 0,
      regression_count: 0,
      missing_token_components: ["output"],
    }], {
      pending_normalize_count: 0,
      raw_watermark: NOW,
      canonical_watermark: NOW,
    }, {
      groupBy: "person_model",
      startAt: START,
      endAt: NOW,
      readAt: NOW,
    });

    expect(result.groups[0].tokens).toEqual({
      input: 40,
      cachedInput: 0,
      output: null,
      reasoning: 5,
      total: 45,
    });
    expect(result.coverage).toMatchObject({
      state: "partial",
      missingTokenComponents: ["output"],
    });
  });

  it("does not return foreign-workspace session metadata", async () => {
    const unsafe = vi.fn().mockResolvedValue([]);
    const source = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      expectedEmailDomain: "e3group.ai",
      maxPeople: 500,
      readiness: vi.fn(),
      transaction: vi.fn(async (callback) => await callback({ unsafe })),
    };
    const querySource = createSherlockQuerySource(source);

    await expect(querySource.fetchSession({ sessionId: SESSION_ID }))
      .rejects.toThrowError(new FlameSourceError("flame_mcp_query_not_found"));
    expect(unsafe.mock.calls[0][1][0]).toBe(source.workspaceId);
  });

  it("never calls the lightweight coverage receipt exact before usage arithmetic", async () => {
    const unsafe = vi.fn(async (sql) => sql.includes("read_dashboard_freshness")
      ? [{
          pending_normalize_count: 0,
          raw_watermark: NOW,
          canonical_watermark: NOW,
        }]
      : [{ observed_sessions: 2, observed_usage_events: 4 }]);
    const source = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      expectedEmailDomain: "e3group.ai",
      maxPeople: 500,
      readiness: vi.fn(),
      transaction: vi.fn(async (callback) => await callback({ unsafe })),
    };

    const result = await createSherlockQuerySource(source).fetchCoverage({ now: NOW });

    expect(result).toMatchObject({
      state: "partial",
      reasons: [
        "collector_presence_not_proven",
        "normalization_failures_not_assessed",
        "usage_arithmetic_not_assessed",
      ],
      observedSessions: 2,
      observedUsageEvents: 4,
    });
    expect(unsafe.mock.calls.at(-1)[1][1]).toBe(MCP_QUERY_HISTORY_START);
  });

  it("passes the all-history default through to usage SQL", async () => {
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{ person_count: 0 }])
      .mockResolvedValueOnce([{
        pending_normalize_count: 0,
        raw_watermark: null,
        canonical_watermark: null,
      }])
      .mockResolvedValueOnce([]);
    const source = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      expectedEmailDomain: "e3group.ai",
      maxPeople: 500,
      readiness: vi.fn(),
      transaction: vi.fn(async (callback) => await callback({ unsafe })),
    };

    const result = await createSherlockQuerySource(source).fetchUsage({ now: NOW });

    expect(result.window).toMatchObject({
      startInclusive: MCP_QUERY_HISTORY_START,
      endExclusive: NOW.toISOString(),
    });
    expect(unsafe.mock.calls[2][1].slice(1, 3)).toEqual([
      MCP_QUERY_HISTORY_START,
      NOW.toISOString(),
    ]);
  });

  it("fails closed when the configured roster exceeds the query safety bound", async () => {
    const unsafe = vi.fn().mockResolvedValue([{ person_count: 2 }]);
    const source = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      expectedEmailDomain: "e3group.ai",
      maxPeople: 1,
      readiness: vi.fn(),
      transaction: vi.fn(async (callback) => await callback({ unsafe })),
    };

    await expect(createSherlockQuerySource(source).fetchUsage({ now: NOW }))
      .rejects.toThrowError(new FlameSourceError("flame_mcp_query_roster_too_large"));
    expect(unsafe).toHaveBeenCalledTimes(1);
  });

  it("fails closed before regrouping a truncated 201-row usage result", () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({
      person_id: SESSION_ID,
      display_name: "Ada",
      provider: "codex",
      model: `model-${String(index).padStart(3, "0")}`,
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 1,
      usage_event_count: 1,
      session_ids: [SESSION_ID],
      stream_ids: [`${SESSION_ID}:stream-${index}:true`],
      missing_baseline_count: 0,
      regression_count: 0,
      missing_token_components: [],
    }));

    expect(() => buildUsageResult(rows, {}, {
      groupBy: "person",
      startAt: START,
      endAt: NOW,
      readAt: NOW,
    })).toThrowError(new FlameSourceError("flame_mcp_query_result_too_large"));
  });
});
