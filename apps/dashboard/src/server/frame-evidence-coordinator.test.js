import { describe, expect, it, vi } from "vitest";

import { encodeSnapshotToken, FlameSourceError } from "./flame-source.js";
import {
  FrameEvidenceCoordinator,
  FrameEvidenceGate,
  FrameEvidenceLru,
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

describe("frame evidence admission", () => {
  it("admits two transactions and starts queued work in FIFO order", async () => {
    const gate = new FrameEvidenceGate({ limit: 2 });
    const blockers = [deferred(), deferred(), deferred()];
    const started = [];
    const calls = blockers.map((blocker, index) => gate.run(async () => {
      started.push(index);
      await blocker.promise;
      return index;
    }));

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    blockers[0].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    blockers[1].resolve();
    blockers[2].resolve();
    await expect(Promise.all(calls)).resolves.toEqual([
      { value: 0, waitMs: expect.any(Number) },
      { value: 1, waitMs: expect.any(Number) },
      { value: 2, waitMs: expect.any(Number) },
    ]);
  });

  it("removes an aborted queued waiter without releasing an active permit", async () => {
    const gate = new FrameEvidenceGate({ limit: 1 });
    const blocker = deferred();
    const active = gate.run(() => blocker.promise);
    await vi.waitFor(() => expect(gate.active).toBe(1));

    const controller = new AbortController();
    const queuedCallback = vi.fn();
    const queued = gate.run(queuedCallback, { signal: controller.signal });
    await vi.waitFor(() => expect(gate.queue).toHaveLength(1));
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "flame_request_aborted" });
    expect(queuedCallback).not.toHaveBeenCalled();
    expect(gate.active).toBe(1);
    expect(gate.queue).toHaveLength(0);

    blocker.resolve("done");
    await expect(active).resolves.toMatchObject({ value: "done" });
    expect(gate.active).toBe(0);
  });

  it("bounds both the queue and queue wait with the stable unavailable error", async () => {
    let expire;
    const gate = new FrameEvidenceGate({
      limit: 1,
      maxQueue: 1,
      maxWaitMs: 10,
      setTimer: (callback) => {
        expire = callback;
        return { unref: vi.fn() };
      },
      clearTimer: vi.fn(),
    });
    const blocker = deferred();
    const active = gate.run(() => blocker.promise);
    await vi.waitFor(() => expect(gate.active).toBe(1));
    const waiting = gate.run(vi.fn());
    await vi.waitFor(() => expect(gate.queue).toHaveLength(1));
    await expect(gate.run(vi.fn())).rejects.toMatchObject({
      code: "flame_database_unavailable",
    });
    expire();
    await expect(waiting).rejects.toMatchObject({ code: "flame_database_unavailable" });
    blocker.resolve();
    await active;
  });
});

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
    const coordinator = new FrameEvidenceCoordinator({
      workspaceId: WORKSPACE_ID,
      now: () => now,
      cache: new FrameEvidenceLru({ now: () => now }),
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
    await expect(second).resolves.toMatchObject({
      payload: { personId: PERSON_ID, work: [] },
      metrics: { cacheState: "shared" },
    });
    await expect(request()).resolves.toMatchObject({ metrics: { cacheState: "hit" } });
    expect(load).toHaveBeenCalledTimes(1);
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
    await vi.waitFor(() => expect(coordinator.gate.active).toBe(0));
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
    await expect(second).resolves.toMatchObject({ payload: { work: ["fresh"] } });
    await expect(coordinator.read(args)).resolves.toMatchObject({
      payload: { work: ["fresh"] },
      metrics: { cacheState: "hit" },
    });
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
    expect(coordinator.gate.active).toBe(0);
    expect(coordinator.flights.size).toBe(0);
    await expect(coordinator.read({
      kind: "prompts",
      personId: PERSON_ID,
      start: START,
      snapshot: snapshot(now),
      load,
    })).rejects.toMatchObject({ code: "flame_database_unavailable" });
  });

  it("limits underlying loads across kinds and never assembles combined from split", async () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const gate = new FrameEvidenceGate({ limit: 2 });
    const coordinator = new FrameEvidenceCoordinator({ workspaceId: WORKSPACE_ID, gate });
    const blockers = [deferred(), deferred(), deferred()];
    const started = [];
    const kinds = ["work", "prompts", "combined"];
    const requests = kinds.map((kind, index) => coordinator.read({
      kind,
      personId: PERSON_ID,
      start: START,
      snapshot: snapshot(now),
      load: async () => {
        started.push(kind);
        await blockers[index].promise;
        return { kind };
      },
    }));
    await vi.waitFor(() => expect(started).toEqual(["work", "prompts"]));
    blockers[0].resolve();
    await vi.waitFor(() => expect(started).toEqual(["work", "prompts", "combined"]));
    blockers[1].resolve();
    blockers[2].resolve();
    await expect(Promise.all(requests)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: { kind: "combined" } }),
    ]));
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

  it("logs and times only bounded non-identifying metadata", async () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const log = vi.fn();
    const coordinator = new FrameEvidenceCoordinator({ workspaceId: WORKSPACE_ID, log });
    const receipt = snapshot(now);
    const result = await coordinator.read({
      kind: "work",
      personId: PERSON_ID,
      start: START,
      snapshot: receipt,
      load: vi.fn().mockResolvedValue({ work: [] }),
    });
    expect(result.serverTiming).toMatch(
      /^frame_cache;desc="miss", frame_gate;dur=\d+\.\d, frame_load;dur=\d+\.\d, frame_total;dur=\d+\.\d$/,
    );
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toContain(PERSON_ID);
    expect(serialized).not.toContain(receipt);
    expect(serialized).not.toContain(START);
    expect(log).toHaveBeenCalledWith({
      event: "frame_evidence",
      kind: "work",
      cacheState: "miss",
      gateWaitMs: expect.any(Number),
      loadMs: expect.any(Number),
      totalMs: expect.any(Number),
      bytes: expect.any(Number),
    });
  });
});
