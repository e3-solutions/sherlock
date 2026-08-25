import { FlameSourceError } from "./flame-source.js";

export const FRESHNESS_REFRESH_MS = 2 * 60 * 1000;
export const FRESHNESS_RETRY_MS = 60 * 1000;
export const FRESHNESS_MAX_SERVE_AGE_MS = 10 * 60 * 1000;

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

export class FreshnessCache {
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
    this.retryNotBefore = null;
    this.timer = null;
    this.closed = false;
  }

  start() {
    void this.refresh("startup").catch(() => {});
  }

  isServeable() {
    return Boolean(this.entry && this.now() - this.entry.receivedAt < FRESHNESS_MAX_SERVE_AGE_MS);
  }

  isFresh() {
    return Boolean(this.entry && this.now() - this.entry.receivedAt < FRESHNESS_REFRESH_MS);
  }

  async read({ signal, waitForRefresh = false } = {}) {
    if (this.closed) throw new FlameSourceError("flame_database_unavailable");
    if (!this.isServeable()) {
      await waitFor(this.refresh("cold_request"), signal);
    } else if (!this.isFresh()) {
      const refresh = this.refresh("stale_request");
      if (waitForRefresh) {
        try {
          await waitFor(refresh, signal);
        } catch (error) {
          if (error instanceof FlameSourceError && error.code === "flame_request_aborted") {
            throw error;
          }
        }
      } else {
        void refresh.catch(() => {});
      }
    }
    if (!this.isServeable()) throw new FlameSourceError("flame_database_unavailable");
    return { payload: this.entry.payload, state: this.isFresh() ? "hit" : "stale" };
  }

  refresh(trigger) {
    if (this.closed) return Promise.reject(new FlameSourceError("flame_database_unavailable"));
    if (this.refreshPromise) return this.refreshPromise;
    const refreshNow = this.now();
    if (this.retryNotBefore !== null && refreshNow < this.retryNotBefore) {
      return Promise.reject(new FlameSourceError("flame_database_unavailable"));
    }
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const startedAt = this.now();
    const controller = new AbortController();
    this.refreshController = controller;
    this.log({ event: "freshness_refresh_start", trigger });
    let succeeded = false;
    const refresh = Promise.resolve()
      .then(() => this.load({ signal: controller.signal }))
      .then((payload) => {
        const read = Date.parse(payload?.read);
        if (!Number.isSafeInteger(read) || (this.entry && read < this.entry.read)) {
          throw new FlameSourceError("flame_database_result_stale");
        }
        this.entry = { payload, read, receivedAt: this.now() };
        this.retryNotBefore = null;
        succeeded = true;
        this.log({
          event: "freshness_refresh_success",
          trigger,
          read: payload.read,
          delayed: payload.delayed,
          pendingNormalize: payload.pendingNormalize,
          elapsedMs: this.now() - startedAt,
        });
        return payload;
      })
      .catch((error) => {
        this.retryNotBefore = this.now() + FRESHNESS_RETRY_MS;
        this.log({
          event: "freshness_refresh_failure",
          trigger,
          code: error instanceof FlameSourceError ? error.code : "flame_database_unavailable",
          elapsedMs: this.now() - startedAt,
        });
        throw error;
      })
      .finally(() => {
        if (this.refreshPromise === refresh) this.refreshPromise = null;
        if (this.refreshController === controller) this.refreshController = null;
        if (!this.closed) this.schedule(succeeded ? FRESHNESS_REFRESH_MS : FRESHNESS_RETRY_MS);
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
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.refreshController?.abort();
    try {
      await this.refreshPromise;
    } catch {
      // The refresh failure has already been logged.
    }
  }
}
