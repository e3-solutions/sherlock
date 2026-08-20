import { decodeSnapshotToken, FlameSourceError } from "./flame-source.js";

export const FRAME_EVIDENCE_CONTRACT_VERSION = "frame-evidence-v1";
export const FRAME_EVIDENCE_CACHE_TTL_MS = 3 * 60 * 1000;
export const FRAME_EVIDENCE_CACHE_MAX_ENTRIES = 128;
export const FRAME_EVIDENCE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const FRAME_EVIDENCE_CACHE_MAX_ENTRY_BYTES = 512 * 1024;
export const FRAME_EVIDENCE_GATE_LIMIT = 2;
export const FRAME_EVIDENCE_GATE_MAX_QUEUE = 128;
export const FRAME_EVIDENCE_GATE_MAX_WAIT_MS = 20 * 1000;

function aborted() {
  return new FlameSourceError("flame_request_aborted");
}

function unavailable() {
  return new FlameSourceError("flame_database_unavailable");
}

function removeItem(items, item) {
  const index = items.indexOf(item);
  if (index >= 0) items.splice(index, 1);
}

export class FrameEvidenceGate {
  constructor({
    limit = FRAME_EVIDENCE_GATE_LIMIT,
    maxQueue = FRAME_EVIDENCE_GATE_MAX_QUEUE,
    maxWaitMs = FRAME_EVIDENCE_GATE_MAX_WAIT_MS,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.limit = limit;
    this.maxQueue = maxQueue;
    this.maxWaitMs = maxWaitMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.active = 0;
    this.queue = [];
    this.closed = false;
  }

  async run(callback, { signal } = {}) {
    const permit = await this.acquire(signal);
    try {
      if (signal?.aborted) throw aborted();
      return { value: await callback(), waitMs: permit.waitMs };
    } finally {
      permit.release();
    }
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(aborted());
    if (this.closed) return Promise.reject(unavailable());
    const queuedAt = this.now();
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.permit(queuedAt));
    }
    if (this.queue.length >= this.maxQueue) return Promise.reject(unavailable());

    return new Promise((resolve, reject) => {
      const waiter = { queuedAt, resolve, reject, signal, timer: null, abort: null };
      const fail = (error) => {
        removeItem(this.queue, waiter);
        this.cleanup(waiter);
        reject(error);
      };
      waiter.abort = () => fail(aborted());
      signal?.addEventListener("abort", waiter.abort, { once: true });
      waiter.timer = this.setTimer(() => fail(unavailable()), this.maxWaitMs);
      waiter.timer?.unref?.();
      this.queue.push(waiter);
    });
  }

  permit(queuedAt) {
    let released = false;
    return {
      waitMs: Math.max(0, this.now() - queuedAt),
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      },
    };
  }

  drain() {
    while (!this.closed && this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift();
      this.cleanup(waiter);
      if (waiter.signal?.aborted) {
        waiter.reject(aborted());
        continue;
      }
      this.active += 1;
      waiter.resolve(this.permit(waiter.queuedAt));
    }
  }

  cleanup(waiter) {
    if (waiter.timer !== null) this.clearTimer(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.abort);
  }

  close() {
    this.closed = true;
    for (const waiter of this.queue.splice(0)) {
      this.cleanup(waiter);
      waiter.reject(unavailable());
    }
  }
}

export class FrameEvidenceLru {
  constructor({
    maxEntries = FRAME_EVIDENCE_CACHE_MAX_ENTRIES,
    maxBytes = FRAME_EVIDENCE_CACHE_MAX_BYTES,
    maxEntryBytes = FRAME_EVIDENCE_CACHE_MAX_ENTRY_BYTES,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.maxEntryBytes = maxEntryBytes;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.entries = new Map();
    this.bytes = 0;
    this.expiryTimer = null;
    this.closed = false;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.remove(key);
      this.scheduleExpiry();
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key, payload, bytes, expiresAt) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxEntryBytes ||
        expiresAt <= this.now() || this.closed) {
      return false;
    }
    this.remove(key);
    this.entries.set(key, { payload, bytes, expiresAt });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.remove(this.entries.keys().next().value);
    }
    this.scheduleExpiry();
    return this.entries.has(key);
  }

  delete(key) {
    this.remove(key);
    this.scheduleExpiry();
  }

  remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  scheduleExpiry() {
    if (this.expiryTimer !== null) {
      this.clearTimer(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (this.closed || this.entries.size === 0) return;
    let expiresAt = Infinity;
    for (const entry of this.entries.values()) {
      expiresAt = Math.min(expiresAt, entry.expiresAt);
    }
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = null;
      const now = this.now();
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt <= now) this.remove(key);
      }
      this.scheduleExpiry();
    }, Math.max(0, expiresAt - this.now()));
    this.expiryTimer?.unref?.();
  }

  clear() {
    if (this.expiryTimer !== null) {
      this.clearTimer(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.entries.clear();
    this.bytes = 0;
  }

  close() {
    this.closed = true;
    this.clear();
  }
}

function canonicalStart(value) {
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : String(value);
}

function receiptExpiry(snapshot) {
  try {
    return decodeSnapshotToken(snapshot).read.getTime() + 25 * 60 * 60 * 1000;
  } catch {
    return 0;
  }
}

function responseBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function serverTiming({ cacheState, gateWaitMs, loadMs, totalMs }) {
  const duration = (value) => Math.max(0, value).toFixed(1);
  return [
    `frame_cache;desc="${cacheState}"`,
    `frame_gate;dur=${duration(gateWaitMs)}`,
    `frame_load;dur=${duration(loadMs)}`,
    `frame_total;dur=${duration(totalMs)}`,
  ].join(", ");
}

export class FrameEvidenceCoordinator {
  constructor({
    workspaceId,
    gate = new FrameEvidenceGate(),
    cache = new FrameEvidenceLru(),
    cacheTtlMs = FRAME_EVIDENCE_CACHE_TTL_MS,
    now = Date.now,
    log = () => {},
  }) {
    this.workspaceId = workspaceId;
    this.gate = gate;
    this.cache = cache;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.log = log;
    this.flights = new Map();
    this.closed = false;
  }

  async read({ kind, personId, start, snapshot, signal, load }) {
    const requestStarted = this.now();
    if (signal?.aborted) throw aborted();
    if (this.closed) throw unavailable();
    const key = [
      this.workspaceId,
      FRAME_EVIDENCE_CONTRACT_VERSION,
      kind,
      snapshot,
      personId,
      canonicalStart(start),
    ].join("\u0000");
    const cached = this.cache.get(key);
    if (cached) {
      const metrics = {
        cacheState: "hit",
        gateWaitMs: 0,
        loadMs: 0,
        totalMs: Math.max(0, this.now() - requestStarted),
        bytes: cached.bytes,
      };
      this.record(kind, metrics);
      return { payload: cached.payload, serverTiming: serverTiming(metrics), metrics };
    }

    let flight = this.flights.get(key);
    if (flight && (flight.settled || flight.controller.signal.aborted)) {
      if (this.flights.get(key) === flight) this.flights.delete(key);
      flight = null;
    }
    const cacheState = flight ? "shared" : "miss";
    if (!flight) {
      flight = this.createFlight({ key, kind, snapshot, load });
      this.flights.set(key, flight);
    }
    flight.waiters += 1;
    try {
      const result = await this.waitFor(flight.result, signal);
      const metrics = {
        ...result.metrics,
        cacheState,
        totalMs: Math.max(0, this.now() - requestStarted),
      };
      this.record(kind, metrics);
      if (result.error) throw result.error;
      return { payload: result.payload, serverTiming: serverTiming(metrics), metrics };
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        if (this.flights.get(key) === flight) this.flights.delete(key);
        flight.controller.abort();
      }
    }
  }

  createFlight({ key, snapshot, load }) {
    const controller = new AbortController();
    const flight = { controller, waiters: 0, settled: false, result: null };
    flight.result = (async () => {
      let gateWaitMs = 0;
      let loadMs = 0;
      try {
        const gated = await this.gate.run(async () => {
          const loadStarted = this.now();
          try {
            return await load({ signal: controller.signal });
          } finally {
            loadMs = Math.max(0, this.now() - loadStarted);
          }
        }, { signal: controller.signal });
        gateWaitMs = gated.waitMs;
        if (controller.signal.aborted) throw aborted();
        const payload = gated.value;
        const bytes = responseBytes(payload);
        const expiresAt = Math.min(
          this.now() + this.cacheTtlMs,
          receiptExpiry(snapshot),
        );
        this.cache.set(key, payload, bytes, expiresAt);
        return { payload, metrics: { gateWaitMs, loadMs, bytes } };
      } catch (error) {
        return { error, metrics: { gateWaitMs, loadMs, bytes: 0 } };
      } finally {
        flight.settled = true;
        if (this.flights.get(key) === flight) this.flights.delete(key);
      }
    })();
    return flight;
  }

  waitFor(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const abort = () => reject(aborted());
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  record(kind, metrics) {
    this.log({ event: "frame_evidence", kind, ...metrics });
  }

  async close() {
    this.closed = true;
    this.gate.close();
    this.cache.close();
    const flights = [...new Set(this.flights.values())];
    this.flights.clear();
    for (const flight of flights) flight.controller.abort();
    await Promise.all(flights.map((flight) => flight.result));
  }
}
