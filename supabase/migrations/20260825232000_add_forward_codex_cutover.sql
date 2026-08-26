-- COR-3843: keep Codex v2 forward-only. The cutover is an immutable derived
-- fact; raw telemetry and existing v1/v2 events remain append-only.
create table analytics.normalizer_cutovers (
  workspace_id uuid not null references telemetry.workspaces (id) on delete cascade,
  source_provider text not null,
  from_normalizer_version text not null,
  to_normalizer_version text not null,
  cutover_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint normalizer_cutovers_pkey primary key (
    workspace_id, source_provider, to_normalizer_version
  ),
  constraint normalizer_cutovers_provider_check check (
    source_provider in ('codex', 'claude_code')
  ),
  constraint normalizer_cutovers_versions_check check (
    btrim(from_normalizer_version) <> ''
    and btrim(to_normalizer_version) <> ''
    and from_normalizer_version <> to_normalizer_version
  )
);

-- The first v2 job is the auditable operational boundary already introduced
-- by COR-3839. Historical batches queued later cannot move this boundary.
insert into analytics.normalizer_cutovers (
  workspace_id, source_provider, from_normalizer_version,
  to_normalizer_version, cutover_at
)
select workspace.id, 'codex', 'sherlock.codex-rollout.v1',
       'sherlock.codex-rollout.v2',
       coalesce(min(job.created_at), statement_timestamp())
  from telemetry.workspaces workspace
  left join processing.telemetry_jobs job
    on job.workspace_id = workspace.id
   and job.job_kind = 'normalize'
   and job.normalizer_version = 'sherlock.codex-rollout.v2'
 group by workspace.id;

create function analytics.record_codex_cutover_for_workspace()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, analytics
as $$
begin
  insert into analytics.normalizer_cutovers (
    workspace_id, source_provider, from_normalizer_version,
    to_normalizer_version, cutover_at
  ) values (
    new.id, 'codex', 'sherlock.codex-rollout.v1',
    'sherlock.codex-rollout.v2', new.created_at
  );
  return new;
end
$$;

create trigger record_codex_cutover_for_workspace
after insert on telemetry.workspaces
for each row execute function analytics.record_codex_cutover_for_workspace();

-- New batches follow the session boundary. Existing pre-cutover sessions stay
-- on v1; sessions beginning at/after the cutover use v2. If a session has not
-- been projected yet, the immutable batch time supplies the same decision.
create or replace function processing.enqueue_telemetry_job()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, processing
as $$
declare
  target_normalizer_version text;
  codex_cutover_at timestamptz;
  native_session_started_at timestamptz;
begin
  if new.source_provider = 'claude_code' then
    target_normalizer_version := 'sherlock.claude-code-transcript.v1';
  else
    select cutover.cutover_at
      into codex_cutover_at
      from analytics.normalizer_cutovers cutover
     where cutover.workspace_id = new.workspace_id
       and cutover.source_provider = 'codex'
       and cutover.to_normalizer_version = 'sherlock.codex-rollout.v2';

    select session.started_at
      into native_session_started_at
      from telemetry.sessions session
     where session.workspace_id = new.workspace_id
       and session.collector_key = new.collector_key
       and session.native_session_id = new.observed_native_session_id;

    target_normalizer_version := case
      when codex_cutover_at is not null
       and coalesce(
         native_session_started_at,
         new.first_occurred_at,
         new.committed_at
       ) < codex_cutover_at
      then 'sherlock.codex-rollout.v1'
      else 'sherlock.codex-rollout.v2'
    end;
  end if;

  insert into processing.telemetry_jobs (
    workspace_id, job_kind, batch_id, normalizer_version, workload_class
  ) values (
    new.workspace_id, 'normalize', new.id, target_normalizer_version,
    coalesce(
      new.processing_class_hint,
      case
        when new.last_occurred_at is not null
          and new.last_occurred_at < new.committed_at - interval '24 hours'
        then 'backfill'
        else 'live'
      end
    )
  ) on conflict (workspace_id, batch_id, normalizer_version)
    where job_kind = 'normalize' do nothing;
  return new;
end
$$;

revoke all on analytics.normalizer_cutovers from public, anon, authenticated;
grant select on analytics.normalizer_cutovers
  to sherlock_frame_projector, sherlock_reader;
grant select (source_provider) on telemetry.ingest_batches
  to sherlock_frame_projector;

comment on table analytics.normalizer_cutovers is
  'Append-only source-version boundary. Sessions before cutover_at prefer from_normalizer_version; later sessions use to_normalizer_version.';
comment on column analytics.normalizer_cutovers.cutover_at is
  'Immutable session-start boundary; it never requests historical normalization.';
