import { describe, expect, it, vi } from "vitest";

import { FlameSourceError } from "./flame-source.js";
import {
  MCP_USAGE_PAGE_LIMIT,
  createCachedMcpSource,
  decodeUsageCursor,
  encodeUsageCursor,
  pageCachedUsageEvidence,
} from "./mcp-source.js";

function person(index) {
  return { id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` };
}

function payload(people, snapshot = "v1.snapshot") {
  return {
    start: "2026-08-18T03:30:00.000Z",
    read: "2026-08-19T03:30:08.000Z",
    snapshot,
    people,
  };
}

describe("cached MCP usage evidence", () => {
  it("keyset-pages shuffled cached people without overlap", () => {
    const people = Array.from({ length: 23 }, (_, index) => person(index + 1)).reverse();

    const first = pageCachedUsageEvidence(payload(people));
    const second = pageCachedUsageEvidence(payload(people), first.nextCursor);

    expect(first.people).toHaveLength(MCP_USAGE_PAGE_LIMIT);
    expect(first.people.map(({ id }) => id)).toEqual(
      Array.from({ length: 20 }, (_, index) => person(index + 1).id),
    );
    expect(second.people.map(({ id }) => id)).toEqual([
      person(21).id,
      person(22).id,
      person(23).id,
    ]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.people, ...second.people].map(({ id }) => id)).size).toBe(23);
  });

  it("exhausts 1,000 reverse-ordered people over 50 stable snapshot pages", () => {
    const expectedIds = Array.from({ length: 1_000 }, (_, index) => person(index + 1).id);
    const day = payload(
      Array.from({ length: 1_000 }, (_, index) => person(index + 1)).reverse(),
      "v1.thousand-person-snapshot",
    );
    const seen = new Set();
    const traversedIds = [];
    let cursor = "";
    let pageCount = 0;

    do {
      const page = pageCachedUsageEvidence(day, cursor);
      pageCount += 1;
      expect(page.snapshot).toBe(day.snapshot);
      expect(page.start).toBe(day.start);
      expect(page.read).toBe(day.read);
      expect(page.people).toHaveLength(MCP_USAGE_PAGE_LIMIT);
      for (const currentPerson of page.people) {
        expect(seen.has(currentPerson.id)).toBe(false);
        seen.add(currentPerson.id);
        traversedIds.push(currentPerson.id);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(pageCount).toBe(50);
    expect(seen.size).toBe(1_000);
    expect(traversedIds).toEqual(expectedIds);
  });

  it("preserves the cached snapshot and advances after a missing key", () => {
    const day = payload([person(1), person(3)], "v1.cached-snapshot");

    const page = pageCachedUsageEvidence(
      day,
      encodeUsageCursor(day.snapshot, person(2).id),
    );

    expect(page.snapshot).toBe("v1.cached-snapshot");
    expect(page.read).toBe(day.read);
    expect(page.people).toEqual([person(3)]);
  });

  it("returns a successful empty page after the final cached person", () => {
    const day = payload([person(1)]);

    const page = pageCachedUsageEvidence(
      day,
      encodeUsageCursor(day.snapshot, person(2).id),
    );

    expect(page.people).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.snapshot).toBe(day.snapshot);
  });

  it("rejects malformed cursors and duplicate cached people", () => {
    expect(decodeUsageCursor(encodeUsageCursor("v1.snapshot", person(1).id))).toEqual({
      snapshotSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      afterPersonId: person(1).id,
    });
    expect(() => decodeUsageCursor("u1.not+base64")).toThrow(FlameSourceError);
    expect(() => pageCachedUsageEvidence(payload([person(1), person(1)])))
      .toThrow(FlameSourceError);
  });

  it("expires a traversal when the cached snapshot refreshes", () => {
    const first = pageCachedUsageEvidence(payload(
      Array.from({ length: 21 }, (_, index) => person(index + 1)),
      "v1.first",
    ));

    expect(() => pageCachedUsageEvidence(
      payload([person(21)], "v1.second"),
      first.nextCursor,
    )).toThrowError(new FlameSourceError("flame_usage_snapshot_expired"));
  });

  it("reads usage only from the timeline cache and delegates prompt evidence", async () => {
    const signal = new AbortController().signal;
    const day = payload([person(1)]);
    const cache = { read: vi.fn().mockResolvedValue({ payload: day, state: "hit" }) };
    const prompt = { prompts: [] };
    const source = {
      fetchUsageEvidence: vi.fn(),
      fetchPromptEvidence: vi.fn().mockResolvedValue(prompt),
    };
    const mcpSource = createCachedMcpSource({ cache, source });

    await expect(mcpSource.fetchUsageEvidence({ signal })).resolves.toMatchObject({
      snapshot: day.snapshot,
      people: [person(1)],
    });
    await expect(mcpSource.fetchPromptEvidence({ personId: person(1).id }))
      .resolves.toBe(prompt);
    expect(cache.read).toHaveBeenCalledWith({ signal });
    expect(source.fetchUsageEvidence).not.toHaveBeenCalled();
    expect(source.fetchPromptEvidence).toHaveBeenCalledWith({ personId: person(1).id });
  });

  it("uses a newly refreshed cache snapshot on the next usage call", async () => {
    const cache = {
      read: vi.fn()
        .mockResolvedValueOnce({ payload: payload([person(1)], "v1.first"), state: "hit" })
        .mockResolvedValueOnce({ payload: payload([person(1)], "v1.second"), state: "hit" }),
    };
    const mcpSource = createCachedMcpSource({
      cache,
      source: { fetchPromptEvidence: vi.fn() },
    });

    expect((await mcpSource.fetchUsageEvidence()).snapshot).toBe("v1.first");
    expect((await mcpSource.fetchUsageEvidence()).snapshot).toBe("v1.second");
  });
});
