import { describe, expect, it, vi } from "vitest";

import {
  FRESHNESS_MAX_SERVE_AGE_MS,
  FRESHNESS_REFRESH_MS,
  FRESHNESS_RETRY_MS,
  FreshnessCache,
} from "./freshness-cache.js";

function payload(read, overrides = {}) {
  return {
    read: new Date(read).toISOString(),
    pendingNormalize: 0,
    delayed: false,
    people: [],
    ...overrides,
  };
}

describe("FreshnessCache", () => {
  it("singleflights a cold read and serves the cached aggregate", async () => {
    let resolve;
    const load = vi.fn(() => new Promise((done) => { resolve = done; }));
    const cache = new FreshnessCache({ load, now: () => 1_000, setTimer: vi.fn() });
    const first = cache.read();
    const second = cache.read();
    await Promise.resolve();
    resolve(payload(900));
    await expect(first).resolves.toMatchObject({ state: "hit" });
    await expect(second).resolves.toMatchObject({ state: "hit" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps last-good data when a waited refresh fails", async () => {
    let now = 1_000;
    const load = vi.fn()
      .mockResolvedValueOnce(payload(900))
      .mockRejectedValueOnce(new Error("offline"));
    const cache = new FreshnessCache({ load, now: () => now, setTimer: vi.fn() });
    await cache.read();
    now += FRESHNESS_REFRESH_MS;
    await expect(cache.read({ waitForRefresh: true })).resolves.toMatchObject({
      state: "stale",
      payload: { read: new Date(900).toISOString() },
    });
  });

  it("enforces a hard retry cooldown across request-driven refreshes", async () => {
    let now = 1_000;
    const load = vi.fn()
      .mockResolvedValueOnce(payload(900))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(payload(FRESHNESS_REFRESH_MS + 1_000));
    const cache = new FreshnessCache({ load, now: () => now, setTimer: vi.fn() });
    await cache.read();
    now += FRESHNESS_REFRESH_MS;
    await cache.read({ waitForRefresh: true });

    await cache.read({ waitForRefresh: true });
    now += FRESHNESS_RETRY_MS - 1;
    await cache.read({ waitForRefresh: true });
    expect(load).toHaveBeenCalledTimes(2);

    now += 1;
    await cache.read({ waitForRefresh: true });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("prevents cold callers from hammering load during the retry cooldown", async () => {
    let now = 1_000;
    const load = vi.fn().mockRejectedValue(new Error("offline"));
    const cache = new FreshnessCache({ load, now: () => now, setTimer: vi.fn() });

    await expect(cache.read()).rejects.toThrow("offline");
    await expect(cache.read()).rejects.toThrow("flame_database_unavailable");
    now += FRESHNESS_RETRY_MS - 1;
    await expect(cache.read()).rejects.toThrow("flame_database_unavailable");
    expect(load).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(cache.read()).rejects.toThrow("offline");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not serve a last-good receipt past the bounded age", async () => {
    let now = 1_000;
    const load = vi.fn()
      .mockResolvedValueOnce(payload(900))
      .mockRejectedValueOnce(new Error("offline"));
    const cache = new FreshnessCache({ load, now: () => now, setTimer: vi.fn() });
    await cache.read();
    now += FRESHNESS_MAX_SERVE_AGE_MS;
    await expect(cache.read()).rejects.toThrow("offline");
  });
});
