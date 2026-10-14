# Dashboard telemetry delay: 2026-10-14

## Failure and evidence

The dashboard HTTP service stayed healthy while normalization fell behind.
At 21:33 UTC the public freshness receipt showed 5,151 pending live batches,
with the oldest pending batch from 18:48 UTC. Raw telemetry continued arriving.

The worker's ordered queue claim query was the bottleneck. Its production plan
estimated one pending job even though the queue contained thousands. PostgreSQL
inlined the pending-stream window calculation into a nested loop, repeatedly
scanning the retained queue and recomputing stream ranks. The control pool also
handles completion acknowledgements, so time spent selecting work inflated
reported job duration and delayed otherwise completed work.

The queue contained roughly 1.33 million retained rows. Default auto-analyze
thresholds were based on the entire table, allowing the small active subset to
change drastically without refreshing its estimates. No blocking database lock
was present in the sampled slow query; worker CPU and memory were below limits.

Refreshing statistics changed the estimated pending cardinality from one to
about 6,800 and switched the join to a hash join. A bounded, read-only candidate
probe under `sherlock_processor` then took 528 ms. With the new pending-job index
and materialized stream ranks, the same probe took 91 ms. These are individual
production samples, not p95 measurements. Before remediation, live worker logs
showed roughly 25–41 seconds per completion; immediately after the database
repair they showed roughly 0.6–0.9 seconds for sampled normalization jobs.

## Repair

- Materialize pending stream ranks once per claim. Preserve earliest-range
  ordering, cross-lane prerequisites, row locks, and lease fencing.
- Index only queued/leased normalization jobs, across both workload lanes.
  Completed job history remains available for auditing.
- Lower this table's auto-analyze trigger to 0.1% plus 100 changed rows.
- Refresh statistics when applying the migration.

The migration uses short lock and statement timeouts. It fails rather than
waiting indefinitely behind ingestion. Raw batches, events, and queue
classifications are neither deleted nor rewritten by this repair.

## Verification

The queue integration tests run the actual production query in rollback-only
probes with hash joins, merge joins, and optional materialization disabled.
Both normal and live-frontier claims must execute the window calculation once.
Removing the explicit materialization makes the regression test fail.

The existing tests also verify cross-lane prerequisites, concurrent claims,
stream ordering, retries, expired leases, and stale acknowledgement fencing.
The local checks used isolated PostgreSQL 17 with repository migrations; only
Supabase-specific cron/HTTP-extension setup was omitted from that local database.

For live recovery, check the worker deployment, completion durations, total and
live-normalization queue slopes, and the public freshness receipt. A successful
HTTP health check alone does not establish that telemetry has caught up. The
freshness receipt refreshes every two minutes; the chart refreshes on its
existing ten-minute schedule.

## References

- [PostgreSQL CTE materialization](https://www.postgresql.org/docs/17/queries-with.html#QUERIES-WITH-CTE-MATERIALIZATION)
- [PostgreSQL automatic analyze thresholds](https://www.postgresql.org/docs/17/runtime-config-autovacuum.html)
