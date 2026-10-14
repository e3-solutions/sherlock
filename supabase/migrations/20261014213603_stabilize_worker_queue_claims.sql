-- Fail promptly rather than queueing ingestion behind a migration lock.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- The queue retains completed jobs for auditing. Rank only the active subset,
-- regardless of workload lane, without scanning that retained history.
create index if not exists telemetry_jobs_pending_normalize_idx
  on processing.telemetry_jobs (id) include (workspace_id, batch_id)
  where job_kind = 'normalize' and status in ('queued', 'leased');

-- The active subset can grow from zero to thousands long before the default
-- table-wide analyze threshold is reached. Refresh estimates after about 0.1%
-- of rows change rather than waiting for 10% of retained queue history.
alter table processing.telemetry_jobs set (
  autovacuum_analyze_scale_factor = 0.001,
  autovacuum_analyze_threshold = 100
);

comment on index processing.telemetry_jobs_pending_normalize_idx is
  'Cross-lane active normalization jobs for bounded ordered-frontier claims; excludes retained audit history.';

analyze processing.telemetry_jobs;
