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

  it("preserves the cached snapshot and advances after a missing key", () => {
    const day = payload([person(1), person(3)], "v1.cached-snapshot");

    const page = pageCachedUsageEvidence(day, encodeUsageCursor(person(2).id));

    expect(page.snapshot).toBe("v1.cached-snapshot");
    expect(page.read).toBe(day.read);
    expect(page.people).toEqual([person(3)]);
  });

  it("returns a successful empty page after the final cached person", () => {
    const day = payload([person(1)]);

    const page = pageCachedUsageEvidence(day, encodeUsageCursor(person(2).id));

    expect(page.people).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.snapshot).toBe(day.snapshot);
  });

  it("rejects malformed cursors and duplicate cached people", () => {
    expect(decodeUsageCursor(encodeUsageCursor(person(1).id))).toBe(person(1).id);
    expect(() => decodeUsageCursor("u1.not+base64")).toThrow(FlameSourceError);
    expect(() => pageCachedUsageEvidence(payload([person(1), person(1)])))
      .toThrow(FlameSourceError);
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
