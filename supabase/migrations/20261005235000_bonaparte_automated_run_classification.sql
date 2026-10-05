-- Bonaparte origin annotations are auditable product metadata, never source edits.
create table analytics.bonaparte_run_classifications (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  session_id uuid not null,
  effective_start timestamptz not null,
  effective_end timestamptz not null,
  classification text not null check (classification in ('automated_run', 'default')),
  reason text not null check (length(reason) between 1 and 4096),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  request_reference text not null check (length(request_reference) between 1 and 512),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, session_id) references telemetry.sessions(workspace_id, id),
  check (effective_start < effective_end),
  unique (workspace_id, session_id, effective_start, effective_end, classification, evidence_sha256)
);
create index bonaparte_run_classification_lookup
  on analytics.bonaparte_run_classifications (workspace_id, session_id, id desc);
alter table analytics.bonaparte_run_classifications enable row level security;
revoke all on analytics.bonaparte_run_classifications from public, anon, authenticated;
grant select on analytics.bonaparte_run_classifications to sherlock_reader;
create policy bonaparte_run_classification_read on analytics.bonaparte_run_classifications
  for select to sherlock_reader using (true);
create function analytics.reject_bonaparte_classification_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'Bonaparte classifications are append-only'; end;
$$;
create trigger bonaparte_classification_immutable before update or delete
  on analytics.bonaparte_run_classifications for each row
  execute function analytics.reject_bonaparte_classification_mutation();
revoke all on function analytics.reject_bonaparte_classification_mutation() from public;

-- Historical drilldowns apply only revisions visible in the timeline snapshot.
-- Bounded source times leave subsequent genuine human intervention unclassified.
create function analytics.bonaparte_is_automated_run(
  target_workspace uuid, target_session uuid, observed timestamptz,
  visible_snapshot pg_snapshot default null
) returns boolean language sql stable security invoker set search_path = '' as $$
  select coalesce((
    select classification = 'automated_run'
      from analytics.bonaparte_run_classifications c
     where c.workspace_id = target_workspace and c.session_id = target_session
       and observed >= c.effective_start and observed < c.effective_end
       and (visible_snapshot is null or pg_visible_in_snapshot(c.xmin::text::xid8, visible_snapshot))
     order by c.id desc limit 1
  ), false)
$$;
revoke all on function analytics.bonaparte_is_automated_run(uuid, uuid, timestamptz, pg_snapshot) from public;
grant execute on function analytics.bonaparte_is_automated_run(uuid, uuid, timestamptz, pg_snapshot) to sherlock_reader;
comment on table analytics.bonaparte_run_classifications is
  'Append-only Bonaparte origin annotations. Automated runs remain included in activity and usage; only human prompt views are excluded. Append default to reverse a classification.';
