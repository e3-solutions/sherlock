import { describe, expect, it, vi } from "vitest";

import {
  FlameDayCache,
  expectedTimelineEnd,
  nextTimelineRefreshDelay,
} from "./flame-cache.js";
import { FlameSourceError } from "./flame-source.js";

function payload(read = "2026-08-19T12:00:30.000Z") {
  return {
    start: "2026-08-18T12:00:00.000Z",
    read,
    snapshot: "v1.receipt",
    people: [{ id: "person" }],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("FlameDayCache", () => {
  it("coalesces cold callers and lets one caller abort without cancelling the refresh", async () => {
    const pending = deferred();
    const load = vi.fn(() => pending.promise);
    const cache = new FlameDayCache({
      load,
      now: () => Date.parse("2026-08-19T12:00:30.000Z"),
    });
    const controller = new AbortController();
    const aborted = cache.read({ signal: controller.signal });
    const callers = Array.from({ length: 19 }, () => cache.read());

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "flame_request_aborted" });
    pending.resolve(payload());

    await expect(Promise.all(callers)).resolves.toHaveLength(19);
    expect(load).toHaveBeenCalledTimes(1);
    expect((await cache.read()).state).toBe("hit");
    await cache.close();
  });

  it("atomically retains the last good payload when a stale refresh fails", async () => {
    let now = Date.parse("2026-08-19T12:00:30.000Z");
    const load = vi.fn()
      .mockResolvedValueOnce(payload())
      .mockRejectedValueOnce(new Error("database unavailable"));
    const cache = new FlameDayCache({ load, now: () => now });

    const first = await cache.read();
    now = Date.parse("2026-08-19T12:11:31.000Z");
    const stale = await cache.read({ waitForRefresh: true });

    expect(first.payload).toBe(stale.payload);
    expect(stale.state).toBe("stale");
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.readiness()).toEqual({ status: "ok", mode: "sherlock_cached_aggregate" });
    await cache.close();
  });

  it("keeps stale requests on the failure backoff instead of rerunning the aggregate", async () => {
    let now = Date.parse("2026-08-19T12:00:30.000Z");
    const good = payload();
    const load = vi.fn()
      .mockResolvedValueOnce(good)
      .mockRejectedValueOnce(new Error("database unavailable"));
    const cache = new FlameDayCache({ load, now: () => now });

    await cache.read();
    now = Date.parse("2026-08-19T12:11:31.000Z");
    await expect(cache.read({ waitForRefresh: true })).resolves.toMatchObject({
      payload: good,
      state: "stale",
    });
    await expect(cache.read()).resolves.toMatchObject({ payload: good, state: "stale" });
    await expect(cache.read({ waitForRefresh: true })).resolves.toMatchObject({
      payload: good,
      state: "stale",
    });

    expect(load).toHaveBeenCalledTimes(2);
    await cache.close();
  });

  it("rejects cold requests during failure backoff without rerunning the aggregate", async () => {
    let now = Date.parse("2026-08-19T12:00:30.000Z");
    const load = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const cache = new FlameDayCache({ load, now: () => now });

    await expect(cache.read()).rejects.toThrow("database unavailable");
    await expect(cache.read()).rejects.toMatchObject({ code: "flame_database_unavailable" });
    await expect(cache.read()).rejects.toMatchObject({ code: "flame_database_unavailable" });
    expect(load).toHaveBeenCalledTimes(1);

    now += 60_000;
    await expect(cache.read()).rejects.toThrow("database unavailable");
    expect(load).toHaveBeenCalledTimes(2);
    await cache.close();
  });

  it("returns a stale hit without waiting for the detached refresh", async () => {
    let now = Date.parse("2026-08-19T12:00:30.000Z");
    const pending = deferred();
    const load = vi.fn().mockResolvedValueOnce(payload()).mockReturnValueOnce(pending.promise);
    const cache = new FlameDayCache({ load, now: () => now });

    await cache.read();
    now = Date.parse("2026-08-19T12:11:31.000Z");
    await expect(cache.read()).resolves.toMatchObject({ state: "stale" });
    expect(load).toHaveBeenCalledTimes(2);

    pending.resolve({
      ...payload("2026-08-19T12:11:31.000Z"),
      start: "2026-08-18T12:10:00.000Z",
    });
    await cache.refresh("test_waiter");
    await cache.close();
  });

  it("waits for a stale refresh and publishes its complete replacement", async () => {
    let now = Date.parse("2026-08-19T12:00:30.000Z");
    const replacement = {
      ...payload("2026-08-19T12:11:31.000Z"),
      start: "2026-08-18T12:10:00.000Z",
    };
    const load = vi.fn().mockResolvedValueOnce(payload()).mockResolvedValueOnce(replacement);
    const cache = new FlameDayCache({ load, now: () => now });

    await cache.read();
    now = Date.parse("2026-08-19T12:11:31.000Z");
    const refreshed = await cache.read({ waitForRefresh: true });

    expect(refreshed).toEqual({ payload: replacement, state: "hit" });
    await cache.close();
  });

  it("does not publish an invalid replacement", async () => {
    let now = Date.parse("2026-08-19T12:00:30.000Z");
    const good = payload();
    const load = vi.fn().mockResolvedValueOnce(good).mockResolvedValueOnce({ people: [] });
    const cache = new FlameDayCache({ load, now: () => now });

    await cache.read();
    now = Date.parse("2026-08-19T12:11:31.000Z");
    const result = await cache.read({ waitForRefresh: true });

    expect(result.payload).toBe(good);
    expect(result.state).toBe("stale");
    await cache.close();
  });

  it("forces one shared refresh for manual detail recovery even while current", async () => {
    const load = vi.fn().mockResolvedValue(payload());
    const cache = new FlameDayCache({
      load,
      now: () => Date.parse("2026-08-19T12:00:30.000Z"),
    });

    await cache.read();
    await Promise.all([
      cache.read({ forceRefresh: true }),
      cache.read({ forceRefresh: true }),
    ]);

    expect(load).toHaveBeenCalledTimes(2);
    await cache.close();
  });

  it("propagates a forced recovery failure without replacing the last good payload", async () => {
    const good = payload();
    const load = vi.fn()
      .mockResolvedValueOnce(good)
      .mockRejectedValueOnce(new Error("database unavailable"));
    const cache = new FlameDayCache({
      load,
      now: () => Date.parse("2026-08-19T12:00:30.000Z"),
    });

    await cache.read();
    await expect(cache.read({ forceRefresh: true })).rejects.toThrow("database unavailable");
    expect((await cache.read()).payload).toBe(good);
    await cache.close();
  });

  it("throttles sequential public force requests while retaining ordinary cache hits", async () => {
    const load = vi.fn().mockResolvedValue(payload());
    const cache = new FlameDayCache({
      load,
      now: () => Date.parse("2026-08-19T12:00:30.000Z"),
    });

    await cache.read();
    await cache.read({ forceRefresh: true });
    await expect(cache.read({ forceRefresh: true })).rejects.toMatchObject({
      code: "flame_refresh_throttled",
    });
    await expect(cache.read()).resolves.toMatchObject({ state: "hit" });
    expect(load).toHaveBeenCalledTimes(2);
    await cache.close();
  });

  it("stops serving and reporting healthy before detail snapshots expire", async () => {
    let now = Date.parse("2026-08-19T12:00:30.000Z");
    const load = vi.fn()
      .mockResolvedValueOnce(payload())
      .mockRejectedValueOnce(new Error("database unavailable"));
    const cache = new FlameDayCache({ load, now: () => now });

    await cache.read();
    now += 24 * 60 * 60 * 1000;

    expect(cache.readiness()).toEqual({ status: "unavailable", reason: "timeline_expired" });
    await expect(cache.read()).rejects.toThrow("database unavailable");
    await cache.close();
  });

  it("aborts cache-owned database work during shutdown", async () => {
    let refreshSignal;
    const load = vi.fn(({ signal }) => new Promise((_resolve, reject) => {
      refreshSignal = signal;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const cache = new FlameDayCache({ load });

    cache.start();
    await Promise.resolve();
    expect(refreshSignal.aborted).toBe(false);
    await cache.close();

    expect(refreshSignal.aborted).toBe(true);
  });

  it("rejects an active cold waiter when shutdown aborts the shared refresh", async () => {
    const load = vi.fn(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new FlameSourceError("flame_request_aborted")),
        { once: true },
      );
    }));
    const cache = new FlameDayCache({ load });

    const waiting = cache.read();
    await Promise.resolve();
    await cache.close();

    await expect(waiting).rejects.toMatchObject({ code: "flame_request_aborted" });
  });

  it("warms eagerly, schedules the boundary grace refresh, and clears it on close", async () => {
    const timers = [];
    const clearTimer = vi.fn();
    const setTimer = vi.fn((callback, delay) => {
      const timer = { callback, delay, unref: vi.fn() };
      timers.push(timer);
      return timer;
    });
    const cache = new FlameDayCache({
      load: vi.fn().mockResolvedValue({
        ...payload("2026-08-19T12:10:30.000Z"),
        start: "2026-08-18T12:10:00.000Z",
      }),
      now: () => Date.parse("2026-08-19T12:10:30.000Z"),
      setTimer,
      clearTimer,
    });

    expect(cache.readiness()).toEqual({ status: "unavailable", reason: "timeline_warming" });
    cache.start();
    await cache.refresh("test_waiter");

    expect(cache.readiness()).toEqual({ status: "ok", mode: "sherlock_cached_aggregate" });
    expect(timers.at(-1).delay).toBe(60_000);
    expect(timers.at(-1).unref).toHaveBeenCalledTimes(1);

    await cache.close();
    expect(clearTimer).toHaveBeenCalledWith(timers.at(-1));
  });

  it("rejects a post-grace result whose database read is still pre-grace", async () => {
    const timers = [];
    const cache = new FlameDayCache({
      load: vi.fn().mockResolvedValue({
        ...payload("2026-08-19T12:11:29.000Z"),
        start: "2026-08-18T12:10:00.000Z",
      }),
      now: () => Date.parse("2026-08-19T12:11:31.000Z"),
      setTimer: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimer: vi.fn(),
    });

    await expect(cache.read()).rejects.toMatchObject({ code: "flame_database_result_stale" });
    expect(cache.readiness()).toEqual({ status: "unavailable", reason: "timeline_warming" });
    expect(timers.at(-1).delay).toBe(60_000);
    await cache.close();
  });

  it("retries a failed startup warm and becomes ready only after success", async () => {
    const timers = [];
    const setTimer = vi.fn((callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    });
    const cache = new FlameDayCache({
      load: vi.fn()
        .mockRejectedValueOnce(new Error("database unavailable"))
        .mockResolvedValueOnce(payload()),
      now: () => Date.parse("2026-08-19T12:00:30.000Z"),
      setTimer,
      clearTimer: vi.fn(),
    });

    cache.start();
    await expect(cache.refresh("test_waiter")).rejects.toThrow("database unavailable");
    expect(cache.readiness()).toEqual({ status: "unavailable", reason: "timeline_warming" });
    expect(timers.at(-1).delay).toBe(60_000);

    timers.at(-1).callback();
    await cache.refresh("test_waiter");
    expect(cache.readiness()).toEqual({ status: "ok", mode: "sherlock_cached_aggregate" });
    await cache.close();
  });
});

describe("timeline refresh clock", () => {
  it("refreshes at the current boundary grace when it has not elapsed", () => {
    const now = Date.parse("2026-08-19T12:10:30.000Z");
    expect(nextTimelineRefreshDelay(now)).toBe(60_000);
  });

  it("refreshes at the next boundary grace after the current grace elapsed", () => {
    const now = Date.parse("2026-08-19T12:12:00.000Z");
    expect(nextTimelineRefreshDelay(now)).toBe(9.5 * 60_000);
  });

  it("does not call the latest boundary delayed during its grace period", () => {
    const now = Date.parse("2026-08-19T12:10:30.000Z");
    expect(expectedTimelineEnd(now)).toBe(Date.parse("2026-08-19T12:00:00.000Z"));
  });
});
