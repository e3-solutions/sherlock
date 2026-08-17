create schema if not exists processing;

revoke all on schema processing from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_roles where rolname = 'sherlock_processor'
  ) then
    create role sherlock_processor nologin;
  end if;
  if not exists (
    select 1 from pg_roles where rolname = 'sherlock_worker_login'
  ) then
    create role sherlock_worker_login login noinherit;
  end if;
end
$$;
-- This is an immutable ingest fact supplied by the transport, not part of the
-- batch body. Null preserves compatibility with already-deployed collectors.
alter table telemetry.ingest_batches
  add column processing_class_hint text;

alter table telemetry.ingest_batches
  add constraint ingest_batches_processing_class_hint_check
  check (processing_class_hint is null or processing_class_hint in ('live', 'backfill'));

create table processing.telemetry_jobs (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  job_kind text not null,
  batch_id uuid,
  session_id uuid,
  normalizer_version text,
  activity_version text,
  target_event_id bigint,
  request_generation bigint,
  workload_class text not null,
  status text not null default 'queued',
  available_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  attempt_limit integer not null default 8,
  lease_token uuid,
  lease_owner text,
  lease_started_at timestamptz,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error text,
  last_failed_at timestamptz,
  requeue_count integer not null default 0,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telemetry_jobs_batch_fkey foreign key (workspace_id, batch_id)
    references telemetry.ingest_batches (workspace_id, id),
  constraint telemetry_jobs_session_fkey foreign key (workspace_id, session_id)
    references telemetry.sessions (workspace_id, id),
  constraint telemetry_jobs_kind_check check (
    job_kind in ('normalize', 'reduce')
  ),
  constraint telemetry_jobs_target_shape_check check (
    (
      job_kind = 'normalize' and batch_id is not null and session_id is null
      and normalizer_version is null and activity_version is null
      and target_event_id is null and request_generation is null
    ) or (
      job_kind = 'reduce' and batch_id is null and session_id is not null
      and normalizer_version is not null and activity_version is not null
      and target_event_id is not null and target_event_id > 0
      and request_generation is not null and request_generation > 0
    )
  ),
  constraint telemetry_jobs_workload_class_check check (
    workload_class in ('live', 'backfill')
  ),
  constraint telemetry_jobs_status_check check (
    status in ('queued', 'leased', 'succeeded', 'failed')
  ),
  constraint telemetry_jobs_attempts_check check (
    attempt_count >= 0 and attempt_limit > 0 and requeue_count >= 0
  ),
  constraint telemetry_jobs_lease_shape_check check (
    (status = 'leased') = (
      lease_token is not null and lease_owner is not null and
      lease_started_at is not null and lease_expires_at is not null
    )
  ),
  constraint telemetry_jobs_completion_shape_check check (
    (status in ('succeeded', 'failed')) = (completed_at is not null)
  ),
  constraint telemetry_jobs_error_size_check check (
    last_error is null or octet_length(last_error) <= 1024
  )
);

create unique index telemetry_jobs_batch_key
  on processing.telemetry_jobs (workspace_id, batch_id)
  where job_kind = 'normalize';

create unique index telemetry_jobs_session_key
  on processing.telemetry_jobs (
    workspace_id, session_id, normalizer_version, activity_version
  ) where job_kind = 'reduce';

create index telemetry_jobs_claim_idx
  on processing.telemetry_jobs (workload_class, available_at, id)
  where status = 'queued';

create index telemetry_jobs_lease_expiry_idx
  on processing.telemetry_jobs (lease_expires_at, id)
  where status = 'leased';

create index telemetry_jobs_terminal_idx
  on processing.telemetry_jobs (status, completed_at desc, id desc)
  where status in ('failed', 'succeeded');

create or replace function processing.enqueue_telemetry_job()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, processing
as $$
begin
  insert into processing.telemetry_jobs (
    workspace_id,
    job_kind,
    batch_id,
    workload_class
  ) values (
    new.workspace_id,
    'normalize',
    new.id,
    coalesce(
      new.processing_class_hint,
      case
        when new.last_occurred_at is not null
          and new.last_occurred_at < new.committed_at - interval '24 hours'
        then 'backfill'
        else 'live'
      end
    )
  ) on conflict (workspace_id, batch_id)
    where job_kind = 'normalize' do nothing;
  return new;
end
$$;

revoke all on function processing.enqueue_telemetry_job() from public;

insert into processing.telemetry_jobs (
  workspace_id,
  job_kind,
  batch_id,
  workload_class
)
select
  workspace_id,
  'normalize',
  id,
  coalesce(
    processing_class_hint,
    case
      when last_occurred_at is not null
        and last_occurred_at < committed_at - interval '24 hours'
      then 'backfill'
      else 'live'
    end
  )
from telemetry.ingest_batches
on conflict (workspace_id, batch_id)
  where job_kind = 'normalize' do nothing;

create trigger ingest_batches_enqueue_processing
after insert on telemetry.ingest_batches
for each row execute function processing.enqueue_telemetry_job();

revoke all on all tables in schema processing
  from public, anon, authenticated;
revoke all on all sequences in schema processing
  from public, anon, authenticated;
revoke all on schema processing from sherlock_processor;
revoke all on all tables in schema processing from sherlock_processor;
revoke all on all sequences in schema processing from sherlock_processor;

grant usage on schema processing to sherlock_processor;
grant select, insert, update on processing.telemetry_jobs to sherlock_processor;
grant usage, select on sequence processing.telemetry_jobs_id_seq
  to sherlock_processor;
grant sherlock_processor to postgres;
grant sherlock_processor, sherlock_normalizer, sherlock_reducer
  to sherlock_worker_login;

alter default privileges in schema processing
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema processing
  revoke all on sequences from public, anon, authenticated;

comment on schema processing is
  'Private mutable operational state; immutable source facts remain in telemetry.';
comment on table processing.telemetry_jobs is
  'Durable fenced normalization queue and coalesced targeted reduction queue.';
comment on column processing.telemetry_jobs.workload_class is
  'Live and historical lanes are scheduled independently so backfill cannot starve live ingestion.';
comment on column telemetry.ingest_batches.processing_class_hint is
  'Immutable transport scheduling fact; null means legacy timestamp classification.';

-- Production may already contain the superseded scheduled reducer migration.
-- Stop the full-workspace scan without removing its audit history or extensions.
do $$
declare
  reducer_job_id bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    for reducer_job_id in
      select jobid
      from cron.job
      where jobname = 'sherlock-activity-reducer-every-minute'
    loop
      perform cron.unschedule(reducer_job_id);
    end loop;
  end if;
end
$$;
