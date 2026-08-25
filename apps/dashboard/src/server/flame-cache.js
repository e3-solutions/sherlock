import { gzipSync } from "node:zlib";

import { BUCKET_MS, FlameSourceError } from "./flame-source.js";

export const REFRESH_OFFSET_MS = 90 * 1000;
export const REFRESH_RETRY_MS = 60 * 1000;
export const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

export function nextTimelineRefreshDelay(now) {
  const boundary = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const candidate = boundary + REFRESH_OFFSET_MS;
  return Math.max(1000, (candidate > now ? candidate : candidate + BUCKET_MS) - now);
}

export function expectedTimelineEnd(now) {
  return Math.floor((now - REFRESH_OFFSET_MS) / BUCKET_MS) * BUCKET_MS;
}

function payloadEnd(payload) {
  const start = Date.parse(payload?.start);
  const read = Date.parse(payload?.read);
  const end = start + 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(read) ||
      start % BUCKET_MS !== 0 || end !== Math.floor(read / BUCKET_MS) * BUCKET_MS ||
      typeof payload.snapshot !== "string" || payload.snapshot.length === 0 ||
      !Array.isArray(payload.people)) {
    throw new FlameSourceError("flame_database_result_invalid");
  }
  return { end, read };
}

function cacheEntry(payload, end, read) {
  const identity = Buffer.from(JSON.stringify(payload), "utf8");
  return Object.freeze({
    payload,
    identity,
    gzip: gzipSync(identity),
    end,
    read,
  });
}

function abortError() {
  return new FlameSourceError("flame_request_aborted");
}

async function waitFor(promise, signal) {
  if (!signal) return await promise;
  if (signal.aborted) throw abortError();
  return await new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class FlameDayCache {
  constructor({
    load,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = () => {},
  }) {
    this.load = load;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.log = log;
    this.entry = null;
    this.refreshPromise = null;
    this.refreshController = null;
    this.lastForcedAt = null;
    this.retryNotBefore = null;
    this.timer = null;
    this.closed = false;
  }

  start() {
    void this.refresh("startup").catch(() => {});
  }

  readiness() {
    return this.isServeable()
      ? { status: "ok", mode: "sherlock_cached_aggregate" }
      : {
          status: "unavailable",
          reason: this.entry ? "timeline_expired" : "timeline_warming",
        };
  }

  isServeable(entry = this.entry) {
    return Boolean(entry && this.now() - entry.read < MAX_CACHE_AGE_MS);
  }

  isFresh(entry = this.entry) {
    if (!this.isServeable(entry)) return false;
    const expectedEnd = expectedTimelineEnd(this.now());
    return entry.end > expectedEnd || (
      entry.end === expectedEnd && entry.read >= entry.end + REFRESH_OFFSET_MS
    );
  }

  async read({ signal, forceRefresh = false, waitForRefresh = false } = {}) {
    if (this.closed) throw new FlameSourceError("flame_database_unavailable");

    if (!this.isServeable()) {
      await waitFor(this.refresh("cold_request"), signal);
    } else if (forceRefresh || !this.isFresh()) {
      const refresh = this.refresh(forceRefresh ? "forced_request" : "stale_request");
      if (forceRefresh || waitForRefresh) {
        try {
          await waitFor(refresh, signal);
        } catch (error) {
          if (error instanceof FlameSourceError && error.code === "flame_request_aborted") {
            throw error;
          }
          if (forceRefresh) throw error;
        }
      } else {
        void refresh.catch(() => {});
      }
    }

    return {
      payload: this.entry.payload,
      identity: this.entry.identity,
      gzip: this.entry.gzip,
      state: this.isFresh() ? "hit" : "stale",
    };
  }

  refresh(trigger) {
    if (this.closed) {
      return Promise.reject(new FlameSourceError("flame_database_unavailable"));
    }
    if (this.refreshPromise) return this.refreshPromise;

    const refreshNow = this.now();
    if (trigger === "forced_request") {
      if (this.lastForcedAt !== null && refreshNow - this.lastForcedAt < REFRESH_RETRY_MS) {
        return Promise.reject(new FlameSourceError("flame_refresh_throttled"));
      }
      this.lastForcedAt = refreshNow;
    } else if (trigger !== "scheduled" && this.retryNotBefore !== null &&
        refreshNow < this.retryNotBefore) {
      return Promise.reject(new FlameSourceError("flame_database_unavailable"));
    }

    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const startedAt = refreshNow;
    const controller = new AbortController();
    this.refreshController = controller;
    this.log({ event: "timeline_refresh_start", trigger });
    let succeeded = false;
    const refresh = Promise.resolve()
      .then(() => this.load({ signal: controller.signal }))
      .then((payload) => {
        const { end, read } = payloadEnd(payload);
        const metadata = { end, read };
        if (!this.isFresh(metadata) || (this.entry && (
          metadata.end < this.entry.end || metadata.read < this.entry.read
        ))) {
          throw new FlameSourceError("flame_database_result_stale");
        }
        const candidate = cacheEntry(payload, end, read);
        this.entry = candidate;
        this.retryNotBefore = null;
        succeeded = true;
        this.log({
          event: "timeline_refresh_success",
          trigger,
          bucketEnd: new Date(end).toISOString(),
          elapsedMs: this.now() - startedAt,
        });
        return payload;
      })
      .catch((error) => {
        this.retryNotBefore = this.now() + REFRESH_RETRY_MS;
        this.log({
          event: "timeline_refresh_failure",
          trigger,
          code: error instanceof FlameSourceError ? error.code : "flame_database_unavailable",
          elapsedMs: this.now() - startedAt,
          cacheAgeMs: this.entry ? Math.max(0, this.now() - this.entry.read) : null,
        });
        throw error;
      })
      .finally(() => {
        if (this.refreshPromise === refresh) this.refreshPromise = null;
        if (this.refreshController === controller) this.refreshController = null;
        if (!this.closed) {
          this.schedule(succeeded ? nextTimelineRefreshDelay(this.now()) : REFRESH_RETRY_MS);
        }
      });
    this.refreshPromise = refresh;
    return refresh;
  }

  schedule(delay) {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.refresh("scheduled").catch(() => {});
    }, delay);
    this.timer?.unref?.();
  }

  async close() {
    this.closed = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.refreshController?.abort();
    try {
      await this.refreshPromise;
    } catch {
      // The refresh failure was already logged; shutdown still owns source cleanup.
    }
  }
}
