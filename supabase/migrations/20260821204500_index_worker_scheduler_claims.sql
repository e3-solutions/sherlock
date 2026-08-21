-- Keep overload-mode normalize/reduce claims bounded without changing queue
-- facts or scheduling semantics. The existing workload/FIFO index remains for
-- unfiltered claims.
create index concurrently if not exists telemetry_jobs_kind_claim_idx
  on processing.telemetry_jobs (
    workload_class, job_kind, available_at, id
  ) where status = 'queued';

create index concurrently if not exists telemetry_jobs_kind_expired_lease_idx
  on processing.telemetry_jobs (
    workload_class, job_kind, lease_expires_at, id
  ) where status = 'leased';

create index concurrently if not exists telemetry_jobs_live_normalize_age_idx
  on processing.telemetry_jobs (created_at, id)
  where workload_class = 'live' and job_kind = 'normalize'
    and status in ('queued', 'leased');

comment on index processing.telemetry_jobs_kind_claim_idx is
  'Bounds FIFO overload-mode claims filtered by workload and job kind.';

comment on index processing.telemetry_jobs_kind_expired_lease_idx is
  'Bounds recovery of expired overload-mode leases by workload and job kind.';

comment on index processing.telemetry_jobs_live_normalize_age_idx is
  'Bounds oldest-live-normalization overload hysteresis checks.';

-- The predecessor anti-join intentionally reuses the immutable range key
-- created with telemetry.ingest_batches. Its equality prefix is
-- (workspace_id, collector_key, source_kind, source_stream_key,
-- generation_seq, generation_key), followed by the start_offset range.
-- Do not add a duplicate scheduler-specific ingest index. The queue
-- integration test proves the full claim plan avoids immutable-batch scans and
-- examines a bounded number of rows under a representative backlog; PostgreSQL
-- may satisfy that plan through the range key, the batch primary key, or the
-- normalize-job batch key depending on statistics.
