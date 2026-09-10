-- Declared context is an auditable collector report, not authenticated authorship.
-- No session FK: sidecars may arrive before native session normalization.
create table telemetry.session_pr_context_events (
  source_record_id bigint primary key,
  workspace_id uuid not null references telemetry.workspaces(id),
  person_id uuid not null,
  collector_key text not null,
  source_provider text not null check (source_provider in ('codex', 'claude_code')),
  native_session_id text not null check (length(native_session_id) between 1 and 512),
  event_id uuid not null,
  operation text not null check (operation in ('link', 'retract')),
  link_event_id uuid,
  repository_full_name text,
  pull_request_number integer,
  occurred_at timestamptz not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  disposition text not null check (disposition in ('accepted', 'duplicate', 'conflict')),
  server_received_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, source_record_id),
  foreign key (workspace_id, source_record_id) references telemetry.native_records(workspace_id, id),
  foreign key (workspace_id, person_id) references telemetry.people(workspace_id, id),
  check ((operation = 'link' and link_event_id is null and repository_full_name is not null
      and repository_full_name = lower(repository_full_name)
      and repository_full_name ~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9_.-]{1,100}$'
      and split_part(repository_full_name, '/', 2) not in ('.', '..')
      and pull_request_number is not null and pull_request_number > 0)
    or (operation = 'retract' and link_event_id is not null and link_event_id <> event_id
      and repository_full_name is null and pull_request_number is null))
);
create unique index session_pr_context_accepted_event_idx on telemetry.session_pr_context_events
  (workspace_id, collector_key, event_id) where disposition = 'accepted';
create index session_pr_context_identity_idx on telemetry.session_pr_context_events
  (workspace_id, collector_key, native_session_id, source_provider, source_record_id);
create index session_pr_context_event_idx on telemetry.session_pr_context_events
  (workspace_id, collector_key, event_id, disposition);
create index session_pr_context_retract_idx on telemetry.session_pr_context_events
  (workspace_id, collector_key, link_event_id) where operation = 'retract';

create table github.pr_context_verifications (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  link_source_record_id bigint not null,
  outcome text not null check (outcome in ('checked', 'inaccessible', 'failed', 'identity_mismatch', 'out_of_scope')),
  repository_full_name text,
  repository_id bigint,
  pull_request_number integer,
  pull_request_id bigint,
  pull_request_state text check (pull_request_state in ('open', 'closed', 'merged')),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, link_source_record_id)
    references telemetry.session_pr_context_events(workspace_id, source_record_id),
  check ((outcome = 'checked' and repository_full_name is not null and repository_id is not null and repository_id > 0
    and pull_request_number is not null and pull_request_number > 0 and pull_request_id is not null and pull_request_id > 0 and pull_request_state is not null)
    or (outcome <> 'checked' and repository_full_name is null and repository_id is null
      and pull_request_number is null and pull_request_id is null and pull_request_state is null))
);
create index pr_context_verifications_latest_idx on github.pr_context_verifications
  (workspace_id, link_source_record_id, id desc);

revoke all on telemetry.session_pr_context_events, github.pr_context_verifications
  from public, anon, authenticated, sherlock_ingest, sherlock_normalizer,
       sherlock_reducer, sherlock_processor, sherlock_frame_projector, sherlock_reader;
revoke all on sequence github.pr_context_verifications_id_seq from public, anon, authenticated;
grant select, insert on telemetry.session_pr_context_events to sherlock_normalizer;
grant select on telemetry.session_pr_context_events to sherlock_processor, sherlock_reader;
grant select, insert on github.pr_context_verifications to sherlock_processor;
grant select on github.pr_context_verifications to sherlock_reader;
grant usage, select on sequence github.pr_context_verifications_id_seq to sherlock_processor;

-- Retain the legacy uniqueness key for old-worker compatibility. Refuse a
-- cross-provider collision before it mutates a session, including old writers.
create function telemetry.guard_session_provider_collision() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if split_part(old.role_version, '.', 2) <> split_part(new.role_version, '.', 2) then
    raise exception 'native_session_provider_conflict' using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function telemetry.guard_session_provider_collision() from public, anon, authenticated;
create trigger guard_session_provider_collision before update of role_version on telemetry.sessions
  for each row execute function telemetry.guard_session_provider_collision();

comment on table telemetry.session_pr_context_events is
  'Append-only collector-reported link/retract facts; identity is not authenticated. Duplicate/conflict deliveries retain native source provenance. Conflicting event IDs invalidate their visible association; a conflicting retraction remains a suppression so a correction never resurrects a link.';
comment on table github.pr_context_verifications is
  'Append-only GitHub PR identity observations. Checks neither prove uploader identity nor allocate activity, time, tokens or authorship.';

-- Native jobs keep their existing forward-only version selection.
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
  if new.source_kind = 'collector' then
    target_normalizer_version := 'sherlock.pr-context.v1';
  elsif new.source_provider = 'claude_code' then
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

