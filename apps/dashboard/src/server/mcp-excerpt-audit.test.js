import { describe, expect, it, vi } from "vitest";

import {
  LIST_EXCERPT_READS_SQL,
  RECORD_EXCERPT_READS_SQL,
  SUMMARIZE_EXCERPT_READS_SQL,
  createExcerptAuditStore,
  createExcerptAuditWriter,
} from "./mcp-excerpt-audit.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const OWNER = "33333333-3333-4333-8333-333333333333";
const SESSION = "11111111-1111-4111-8111-111111111111";

function fakeSource(handler) {
  const calls = [];
  return {
    calls,
    workspaceId: WORKSPACE,
    async transaction(callback, options) {
      return await callback({
        unsafe(text, params) {
          calls.push({ text, params, options });
          const result = Promise.resolve().then(() => handler(text, params));
          result.cancel = () => {};
          return result;
        },
      });
    },
  };
}

describe("excerpt audit store", () => {
  it("writes rows through the audit function in a read-write transaction", async () => {
    const source = fakeSource(() => [{ written: 2 }]);
    const store = createExcerptAuditStore(source);
    expect(await store.write([{ tool: "search_sessions" }, { tool: "search_sessions" }])).toBe(2);
    expect(source.calls[0]).toMatchObject({
      text: RECORD_EXCERPT_READS_SQL,
      params: [WORKSPACE, JSON.stringify([{ tool: "search_sessions" }, { tool: "search_sessions" }])],
      options: { readOnly: false },
    });
  });

  it("summarizes reads by caller and owner over a default 24-hour window", async () => {
    const source = fakeSource(() => [{
      caller: "ada", owner_person_id: OWNER, reads: "7", sessions: "3", rate_limited: "1",
      first_read_at: "2026-11-04T10:00:00.000Z", last_read_at: "2026-11-04T11:00:00.000Z",
    }]);
    const store = createExcerptAuditStore(source);
    const result = await store.list({ now: "2026-11-05T00:00:00.000Z", caller: "ada" });
    expect(source.calls[0].text).toBe(SUMMARIZE_EXCERPT_READS_SQL);
    expect(source.calls[0].options.readOnly).toBeUndefined();
    expect(source.calls[0].params).toEqual([
      WORKSPACE, "2026-11-04T00:00:00.000Z", "2026-11-05T00:00:00.000Z", "ada", null, null, 51,
    ]);
    expect(result).toEqual({
      view: "summary",
      window: { startInclusive: "2026-11-04T00:00:00.000Z", endExclusive: "2026-11-05T00:00:00.000Z" },
      truncated: false,
      groups: [{
        caller: "ada", ownerPersonId: OWNER, reads: 7, distinctSessions: 3, rateLimited: 1,
        firstReadAt: "2026-11-04T10:00:00.000Z", lastReadAt: "2026-11-04T11:00:00.000Z",
      }],
    });
  });

  it("lists individual reads and reports truncation", async () => {
    const row = {
      read_at: "2026-11-04T10:00:00.000Z", caller: null, caller_tier: null, tool: "get_session_evidence",
      outcome: "ok", session_id: SESSION, owner_person_id: OWNER, request_id: null,
    };
    const source = fakeSource(() => [row, row]);
    const store = createExcerptAuditStore(source);
    const result = await store.list({ view: "reads", limit: 1, now: "2026-11-05T00:00:00.000Z" });
    expect(source.calls[0].text).toBe(LIST_EXCERPT_READS_SQL);
    expect(result.truncated).toBe(true);
    expect(result.reads).toEqual([{
      readAt: "2026-11-04T10:00:00.000Z", caller: null, callerTier: null, tool: "get_session_evidence",
      outcome: "ok", sessionId: SESSION, ownerPersonId: OWNER, requestId: null,
    }]);
  });

  it("rejects inverted, future and over-31-day windows", async () => {
    const store = createExcerptAuditStore(fakeSource(() => []));
    const now = "2026-11-05T00:00:00.000Z";
    await expect(store.list({ now, start: "2026-11-04T00:00:00Z", end: "2026-11-03T00:00:00Z" }))
      .rejects.toMatchObject({ code: "flame_mcp_query_request_invalid" });
    await expect(store.list({ now, end: "2026-11-06T00:00:00Z" }))
      .rejects.toMatchObject({ code: "flame_mcp_query_request_invalid" });
    await expect(store.list({ now, start: "2026-10-01T00:00:00Z" }))
      .rejects.toMatchObject({ code: "flame_mcp_audit_window_too_large" });
  });
});

describe("excerpt audit writer", () => {
  it("batches rows, retries a failed batch and flushes on close", async () => {
    vi.useFakeTimers();
    try {
      const written = [];
      let fail = true;
      const events = [];
      const store = {
        write: vi.fn(async (rows) => {
          if (fail) throw Object.assign(new Error("down"), { code: "flame_database_unavailable" });
          written.push(...rows);
          return rows.length;
        }),
      };
      const writer = createExcerptAuditWriter({ store, flushMs: 100, maxBatch: 2, log: (event) => events.push(event) });
      writer.push([{ id: 1 }]);
      expect(store.write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(store.write).toHaveBeenCalledTimes(1);
      expect(events).toEqual([{ event: "sherlock_excerpt_audit_write_failed", rows: 1, code: "flame_database_unavailable" }]);
      // While failing, a full batch waits for the retry timer.
      writer.push([{ id: 2 }]);
      expect(store.write).toHaveBeenCalledTimes(1);
      fail = false;
      await vi.advanceTimersByTimeAsync(100);
      expect(written).toEqual([{ id: 1 }, { id: 2 }]);
      writer.push([{ id: 3 }]);
      await writer.close();
      expect(written).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(writer.pending()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never drops rows that are being written", async () => {
    const written = [];
    let release;
    const store = {
      write: (rows) => new Promise((resolve) => {
        release = () => { written.push(...rows); resolve(rows.length); };
      }),
    };
    const writer = createExcerptAuditWriter({ store, flushMs: 60_000, maxBatch: 2, maxBuffered: 3, log: () => {} });
    writer.push([{ id: 1 }, { id: 2 }]);
    // Overflow while ids 1 and 2 are in flight drops id 3, the oldest queued row.
    writer.push([{ id: 3 }, { id: 4 }]);
    release();
    await Promise.resolve();
    await Promise.resolve();
    release();
    await writer.close();
    expect(written.map((row) => row.id)).toEqual([1, 2, 4]);
  });

  it("drops the oldest rows past its buffer bound and says so", async () => {
    const events = [];
    const writer = createExcerptAuditWriter({
      store: { write: async () => { throw new Error("down"); } },
      flushMs: 60_000, maxBatch: 100, maxBuffered: 3, log: (event) => events.push(event),
    });
    writer.push([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
    expect(writer.pending()).toBe(3);
    expect(events).toEqual([{ event: "sherlock_excerpt_audit_dropped", rows: 2 }]);
    await writer.close();
  });
});
