import { REQUEUE_SCM_BACKFILL_SQL } from "./requeue-scm-backfill.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("SCM replay is explicit, bounded, and fenced", () => {
  assert(
    REQUEUE_SCM_BACKFILL_SQL.includes("job.status in ('succeeded', 'failed')"),
  );
  assert(
    REQUEUE_SCM_BACKFILL_SQL.includes("record.native_type = 'session_meta'"),
  );
  assert(REQUEUE_SCM_BACKFILL_SQL.includes("limit $2"));
  assert(REQUEUE_SCM_BACKFILL_SQL.includes("for update skip locked"));
  assert(REQUEUE_SCM_BACKFILL_SQL.includes("telemetry.scm_projections"));
  assert(REQUEUE_SCM_BACKFILL_SQL.includes("sherlock.github-scm.v1"));
  assert(REQUEUE_SCM_BACKFILL_SQL.includes("workload_class = 'backfill'"));
  assert(!REQUEUE_SCM_BACKFILL_SQL.includes("delete"));
});
