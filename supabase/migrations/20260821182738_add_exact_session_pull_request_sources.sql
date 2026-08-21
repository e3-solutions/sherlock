-- COR-3759: immutable facts used to link a session to one exact GitHub PR.
create schema if not exists github;

revoke all on schema github from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sherlock_github_sync') then
    create role sherlock_github_sync nologin;
  end if;
end
$$;

create table telemetry.session_scm (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references telemetry.workspaces (id),
  source_record_id bigint not null,
  session_id uuid not null,
  source_version text not null,
  repository_full_name text not null,
  commit_sha text not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (source_record_id, source_version),
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
  outcome text not null,
  candidate_count integer,
  pull_request_number integer,
  pull_request_terminal_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  check (btrim(source_version) <> ''),
  check (
    repository_full_name = lower(repository_full_name) and
    repository_full_name ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' and
    split_part(repository_full_name, '/', 1) not in ('.', '..') and
    split_part(repository_full_name, '/', 2) not in ('.', '..')
  ),
  check (commit_sha ~ '^[0-9a-f]{40}$'),
  check (outcome in ('matched', 'none', 'ambiguous', 'failed')),
  check (
    (outcome = 'matched' and candidate_count is not null and
      candidate_count = 1 and pull_request_number is not null and
      pull_request_number > 0 and error_code is null) or
    (outcome = 'none' and candidate_count is not null and candidate_count = 0 and
      pull_request_number is null and pull_request_terminal_at is null and
      error_code is null) or
    (outcome = 'ambiguous' and candidate_count is not null and
      candidate_count between 2 and 100 and
      pull_request_number is null and pull_request_terminal_at is null and
      error_code is null) or
    (outcome = 'failed' and candidate_count is null and
      pull_request_number is null and pull_request_terminal_at is null and
      error_code is not null and btrim(error_code) <> '' and
      octet_length(error_code) <= 128)
  )
);

create index session_scm_lookup_idx on telemetry.session_scm (
  workspace_id, repository_full_name, commit_sha, observed_at desc
);
create index session_scm_session_idx on telemetry.session_scm (
  workspace_id, session_id, id desc
);
create index commit_pr_lookups_latest_idx on github.commit_pr_lookups (
  workspace_id, repository_full_name, commit_sha, id desc
);

revoke all on telemetry.session_scm, github.commit_pr_lookups
  from public, anon, authenticated, sherlock_ingest, sherlock_normalizer,
       sherlock_reducer, sherlock_processor, sherlock_frame_projector,
       sherlock_reader, sherlock_github_sync;
revoke all on sequence telemetry.session_scm_id_seq,
  github.commit_pr_lookups_id_seq
  from public, anon, authenticated, sherlock_ingest, sherlock_normalizer,
       sherlock_reducer, sherlock_processor, sherlock_frame_projector,
       sherlock_reader, sherlock_github_sync;

grant insert on telemetry.session_scm to sherlock_normalizer;
grant select (source_record_id, source_version)
  on telemetry.session_scm to sherlock_normalizer;
grant usage, select on sequence telemetry.session_scm_id_seq
  to sherlock_normalizer;

grant usage on schema telemetry, github to sherlock_github_sync;
grant select on telemetry.session_scm to sherlock_github_sync;
grant select, insert on github.commit_pr_lookups to sherlock_github_sync;
grant usage, select on sequence github.commit_pr_lookups_id_seq
  to sherlock_github_sync;

grant usage on schema github to sherlock_reader;
grant select on telemetry.session_scm, github.commit_pr_lookups
  to sherlock_reader;

grant sherlock_github_sync to postgres, sherlock_worker_login;

alter default privileges in schema github
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema github
  revoke all on sequences from public, anon, authenticated;

comment on table telemetry.session_scm is
  'Append-only exact GitHub repository and commit facts from session metadata.';
comment on table github.commit_pr_lookups is
  'Append-only outcomes from exact GitHub commit-associated PR lookups.';
