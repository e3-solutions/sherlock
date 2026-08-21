create schema if not exists product;
revoke all on schema product from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sherlock_bottleneck_writer') then
    create role sherlock_bottleneck_writer
      nologin noinherit nosuperuser nocreatedb nocreaterole noreplication
      nobypassrls connection limit 0;
  end if;
end
$$;
alter role sherlock_bottleneck_writer
  nologin noinherit nocreatedb nocreaterole connection limit 0;
alter role sherlock_worker_login
  login noinherit nocreatedb nocreaterole;
do $$
begin
  if exists (
    select 1 from pg_roles
     where rolname in ('sherlock_bottleneck_writer', 'sherlock_worker_login')
       and (rolsuper or rolreplication or rolbypassrls)
  ) then
    raise exception 'Sherlock worker or bottleneck writer has protected unsafe attributes';
  end if;
end
$$;
do $$
declare
  inherited_role name;
begin
  for inherited_role in
    select granted.rolname
      from pg_auth_members as membership
      join pg_roles as member on member.oid = membership.member
      join pg_roles as granted on granted.oid = membership.roleid
     where member.rolname = 'sherlock_bottleneck_writer'
  loop
    execute format(
      'revoke %I from sherlock_bottleneck_writer', inherited_role
    );
  end loop;
end
$$;
do $$
declare
  inbound_member name;
begin
  -- Supabase PostgreSQL 17 creates this exact non-SET-capable administrative
  -- edge for managed roles. It cannot assume the writer and is the only
  -- platform edge retained; the worker grant is established below.
  for inbound_member in
    select member.rolname
      from pg_auth_members as membership
      join pg_roles as granted on granted.oid = membership.roleid
      join pg_roles as member on member.oid = membership.member
      join pg_roles as grantor on grantor.oid = membership.grantor
     where granted.rolname = 'sherlock_bottleneck_writer'
       and not (
         member.rolname = 'postgres'
         and grantor.rolname = 'supabase_admin'
         and membership.admin_option
         and not membership.inherit_option
         and not membership.set_option
       )
  loop
    execute format(
      'revoke sherlock_bottleneck_writer from %I', inbound_member
    );
  end loop;
  if exists (
    select 1
      from pg_auth_members as membership
      join pg_roles as granted on granted.oid = membership.roleid
      join pg_roles as member on member.oid = membership.member
      join pg_roles as grantor on grantor.oid = membership.grantor
     where granted.rolname = 'sherlock_bottleneck_writer'
       and not (
         member.rolname = 'postgres'
         and grantor.rolname = 'supabase_admin'
         and membership.admin_option
         and not membership.inherit_option
         and not membership.set_option
       )
  ) then
    raise exception 'unauthorized inbound bottleneck writer membership remains';
  end if;
end
$$;

create table product.bottleneck_reports (
  id bigint generated always as identity,
  workspace_id uuid not null references telemetry.workspaces(id),
  submission_id uuid not null,
  request_sha256 text not null
    constraint bottleneck_reports_request_sha256_check
    check (request_sha256 ~ '^[0-9a-f]{64}$'),
  scope_snapshot_token text not null
    constraint bottleneck_reports_scope_snapshot_token_check
    check (octet_length(scope_snapshot_token) between 1 and 8192),
  scope_window_start timestamptz not null,
  scope_window_end timestamptz not null,
  scope_read_at timestamptz not null,
  scope_completeness text not null
    constraint bottleneck_reports_scope_completeness_check
    check (scope_completeness = 'agent_declared_complete'),
  candidate_count smallint not null
    constraint bottleneck_reports_candidate_count_check
    check (candidate_count between 0 and 50),
  attribution_mode text generated always as ('workspace_shared_bearer'::text) stored,
  trust text generated always as ('untrusted_agent_generated_claim'::text) stored,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (id),
  unique (workspace_id, id),
  unique (workspace_id, submission_id),
  constraint bottleneck_reports_id_positive_check
    check (id > 0),
  constraint bottleneck_reports_scope_window_start_finite_check
    check (isfinite(scope_window_start)),
  constraint bottleneck_reports_scope_window_end_finite_check
    check (isfinite(scope_window_end)),
  constraint bottleneck_reports_scope_read_at_finite_check
    check (isfinite(scope_read_at)),
  constraint bottleneck_reports_created_at_finite_check
    check (isfinite(created_at)),
  constraint bottleneck_reports_window_bounds_check
    check (scope_window_start < scope_window_end),
  constraint bottleneck_reports_read_at_check
    check (scope_window_end <= scope_read_at)
);
comment on table product.bottleneck_reports is
  'sherlock.bottleneck-product.v1; migration=20260821090000';

create function product.valid_bottleneck_evidence_refs(value jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  item jsonb;
  keys text[];
begin
  if jsonb_typeof(value) <> 'array'
     or jsonb_array_length(value) not between 1 and 20 then
    return false;
  end if;
  for item in select jsonb_array_elements(value)
  loop
    if jsonb_typeof(item) <> 'object'
       or not (item ? 'type')
       or not (item ? 'personId')
       or jsonb_typeof(item->'type') <> 'string'
       or jsonb_typeof(item->'personId') <> 'string'
       or (item->>'personId') !~* '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$' then
      return false;
    end if;
    select array_agg(key order by key) into keys
      from jsonb_object_keys(item) as item_key(key);
    if item->>'type' = 'usage_summary' then
      if keys <> array['personId', 'type']::text[] then return false; end if;
    elsif item->>'type' = 'prompt_bucket' then
      if keys <> array['bucketStart', 'personId', 'type']::text[]
         or jsonb_typeof(item->'bucketStart') <> 'string'
         or (item->>'bucketStart') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then
        return false;
      end if;
    else
      return false;
    end if;
  end loop;
  return true;
end
$$;

create table product.bottleneck_candidates (
  id bigint generated always as identity,
  workspace_id uuid not null,
  report_id bigint not null,
  ordinal smallint not null
    constraint bottleneck_candidates_ordinal_check
    check (ordinal between 0 and 49),
  candidate_key text not null
    constraint bottleneck_candidates_candidate_key_check
    check (candidate_key ~ '^[a-z0-9._-]{1,64}$'),
  title text not null
    constraint bottleneck_candidates_title_check
    check (char_length(title) between 1 and 160),
  claim text not null
    constraint bottleneck_candidates_claim_check
    check (char_length(claim) between 1 and 4000),
  evidence_refs jsonb not null
    constraint bottleneck_candidates_evidence_refs_check
    check (product.valid_bottleneck_evidence_refs(evidence_refs)),
  attribution_mode text generated always as ('workspace_shared_bearer'::text) stored,
  trust text generated always as ('untrusted_agent_generated_claim'::text) stored,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (id),
  unique (workspace_id, id),
  unique (report_id, ordinal),
  unique (report_id, candidate_key),
  foreign key (workspace_id, report_id)
    references product.bottleneck_reports(workspace_id, id),
  constraint bottleneck_candidates_id_positive_check
    check (id > 0),
  constraint bottleneck_candidates_created_at_finite_check
    check (isfinite(created_at))
);

create function product.reject_bottleneck_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '55000', message = 'bottleneck reports are immutable';
end
$$;

create trigger bottleneck_reports_immutable
before update or delete on product.bottleneck_reports
for each row execute function product.reject_bottleneck_mutation();
create trigger bottleneck_reports_no_truncate
before truncate on product.bottleneck_reports
for each statement execute function product.reject_bottleneck_mutation();
create trigger bottleneck_candidates_immutable
before update or delete on product.bottleneck_candidates
for each row execute function product.reject_bottleneck_mutation();
create trigger bottleneck_candidates_no_truncate
before truncate on product.bottleneck_candidates
for each statement execute function product.reject_bottleneck_mutation();

create function product.enforce_bottleneck_candidate_count()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  target_report_id bigint;
  expected_count integer;
  actual_count integer;
begin
  if tg_table_name = 'bottleneck_reports' then
    target_report_id := new.id;
  else
    target_report_id := new.report_id;
  end if;
  select candidate_count into expected_count
    from product.bottleneck_reports where id = target_report_id;
  if expected_count is null then return null; end if;
  select count(*) into actual_count
    from product.bottleneck_candidates where report_id = target_report_id;
  if actual_count <> expected_count then
    raise exception using errcode = '23514', message = 'bottleneck candidate count mismatch';
  end if;
  return null;
end
$$;

create constraint trigger bottleneck_reports_exact_candidate_count
after insert on product.bottleneck_reports
deferrable initially deferred
for each row execute function product.enforce_bottleneck_candidate_count();
create constraint trigger bottleneck_candidates_exact_candidate_count
after insert on product.bottleneck_candidates
deferrable initially deferred
for each row execute function product.enforce_bottleneck_candidate_count();

revoke all on all tables in schema product from public, anon, authenticated;
revoke all on all sequences in schema product from public, anon, authenticated;
revoke all on all functions in schema product from public, anon, authenticated;
revoke all on schema product
  from sherlock_ingest, sherlock_normalizer, sherlock_reader, sherlock_reducer,
       sherlock_processor, sherlock_frame_projector;
revoke all on all tables in schema product
  from sherlock_ingest, sherlock_normalizer, sherlock_reader, sherlock_reducer,
       sherlock_processor, sherlock_frame_projector;
revoke all on all sequences in schema product
  from sherlock_ingest, sherlock_normalizer, sherlock_reader, sherlock_reducer,
       sherlock_processor, sherlock_frame_projector;
revoke all on all functions in schema product
  from sherlock_ingest, sherlock_normalizer, sherlock_reader, sherlock_reducer,
       sherlock_processor, sherlock_frame_projector;
revoke all on schema product from sherlock_bottleneck_writer;
revoke all on all tables in schema product from sherlock_bottleneck_writer;
revoke all on all sequences in schema product from sherlock_bottleneck_writer;
revoke all (
  id, workspace_id, submission_id, request_sha256, scope_snapshot_token,
  scope_window_start, scope_window_end, scope_read_at, scope_completeness,
  candidate_count, attribution_mode, trust, created_at
) on product.bottleneck_reports from sherlock_bottleneck_writer;
revoke all (
  id, workspace_id, report_id, ordinal, candidate_key, title, claim,
  evidence_refs, attribution_mode, trust, created_at
) on product.bottleneck_candidates from sherlock_bottleneck_writer;
revoke all on schema telemetry, analytics, processing from sherlock_bottleneck_writer;
revoke all on all tables in schema telemetry from sherlock_bottleneck_writer;
revoke all on all tables in schema analytics from sherlock_bottleneck_writer;
revoke all on all tables in schema processing from sherlock_bottleneck_writer;
revoke all on all sequences in schema telemetry from sherlock_bottleneck_writer;
revoke all on all sequences in schema analytics from sherlock_bottleneck_writer;
revoke all on all sequences in schema processing from sherlock_bottleneck_writer;
revoke all on all functions in schema telemetry from sherlock_bottleneck_writer;
revoke all on all functions in schema analytics from sherlock_bottleneck_writer;
revoke all on all functions in schema processing from sherlock_bottleneck_writer;

grant usage on schema product to sherlock_bottleneck_writer;
grant select on product.bottleneck_reports, product.bottleneck_candidates
  to sherlock_bottleneck_writer;
grant insert (
  workspace_id, submission_id, request_sha256, scope_snapshot_token,
  scope_window_start, scope_window_end, scope_read_at, scope_completeness,
  candidate_count
) on product.bottleneck_reports to sherlock_bottleneck_writer;
grant insert (
  workspace_id, report_id, ordinal, candidate_key, title, claim, evidence_refs
) on product.bottleneck_candidates to sherlock_bottleneck_writer;
grant select, usage on sequence
  product.bottleneck_reports_id_seq,
  product.bottleneck_candidates_id_seq
  to sherlock_bottleneck_writer;
grant execute on function product.valid_bottleneck_evidence_refs(jsonb)
  to sherlock_bottleneck_writer;
grant execute on function product.enforce_bottleneck_candidate_count()
  to sherlock_bottleneck_writer;
grant execute on function product.reject_bottleneck_mutation()
  to sherlock_bottleneck_writer;
grant sherlock_bottleneck_writer to sherlock_worker_login
  with inherit false, set true;

alter default privileges in schema product revoke all on tables from public;
alter default privileges in schema product revoke all on sequences from public;
alter default privileges in schema product revoke execute on functions from public;
