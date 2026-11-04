import { FlameSourceError } from "./flame-source.js";
import { runQuery } from "./mcp-query-source.js";

export const RECORD_EXCERPT_READS_SQL =
  "select sherlock_audit.record_excerpt_reads($1::uuid, $2::jsonb) written";

const AUDIT_FILTERS = `
 where workspace_id = $1 and read_at >= $2::timestamptz and read_at < $3::timestamptz
   and ($4::text is null or caller = $4::text)
   and ($5::uuid is null or owner_person_id = $5::uuid)
   and ($6::uuid is null or session_id = $6::uuid)`;

export const LIST_EXCERPT_READS_SQL = `
select read_at, caller, caller_tier, tool, outcome, session_id::text session_id,
       owner_person_id::text owner_person_id, request_id
  from sherlock_audit.excerpt_reads${AUDIT_FILTERS}
 order by read_at desc, id desc
 limit $7`;

export const SUMMARIZE_EXCERPT_READS_SQL = `
select caller, owner_person_id::text owner_person_id, count(*)::bigint reads,
       count(distinct session_id)::bigint sessions,
       (count(*) filter (where outcome = 'rate_limited'))::bigint rate_limited,
       min(read_at) first_read_at, max(read_at) last_read_at
  from sherlock_audit.excerpt_reads${AUDIT_FILTERS}
 group by caller, owner_person_id
 order by reads desc, caller nulls first, owner_person_id nulls first
 limit $7`;

export const AUDIT_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AUDIT_MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
export const AUDIT_MAX_LIMIT = 200;
const AUDIT_STATEMENT_TIMEOUT_MS = 5_000;

function iso(value) {
  return new Date(value).toISOString();
}

function count(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

// Reads and appends audit rows in the configured workspace. Writes go only
// through sherlock_audit.record_excerpt_reads().
export function createExcerptAuditStore(source) {
  if (typeof source?.transaction !== "function" || typeof source.workspaceId !== "string") {
    throw new TypeError("A direct Sherlock source is required");
  }
  return Object.freeze({
    async write(rows) {
      const result = await source.transaction(async (tx) => await runQuery(
        tx, RECORD_EXCERPT_READS_SQL, [source.workspaceId, JSON.stringify(rows)],
      ), { readOnly: false, statementTimeoutMs: AUDIT_STATEMENT_TIMEOUT_MS });
      return count(result?.[0]?.written);
    },

    async list({ start, end, caller, ownerPersonId, sessionId, view = "summary", limit, signal, now } = {}) {
      const readAt = new Date(now ?? Date.now());
      const endAt = end === undefined ? readAt : new Date(end);
      const startAt = start === undefined ? new Date(endAt.getTime() - AUDIT_DEFAULT_WINDOW_MS) : new Date(start);
      if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) ||
          startAt >= endAt || endAt > readAt) {
        throw new FlameSourceError("flame_mcp_query_request_invalid");
      }
      if (endAt.getTime() - startAt.getTime() > AUDIT_MAX_WINDOW_MS) {
        throw new FlameSourceError("flame_mcp_audit_window_too_large");
      }
      const pageSize = Math.min(Math.max(limit ?? 50, 1), AUDIT_MAX_LIMIT);
      const params = [
        source.workspaceId, startAt.toISOString(), endAt.toISOString(),
        caller ?? null, ownerPersonId ?? null, sessionId ?? null, pageSize + 1,
      ];
      const rows = await source.transaction(async (tx) => await runQuery(
        tx, view === "reads" ? LIST_EXCERPT_READS_SQL : SUMMARIZE_EXCERPT_READS_SQL, params, signal,
      ), { signal, statementTimeoutMs: AUDIT_STATEMENT_TIMEOUT_MS });
      const page = rows.slice(0, pageSize);
      const window = { startInclusive: startAt.toISOString(), endExclusive: endAt.toISOString() };
      if (view === "reads") {
        return {
          view, window, truncated: rows.length > pageSize,
          reads: page.map((row) => ({
            readAt: iso(row.read_at),
            caller: row.caller ?? null,
            callerTier: row.caller_tier ?? null,
            tool: row.tool,
            outcome: row.outcome,
            sessionId: row.session_id ?? null,
            ownerPersonId: row.owner_person_id ?? null,
            requestId: row.request_id ?? null,
          })),
        };
      }
      return {
        view: "summary", window, truncated: rows.length > pageSize,
        groups: page.map((row) => ({
          caller: row.caller ?? null,
          ownerPersonId: row.owner_person_id ?? null,
          reads: count(row.reads),
          distinctSessions: count(row.sessions),
          rateLimited: count(row.rate_limited),
          firstReadAt: iso(row.first_read_at),
          lastReadAt: iso(row.last_read_at),
        })),
      };
    },
  });
}

// Buffers audit rows off the request path and appends them in small batches.
// A failed batch is retried on the next flush; past maxBuffered rows the
// oldest are dropped and the drop is logged (the per-read log line remains).
export function createExcerptAuditWriter({
  store,
  flushMs = 2_000,
  maxBatch = 200,
  maxBuffered = 10_000,
  log = (event) => console.log(JSON.stringify(event)),
} = {}) {
  let buffer = [];
  let timer = null;
  let flushing = null;
  let failing = false;
  // Rows at the head of the buffer currently being written; overflow never
  // drops them, so a successful write removes exactly what it wrote.
  let inFlight = 0;

  function schedule() {
    if (timer !== null || buffer.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushMs);
    timer.unref?.();
  }

  async function drain() {
    while (buffer.length > 0) {
      const batch = buffer.slice(0, maxBatch);
      inFlight = batch.length;
      try {
        await store.write(batch);
        buffer = buffer.slice(batch.length);
        failing = false;
      } catch (error) {
        failing = true;
        log({ event: "sherlock_excerpt_audit_write_failed", rows: batch.length, code: error?.code ?? null });
        schedule();
        return;
      } finally {
        inFlight = 0;
      }
    }
  }

  function flush() {
    flushing ??= drain().finally(() => { flushing = null; });
    return flushing;
  }

  return Object.freeze({
    push(rows) {
      if (rows.length === 0) return;
      buffer.push(...rows);
      if (buffer.length > maxBuffered) {
        const dropped = Math.min(buffer.length - maxBuffered, buffer.length - inFlight);
        buffer = [...buffer.slice(0, inFlight), ...buffer.slice(inFlight + dropped)];
        log({ event: "sherlock_excerpt_audit_dropped", rows: dropped });
      }
      // After a failed write, wait for the scheduled retry instead of
      // re-hitting the database on every read.
      if (buffer.length >= maxBatch && !failing) void flush();
      else schedule();
    },
    flush,
    async close() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await flush();
    },
    pending: () => buffer.length,
  });
}
