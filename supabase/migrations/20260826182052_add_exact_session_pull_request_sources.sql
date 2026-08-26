-- Immutable source facts for exact session-to-GitHub-PR links.
create schema if not exists github;
revoke all on schema github from public, anon, authenticated;

create table telemetry.session_scm (
  workspace_id uuid not null references telemetry.workspaces (id),
  source_record_id bigint not null,
  session_id uuid not null,
  source_version text not null,
  repository_full_name text not null,
  commit_sha text not null,
  observed_at timestamptz not null,
  server_received_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (source_record_id, source_version),
  foreign key (workspace_id, source_record_id)
    references telemetry.native_records (workspace_id, id),
  foreign key (workspace_id, session_id)
    references telemetry.sessions (workspace_id, id),
  check (btrim(source_version) <> ''),
  check (
    repository_full_name = lower(repository_full_name) and
    repository_full_name ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' and
    split_part(repository_full_name, '/', 1) not in ('.', '..') and
    split_part(repository_full_name, '/', 2) not in ('.', '..')
  ),
  check (commit_sha ~ '^[0-9a-f]{40}$')
);

create table github.commit_pr_lookups (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references telemetry.workspaces (id),
  source_version text not null,
  repository_full_name text not null,
  commit_sha text not null,
  outcome text not null check (
    outcome in ('matched', 'none', 'ambiguous', 'failed')
  ),
  pull_request_number integer,
  pull_request_terminal_at timestamptz,
  created_at timestamptz not null default now(),
  check (btrim(source_version) <> ''),
  check (
    repository_full_name = lower(repository_full_name) and
    repository_full_name ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' and
    split_part(repository_full_name, '/', 1) not in ('.', '..') and
    split_part(repository_full_name, '/', 2) not in ('.', '..')
  ),
  check (commit_sha ~ '^[0-9a-f]{40}$'),
  check (
    (outcome = 'matched' and pull_request_number is not null and
      pull_request_number > 0) or
    (outcome <> 'matched' and pull_request_number is null and
      pull_request_terminal_at is null)
  )
);

alter table processing.telemetry_jobs add column scm_backfill_version text
  check (scm_backfill_version is null or btrim(scm_backfill_version) <> '');

create index session_scm_recent_idx on telemetry.session_scm (
  created_at desc, workspace_id, repository_full_name, commit_sha
);
create index session_scm_session_idx on telemetry.session_scm (
  workspace_id, session_id
);
create index commit_pr_lookups_latest_idx on github.commit_pr_lookups (
  workspace_id, repository_full_name, commit_sha, id desc
);

revoke all on telemetry.session_scm, github.commit_pr_lookups
  from public, anon, authenticated, sherlock_ingest, sherlock_normalizer,
       sherlock_reducer, sherlock_processor, sherlock_frame_projector,
       sherlock_reader;
revoke all on sequence github.commit_pr_lookups_id_seq
  from public, anon, authenticated, sherlock_ingest, sherlock_normalizer,
       sherlock_reducer, sherlock_processor, sherlock_frame_projector,
       sherlock_reader;

grant insert on telemetry.session_scm to sherlock_normalizer;
grant select (source_record_id, source_version)
  on telemetry.session_scm to sherlock_normalizer;
grant usage on schema github to sherlock_processor, sherlock_reader;
grant select on telemetry.session_scm to sherlock_processor, sherlock_reader;
grant select, insert on github.commit_pr_lookups to sherlock_processor;
grant select on github.commit_pr_lookups to sherlock_reader;
grant usage, select on sequence github.commit_pr_lookups_id_seq
  to sherlock_processor;
grant select (id, workspace_id, batch_id, native_type)
  on telemetry.native_records to sherlock_processor;
grant select (source_provider, committed_at)
  on telemetry.ingest_batches to sherlock_processor;
grant select (
  workspace_id, session_id, source_record_id, normalizer_version, is_replay,
  server_received_at
) on telemetry.events to sherlock_processor;

alter default privileges in schema github
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema github
  revoke all on sequences from public, anon, authenticated;

comment on table telemetry.session_scm is
  'Append-only exact GitHub repository and commit facts from session metadata.';
comment on table github.commit_pr_lookups is
  'Append-only outcomes from exact GitHub commit-associated PR lookups.';
comment on column processing.telemetry_jobs.scm_backfill_version is
  'Latest session SCM source version explicitly scheduled for this normalization job.';
