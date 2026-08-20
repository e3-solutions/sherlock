import { decodeSnapshotToken, FlameSourceError } from "./flame-source.js";

export const FRAME_EVIDENCE_CONTRACT_VERSION = "frame-evidence-v1";
export const FRAME_EVIDENCE_CACHE_TTL_MS = 3 * 60 * 1000;
export const FRAME_EVIDENCE_CACHE_MAX_ENTRIES = 128;
export const FRAME_EVIDENCE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const FRAME_EVIDENCE_CACHE_MAX_ENTRY_BYTES = 512 * 1024;
export const FRAME_EVIDENCE_MAX_IN_FLIGHT = 16;

function aborted() {
  return new FlameSourceError("flame_request_aborted");
}

function unavailable() {
  return new FlameSourceError("flame_database_unavailable");
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

export class FrameEvidenceCoordinator {
  constructor({
    workspaceId,
    cache = new FrameEvidenceLru(),
    cacheTtlMs = FRAME_EVIDENCE_CACHE_TTL_MS,
    maxInFlight = FRAME_EVIDENCE_MAX_IN_FLIGHT,
    now = Date.now,
    log = () => {},
  }) {
    this.workspaceId = workspaceId;
    this.cache = cache;
    this.cacheTtlMs = cacheTtlMs;
    this.maxInFlight = maxInFlight;
    this.now = now;
    this.log = log;
    this.flights = new Map();
    this.pendingFlights = new Set();
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
      this.record(kind, "hit", 0, requestStarted);
      return cached.payload;
    }

    let flight = this.flights.get(key);
    if (flight && (flight.settled || flight.controller.signal.aborted)) {
      if (this.flights.get(key) === flight) this.flights.delete(key);
      flight = null;
    }
    const cacheState = flight ? "shared" : "miss";
    if (!flight) {
      if (this.pendingFlights.size >= this.maxInFlight) throw unavailable();
      flight = this.createFlight({ key, snapshot, load });
      this.flights.set(key, flight);
    }
    flight.waiters += 1;
    try {
      const result = await this.waitFor(flight.result, signal);
      this.record(kind, cacheState, result.loadMs, requestStarted);
      if (result.error) throw result.error;
      return result.payload;
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
    this.pendingFlights.add(flight);
    flight.result = (async () => {
      const loadStarted = this.now();
      let loadMs = 0;
      try {
        let payload;
        try {
          payload = await load({ signal: controller.signal });
        } finally {
          loadMs = Math.max(0, this.now() - loadStarted);
        }
        if (controller.signal.aborted) throw aborted();
        const bytes = responseBytes(payload);
        const expiresAt = Math.min(
          this.now() + this.cacheTtlMs,
          receiptExpiry(snapshot),
        );
        this.cache.set(key, payload, bytes, expiresAt);
        return { payload, loadMs };
      } catch (error) {
        return { error, loadMs };
      } finally {
        flight.settled = true;
        this.pendingFlights.delete(flight);
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

  record(kind, cacheState, loadMs, requestStarted) {
    this.log({
      event: "frame_evidence",
      kind,
      cacheState,
      loadMs,
      totalMs: Math.max(0, this.now() - requestStarted),
    });
  }

  async close() {
    this.closed = true;
    this.cache.close();
    const flights = [...this.pendingFlights];
    this.flights.clear();
    for (const flight of flights) flight.controller.abort();
    await Promise.all(flights.map((flight) => flight.result));
  }
}
