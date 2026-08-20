import { describe, expect, it, vi } from "vitest";

import { encodeSnapshotToken, FlameSourceError } from "./flame-source.js";
import {
  FrameEvidenceCoordinator,
  FrameEvidenceLru,
  FRAME_EVIDENCE_MAX_IN_FLIGHT,
} from "./frame-evidence-coordinator.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PERSON_ID = "22222222-2222-4222-8222-222222222222";
const START = "2026-08-19T12:00:00.000Z";
const PG_SNAPSHOT = "730:741:733,739";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function snapshot(readMs) {
  return encodeSnapshotToken({ snapshot: PG_SNAPSHOT, read: new Date(readMs) });
}

describe("frame evidence LRU", () => {
  it("enforces LRU order, TTL, entry count, and byte caps", () => {
    let now = 100;
    const cache = new FrameEvidenceLru({
      maxEntries: 2,
      maxBytes: 8,
      maxEntryBytes: 4,
      now: () => now,
    });
    expect(cache.set("a", { id: "a" }, 4, 200)).toBe(true);
    expect(cache.set("b", { id: "b" }, 4, 200)).toBe(true);
    expect(cache.get("a").payload).toEqual({ id: "a" });
    expect(cache.set("c", { id: "c" }, 4, 200)).toBe(true);
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a").payload).toEqual({ id: "a" });
    expect(cache.set("large", {}, 5, 200)).toBe(false);
    expect(cache.bytes).toBe(8);
    now = 201;
    expect(cache.get("a")).toBeNull();
    expect(cache.get("c")).toBeNull();
    expect(cache.bytes).toBe(0);
  });

  it("evicts expired private payloads without a later cache access", () => {
    let now = 100;
    let expire;
    const unref = vi.fn();
    const clearTimer = vi.fn();
    const cache = new FrameEvidenceLru({
      now: () => now,
      setTimer: (callback) => {
        expire = callback;
        return { unref };
      },
      clearTimer,
    });
    expect(cache.set("private", { content: "private prompt" }, 14, 200)).toBe(true);
    expect(cache.entries.size).toBe(1);
    expect(cache.bytes).toBe(14);
    expect(unref).toHaveBeenCalledOnce();

    now = 200;
    expire();
    expect(cache.entries.size).toBe(0);
    expect(cache.bytes).toBe(0);

    cache.set("next", { content: "next" }, 4, 300);
    cache.close();
    expect(cache.entries.size).toBe(0);
    expect(cache.bytes).toBe(0);
    expect(clearTimer).toHaveBeenCalled();
  });
});

describe("frame evidence coordination", () => {
  it("shares one load, detaches one waiter, and serves the successful cache hit", async () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const receipt = snapshot(now - 1000);
    const log = vi.fn();
    const coordinator = new FrameEvidenceCoordinator({
      workspaceId: WORKSPACE_ID,
      now: () => now,
      cache: new FrameEvidenceLru({ now: () => now }),
      log,
    });
    const blocker = deferred();
    const load = vi.fn(() => blocker.promise);
    const firstController = new AbortController();
    const request = (signal) => coordinator.read({
      kind: "work", personId: PERSON_ID, start: START, snapshot: receipt, signal, load,
    });
    const first = request(firstController.signal);
    const second = request();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    firstController.abort();
    await expect(first).rejects.toMatchObject({ code: "flame_request_aborted" });
    expect(load.mock.calls[0][0].signal.aborted).toBe(false);
    blocker.resolve({ personId: PERSON_ID, work: [] });
    await expect(second).resolves.toEqual({ personId: PERSON_ID, work: [] });
    await expect(request()).resolves.toEqual({ personId: PERSON_ID, work: [] });
    expect(load).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map(([event]) => event.cacheState)).toEqual([
      "shared", "hit",
    ]);
    expect(log).toHaveBeenLastCalledWith({
      event: "frame_evidence",
      kind: "work",
      cacheState: "hit",
      loadMs: 0,
      totalMs: 0,
    });
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toContain(PERSON_ID);
    expect(serialized).not.toContain(receipt);
    expect(serialized).not.toContain(START);
  });

  it("cancels the underlying load only after its final waiter aborts", async () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const controller = new AbortController();
    let sharedSignal;
    const coordinator = new FrameEvidenceCoordinator({ workspaceId: WORKSPACE_ID });
    const load = vi.fn(({ signal }) => new Promise((resolve, reject) => {
      sharedSignal = signal;
      signal.addEventListener("abort", () => reject(new FlameSourceError(
        "flame_request_aborted",
      )), { once: true });
    }));
    const request = coordinator.read({
      kind: "prompts",
      personId: PERSON_ID,
      start: START,
      snapshot: snapshot(now),
      signal: controller.signal,
      load,
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "flame_request_aborted" });
    await vi.waitFor(() => expect(sharedSignal.aborted).toBe(true));
    await vi.waitFor(() => expect(coordinator.flights.size).toBe(0));
  });

  it("starts a fresh flight immediately after the final waiter aborts", async () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const controller = new AbortController();
    const blockers = [deferred(), deferred()];
    const signals = [];
    const load = vi.fn(({ signal }) => {
      signals.push(signal);
      return blockers[signals.length - 1].promise;
    });
    const coordinator = new FrameEvidenceCoordinator({ workspaceId: WORKSPACE_ID });
    const args = {
      kind: "work",
      personId: PERSON_ID,
      start: START,
      snapshot: snapshot(now),
      load,
    };
    const first = coordinator.read({ ...args, signal: controller.signal });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "flame_request_aborted" });
    expect(signals[0].aborted).toBe(true);

    const second = coordinator.read(args);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(signals[1].aborted).toBe(false);
    blockers[0].resolve({ work: ["stale"] });
    blockers[1].resolve({ work: ["fresh"] });
    await expect(second).resolves.toEqual({ work: ["fresh"] });
    await expect(coordinator.read(args)).resolves.toEqual({ work: ["fresh"] });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("closes asynchronously after aborting and settling active flights", async () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const coordinator = new FrameEvidenceCoordinator({ workspaceId: WORKSPACE_ID });
    const load = vi.fn(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new FlameSourceError(
        "flame_request_aborted",
      )), { once: true });
    }));
    const request = coordinator.read({
      kind: "prompts",
      personId: PERSON_ID,
      start: START,
      snapshot: snapshot(now),
      load,
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    const rejected = expect(request).rejects.toMatchObject({ code: "flame_request_aborted" });
    await coordinator.close();
    await rejected;
    expect(coordinator.flights.size).toBe(0);
    await expect(coordinator.read({
      kind: "prompts",
      personId: PERSON_ID,
      start: START,
      snapshot: snapshot(now),
      load,
    })).rejects.toMatchObject({ code: "flame_database_unavailable" });
  });

  it("caches work, prompts, and combined responses independently", async () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const log = vi.fn();
    const coordinator = new FrameEvidenceCoordinator({ workspaceId: WORKSPACE_ID, log });
    for (const kind of ["work", "prompts", "combined"]) {
      const load = vi.fn().mockResolvedValue({ kind });
      const args = {
        kind,
        personId: PERSON_ID,
        start: START,
        snapshot: snapshot(now),
        load,
      };
      await expect(coordinator.read(args)).resolves.toEqual({ kind });
      await expect(coordinator.read(args)).resolves.toEqual({ kind });
      expect(load).toHaveBeenCalledOnce();
    }
    expect(log.mock.calls.map(([event]) => event.cacheState)).toEqual([
      "miss", "hit", "miss", "hit", "miss", "hit",
    ]);
  });

  it("keeps aborted-but-unsettled reloads charged until close can settle them", async () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const blockers = [deferred(), deferred()];
    let loadIndex = 0;
    const load = vi.fn(() => blockers[loadIndex++].promise);
    const coordinator = new FrameEvidenceCoordinator({
      workspaceId: WORKSPACE_ID,
      maxInFlight: 2,
    });
    expect(FRAME_EVIDENCE_MAX_IN_FLIGHT).toBe(16);
    const args = {
      kind: "work",
      personId: PERSON_ID,
      start: START,
      snapshot: snapshot(now),
      load,
    };
    for (let index = 0; index < 2; index += 1) {
      const controller = new AbortController();
      const request = coordinator.read({ ...args, signal: controller.signal });
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(index + 1));
      controller.abort();
      await expect(request).rejects.toMatchObject({ code: "flame_request_aborted" });
      expect(coordinator.flights.size).toBe(0);
      expect(coordinator.pendingFlights.size).toBe(index + 1);
    }

    for (let index = 0; index < 4; index += 1) {
      await expect(coordinator.read(args)).rejects.toMatchObject({
        code: "flame_database_unavailable",
      });
      expect(coordinator.pendingFlights.size).toBe(2);
    }
    expect(load).toHaveBeenCalledTimes(2);

    let closed = false;
    const closing = coordinator.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    for (const blocker of blockers) blocker.resolve({ work: [] });
    await closing;
    expect(coordinator.pendingFlights.size).toBe(0);
  });

  it("does not cache errors, oversized responses, or entries past receipt expiry", async () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const cache = new FrameEvidenceLru({ maxEntryBytes: 8, now: () => now });
    const coordinator = new FrameEvidenceCoordinator({
      workspaceId: WORKSPACE_ID,
      cache,
      now: () => now,
    });
    const receipt = snapshot(now - 25 * 60 * 60 * 1000 + 1000);
    const errorLoad = vi.fn().mockRejectedValue(new FlameSourceError(
      "flame_interval_prompt_result_too_large",
    ));
    const args = {
      kind: "prompts", personId: PERSON_ID, start: START, snapshot: receipt,
    };
    await expect(coordinator.read({ ...args, load: errorLoad })).rejects.toMatchObject({
      code: "flame_interval_prompt_result_too_large",
    });
    await expect(coordinator.read({ ...args, load: errorLoad })).rejects.toMatchObject({
      code: "flame_interval_prompt_result_too_large",
    });
    expect(errorLoad).toHaveBeenCalledTimes(2);

    const largeLoad = vi.fn().mockResolvedValue({ content: "too large" });
    await coordinator.read({ ...args, kind: "work", load: largeLoad });
    await coordinator.read({ ...args, kind: "work", load: largeLoad });
    expect(largeLoad).toHaveBeenCalledTimes(2);

    const expiringLoad = vi.fn().mockResolvedValue({ ok: true });
    await coordinator.read({ ...args, kind: "combined", load: expiringLoad });
    now += 1001;
    await coordinator.read({ ...args, kind: "combined", load: expiringLoad });
    expect(expiringLoad).toHaveBeenCalledTimes(2);
  });
});
