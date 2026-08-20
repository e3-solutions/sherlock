import { describe, expect, it, vi } from "vitest";

import {
  createFrameEvidenceCache,
  frameEvidenceCacheKey,
} from "./frame-evidence-cache.js";

describe("frame evidence cache", () => {
  it("keys entries by the exact snapshot, person, and frame start identity", () => {
    expect(frameEvidenceCacheKey("snapshot:a", "person:b", 1))
      .not.toBe(frameEvidenceCacheKey("snapshot", "a:person:b", 1));
  });

  it("evicts the least recently used frame at the entry bound", () => {
    const cache = createFrameEvidenceCache({ maxEntries: 3, measure: () => 1 });
    cache.set("a", { id: "a" });
    cache.set("b", { id: "b" });
    cache.set("c", { id: "c" });
    expect(cache.get("a")).toEqual({ id: "a" });

    cache.set("d", { id: "d" });

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual({ id: "a" });
    expect(cache.size).toBe(3);
  });

  it("uses byte-weighted eviction and rejects oversized entries", () => {
    const measure = vi.fn((value) => value.bytes);
    const cache = createFrameEvidenceCache({
      maxEntries: 3,
      maxBytes: 10,
      maxEntryBytes: 6,
      measure,
    });
    cache.set("a", { bytes: 4 });
    cache.set("b", { bytes: 4 });
    cache.get("a");

    expect(cache.set("c", { bytes: 5 })).toBe(true);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.bytes).toBe(9);
    expect(cache.set("oversized", { bytes: 7 })).toBe(false);
    expect(cache.get("oversized")).toBeUndefined();
    expect(cache.bytes).toBe(9);
  });

  it("clears all values and byte accounting synchronously", () => {
    const cache = createFrameEvidenceCache({ measure: () => 4 });
    cache.set("a", { id: "a" });
    cache.clear();

    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});
