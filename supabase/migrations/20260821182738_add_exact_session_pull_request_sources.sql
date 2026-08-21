-- COR-3759: auditable, append-only exact commit to pull-request source facts.
create schema if not exists github;

revoke all on schema github from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sherlock_github_sync') then
    create role sherlock_github_sync nologin;
  end if;
end
$$;

create table telemetry.scm_projections (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references telemetry.workspaces (id),
  source_record_id bigint not null,
  scm_version text not null,
  projection_status text not null,
  session_id uuid,
  repository_full_name text,
  commit_sha text,
  observed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint scm_projections_source_version_key unique (source_record_id, scm_version),
  constraint scm_projections_workspace_id_id_key unique (workspace_id, id),
  constraint scm_projections_source_record_fkey foreign key (workspace_id, source_record_id)
    references telemetry.native_records (workspace_id, id),
  constraint scm_projections_session_fkey foreign key (workspace_id, session_id)
    references telemetry.sessions (workspace_id, id),
  constraint scm_projections_version_nonempty check (btrim(scm_version) <> ''),
  constraint scm_projections_status_check check (
    projection_status in ('matched', 'no_match')
  ),
  constraint scm_projections_shape_check check (
    (
      projection_status = 'matched' and session_id is not null and
      repository_full_name is not null and commit_sha is not null and
      observed_at is not null
    ) or (
      projection_status = 'no_match' and session_id is null and
      repository_full_name is null and commit_sha is null and observed_at is null
    )
  ),
  constraint scm_projections_repository_shape_check check (
    repository_full_name is null or (
      repository_full_name = lower(repository_full_name) and
      repository_full_name ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' and
      split_part(repository_full_name, '/', 1) not in ('.', '..') and
      split_part(repository_full_name, '/', 2) not in ('.', '..')
    )
  ),
  constraint scm_projections_commit_sha_check check (
    commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'
  )
);

create table github.commit_pull_attempts (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references telemetry.workspaces (id),
  lookup_version text not null,
  api_version text not null,
  repository_full_name text not null,
  commit_sha text not null,
  outcome text not null,
  github_repository_id bigint,
  response_sha256 text,
  candidate_count integer,
  error_code text,
  http_status integer,
  retry_after timestamptz,
  created_at timestamptz not null default now(),
  constraint commit_pull_attempts_scope_key unique (
    workspace_id, id, github_repository_id
  ),
  constraint commit_pull_attempts_version_nonempty check (
    btrim(lookup_version) <> '' and btrim(api_version) <> ''
  ),
  constraint commit_pull_attempts_repository_shape_check check (
    repository_full_name = lower(repository_full_name) and
    repository_full_name ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' and
    split_part(repository_full_name, '/', 1) not in ('.', '..') and
    split_part(repository_full_name, '/', 2) not in ('.', '..')
  ),
  constraint commit_pull_attempts_repository_id_check check (
    github_repository_id is null or github_repository_id > 0
  ),
  constraint commit_pull_attempts_commit_sha_check check (
    commit_sha ~ '^[0-9a-f]{40}$'
  ),
  constraint commit_pull_attempts_outcome_check check (
    outcome in ('complete', 'failed')
  ),
  constraint commit_pull_attempts_response_sha256_check check (
    response_sha256 is null or response_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint commit_pull_attempts_candidate_count_check check (
    candidate_count is null or candidate_count between 0 and 100
  ),
  constraint commit_pull_attempts_http_status_check check (
    http_status is null or http_status between 100 and 599
  ),
  constraint commit_pull_attempts_error_size_check check (
    error_code is null or (btrim(error_code) <> '' and octet_length(error_code) <= 128)
  ),
  constraint commit_pull_attempts_outcome_shape_check check (
    (
      outcome = 'complete' and response_sha256 is not null and
      candidate_count is not null and error_code is null and
      http_status is null and retry_after is null and
      (candidate_count = 0 or github_repository_id is not null)
    ) or (
      outcome = 'failed' and response_sha256 is null and
      candidate_count is null and github_repository_id is null and
      error_code is not null
    )
  )
);

create table github.commit_pull_candidates (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  attempt_id bigint not null,
  github_repository_id bigint not null,
  github_pull_request_id bigint not null,
  pull_request_number integer not null,
  state text not null,
  pull_request_created_at timestamptz not null,
  pull_request_closed_at timestamptz,
  pull_request_merged_at timestamptz,
  created_at timestamptz not null default now(),
  constraint commit_pull_candidates_attempt_key unique (attempt_id, github_pull_request_id),
  constraint commit_pull_candidates_number_key unique (attempt_id, pull_request_number),
  constraint commit_pull_candidates_attempt_fkey foreign key (
    workspace_id, attempt_id, github_repository_id
  ) references github.commit_pull_attempts (
    workspace_id, id, github_repository_id
  ),
  constraint commit_pull_candidates_repository_id_check check (github_repository_id > 0),
  constraint commit_pull_candidates_pull_request_id_check check (github_pull_request_id > 0),
  constraint commit_pull_candidates_pull_request_number_check check (pull_request_number > 0),
  constraint commit_pull_candidates_state_check check (state in ('open', 'closed')),
  constraint commit_pull_candidates_closed_shape_check check (
    (state = 'open' and pull_request_closed_at is null and pull_request_merged_at is null) or
    (state = 'closed' and pull_request_closed_at is not null)
  ),
  constraint commit_pull_candidates_time_order_check check (
    (pull_request_closed_at is null or pull_request_closed_at >= pull_request_created_at) and
    (pull_request_merged_at is null or (
      pull_request_merged_at >= pull_request_created_at and
      pull_request_closed_at is not null and
      pull_request_merged_at <= pull_request_closed_at
    ))
  )
);

create index scm_projections_session_idx
  on telemetry.scm_projections (workspace_id, session_id, observed_at, id desc)
  include (repository_full_name, commit_sha, scm_version)
  where projection_status = 'matched';
create index scm_projections_lookup_idx
  on telemetry.scm_projections (
    workspace_id, repository_full_name, commit_sha, observed_at desc, id desc
  ) include (session_id)
  where projection_status = 'matched' and
        scm_version = 'sherlock.github-scm.v1';
create index commit_pull_attempts_lookup_idx
  on github.commit_pull_attempts (
    workspace_id, repository_full_name, commit_sha, id desc
  ) include (
    lookup_version, api_version, outcome, github_repository_id,
    candidate_count, retry_after, created_at
  );

revoke all on telemetry.scm_projections,
  github.commit_pull_attempts, github.commit_pull_candidates
  from public, anon, authenticated, sherlock_ingest, sherlock_normalizer,
       sherlock_reducer, sherlock_processor, sherlock_frame_projector,
       sherlock_reader, sherlock_github_sync;
revoke all on sequence telemetry.scm_projections_id_seq,
  github.commit_pull_attempts_id_seq, github.commit_pull_candidates_id_seq
  from public, anon, authenticated, sherlock_ingest, sherlock_normalizer,
       sherlock_reducer, sherlock_processor, sherlock_frame_projector,
       sherlock_reader, sherlock_github_sync;

grant insert on telemetry.scm_projections to sherlock_normalizer;
grant select (source_record_id, scm_version)
  on telemetry.scm_projections to sherlock_normalizer;
grant usage, select on sequence telemetry.scm_projections_id_seq to sherlock_normalizer;

grant usage on schema telemetry, github to sherlock_github_sync;
grant select on telemetry.scm_projections to sherlock_github_sync;
grant select, insert on github.commit_pull_attempts to sherlock_github_sync;
grant insert on github.commit_pull_candidates to sherlock_github_sync;
grant usage, select on sequence github.commit_pull_attempts_id_seq,
  github.commit_pull_candidates_id_seq to sherlock_github_sync;

grant usage on schema github to sherlock_reader;
grant select on telemetry.scm_projections,
  github.commit_pull_attempts, github.commit_pull_candidates to sherlock_reader;

grant sherlock_github_sync to postgres, sherlock_worker_login;

-- The existing fenced queue owns bounded administrative replay. These narrow
-- column grants find historical session metadata missing this projector version.
grant select (workspace_id, id, batch_id, native_type)
  on telemetry.native_records to sherlock_processor;
grant select (workspace_id, source_record_id, scm_version)
  on telemetry.scm_projections to sherlock_processor;

alter default privileges in schema github
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema github
  revoke all on sequences from public, anon, authenticated;

comment on schema github is
  'Private immutable GitHub lookup attempts and selected response facts.';
comment on table telemetry.scm_projections is
  'Append-only outcome for each versioned attempt to project SCM identity from native session metadata.';
comment on table github.commit_pull_attempts is
  'Append-only complete or failed exact commit-associated pull-request lookup attempts.';
comment on table github.commit_pull_candidates is
  'Validated pull-request candidates returned by one complete lookup attempt.';
comment on role sherlock_github_sync is
  'Insert-only GitHub source sync: reads matched SCM projections and appends lookup attempts and candidates.';
