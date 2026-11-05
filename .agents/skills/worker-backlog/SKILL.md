---
name: worker-backlog
description: Diagnose and recover a Sherlock processing backlog, where the telemetry-processor queue is behind, jobs are failing or stuck, statement timeouts are rising, or the dashboard and Sesh show stale data, using the queue tables, worker logs and connection budget, without bypassing the worker's safety gates. Use for "dashboard is behind", "jobs failing", "worker stalled", or capacity alerts.
---

# Worker backlog

Worker contract (leases, pools, watchdog, connection budget):
`workers/telemetry-processor/README.md`. Queue queries:
`docs/telemetry-processing.md` "Inspect and recover". The 2026-10-14 incident and
its fix: `docs/dashboard-queue-recovery.md`.

## Rules

- A backlog is durable work, not a reason to skip the gates. Do not raise
  concurrency, pool sizes or replicas without a measured load test.
- Do not restart or replace the worker unless there are zero blocked waiters and
  the new sessions fit within 80% of `max_connections`.
- Read-only by default. Retrying a failed job is a production write. Retry one
  reviewed job at a time, with a yes, and check that exactly one row changed.
- Quiet hours (03:00–19:00 UTC): no large scans. Use the indexed queue queries
  below with a short `statement_timeout`.

## Steps

1. **Size the backlog**, read-only:

   ```sql
   set statement_timeout = '5s';
   select workload_class, job_kind, status, count(*) as jobs,
          min(available_at) as oldest_available
   from processing.telemetry_jobs
   group by workload_class, job_kind, status
   order by workload_class, job_kind, status;
   ```

   Live lag pauses new backfill claims on purpose (overload mode).
2. **Failed jobs:** list them with `last_error_code`, `last_error` and
   `attempt_count` (query in `docs/telemetry-processing.md`). Group by error code
   before acting. Jobs requeued dozens of times are a cause, not a symptom.
3. **Worker health** in the Railway logs of `telemetry-processor`:
   - `worker_progress_stalled`: a control query was wedged for 60 s and the worker exited on purpose.
   - PostgreSQL `53300` or `EMAX*`: the capacity circuit opened.
   - Statement timeouts for `sherlock_worker_login`.
   - Railway can show `SUCCESS` while the worker makes no progress, so trust the queue numbers.
4. **Database pressure:** stale planner statistics on the large tables and missing
   indexes were the 2026-10-14 root cause. The fix there was refreshing statistics
   and a targeted index, done as a migration in the allowed window (`db-migration` skill).
5. **Recover**, with a yes: retry one reviewed failed job with the guarded `update`
   in `docs/telemetry-processing.md` (it keeps the error history). Or restart
   the worker through a Railway redeploy of its running deployment, after the
   connection check.

## Report

Backlog by class, kind and status before and after; the top error codes; the cause
with evidence; actions taken (job ids, deployment ids); and remaining risk.
