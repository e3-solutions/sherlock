begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(64);

select has_schema('telemetry', 'telemetry schema exists');
select has_schema('analytics', 'analytics schema exists');

select has_table('telemetry', 'workspaces', 'workspaces table exists');
select has_table('telemetry', 'people', 'people table exists');
select has_table('telemetry', 'sessions', 'sessions table exists');
select has_table('telemetry', 'ingest_batches', 'ingest_batches table exists');
select has_table('telemetry', 'native_records', 'native_records table exists');
select has_table('telemetry', 'events', 'events table exists');
select has_table('analytics', 'activity_spans', 'activity_spans table exists');
select has_column('telemetry', 'people', 'github_id', 'people records GitHub identity');
select has_column(
  'telemetry', 'events', 'message_search',
  'normalized message excerpts have a generated search vector'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'telemetry'
      and tablename = 'events'
      and indexname = 'events_message_search_idx'
  ),
  'normalized message search has a partial GIN index'
);
select has_extension('pg_cron', 'scheduled reduction has pg_cron');
select has_extension('pg_net', 'scheduled reduction has async HTTP');
select ok(
  (select n.nspname = 'extensions'
   from pg_extension e
   join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pg_net'),
  'pg_net extension metadata stays outside public'
);
select ok(
  exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'analytics'
      and c.relname = 'activity_spans_latest_version_idx'
      and not i.indisunique
  ),
  'same-cutoff activity corrections remain appendable'
);
select ok(
  (select count(*) = 1
   from cron.job
   where jobname = 'sherlock-activity-reducer-every-minute'
     and schedule = '* * * * *'
     and active),
  'exactly one active minutely activity reducer job exists'
);
select ok(
  exists (
    select 1
    from cron.job
    where jobname = 'sherlock-activity-reducer-every-minute'
      and command like '%/functions/v1/sherlock-activity-reducer%'
      and command like '%sherlock_project_url%'
      and command like '%sherlock_activity_reducer_token%'
      and command not ilike '%service_role%'
      and command not ilike '%supabase_db_url%'
  ),
  'Cron reads only the narrow invocation contract from Vault'
);

select ok(
  exists (select 1 from pg_roles where rolname = 'sherlock_ingest'),
  'ingest role exists'
);
select ok(
  exists (select 1 from pg_roles where rolname = 'sherlock_normalizer'),
  'normalizer role exists'
);
select ok(
  exists (select 1 from pg_roles where rolname = 'sherlock_reader'),
  'reader role exists'
);
select ok(
  exists (select 1 from pg_roles where rolname = 'sherlock_reducer'),
  'activity reducer role exists'
);
select ok(
  pg_has_role('postgres', 'sherlock_ingest', 'member'),
  'Edge Function database login can assume the constrained ingest role'
);
select ok(
  pg_has_role('postgres', 'sherlock_normalizer', 'member'),
  'Edge Function database login can assume the constrained normalizer role'
);
select ok(
  pg_has_role('postgres', 'sherlock_reducer', 'member'),
  'internal command database login can assume the constrained reducer role'
);

select ok(
  exists (
    select 1 from storage.buckets
    where id = 'telemetry-raw' and public = false
  ),
  'raw telemetry bucket is private'
);

select ok(not has_schema_privilege('anon', 'telemetry', 'usage'), 'anon cannot use telemetry');
select ok(not has_schema_privilege('anon', 'analytics', 'usage'), 'anon cannot use analytics');
select ok(
  not has_schema_privilege('authenticated', 'telemetry', 'usage'),
  'authenticated cannot use telemetry'
);
select ok(
  not has_schema_privilege('authenticated', 'analytics', 'usage'),
  'authenticated cannot use analytics'
);
select ok(
  not has_table_privilege('anon', 'telemetry.ingest_batches', 'select'),
  'anon cannot select source receipts'
);
select ok(
  not has_table_privilege('authenticated', 'telemetry.ingest_batches', 'select'),
  'authenticated cannot select source receipts'
);

select ok(
  has_table_privilege('sherlock_ingest', 'telemetry.ingest_batches', 'insert'),
  'ingest can insert batches'
);
select ok(
  has_table_privilege('sherlock_ingest', 'telemetry.native_records', 'insert'),
  'ingest can insert native records'
);
select ok(
  has_column_privilege('sherlock_ingest', 'telemetry.people', 'id', 'insert'),
  'ingest can create a server-resolved person'
);
select ok(
  has_column_privilege('sherlock_ingest', 'telemetry.people', 'github_id', 'update'),
  'ingest can refresh declared person metadata'
);
select ok(
  not has_column_privilege('sherlock_ingest', 'telemetry.people', 'identity_key', 'update'),
  'ingest cannot rewrite a person identity key'
);
select ok(
  not has_table_privilege('sherlock_ingest', 'telemetry.people', 'delete'),
  'ingest cannot delete people'
);
select ok(
  not has_table_privilege('sherlock_ingest', 'telemetry.events', 'insert'),
  'ingest cannot insert events'
);
select ok(
  not has_table_privilege('sherlock_ingest', 'analytics.activity_spans', 'insert'),
  'ingest cannot insert spans'
);
select ok(
  has_table_privilege('sherlock_normalizer', 'telemetry.events', 'insert'),
  'normalizer can insert events'
);
select ok(
  not has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'insert'),
  'normalizer cannot insert spans'
);
select ok(
  has_table_privilege('sherlock_reducer', 'telemetry.sessions', 'select'),
  'reducer can read session ownership'
);
select ok(
  has_table_privilege('sherlock_reducer', 'telemetry.events', 'select'),
  'reducer can read normalized events'
);
select ok(
  not has_table_privilege('sherlock_reducer', 'telemetry.ingest_batches', 'select'),
  'reducer cannot read raw receipt metadata'
);
select ok(
  not has_table_privilege('sherlock_reducer', 'telemetry.native_records', 'select'),
  'reducer cannot read native record locators'
);
select ok(
  has_table_privilege('sherlock_reducer', 'analytics.activity_spans', 'insert'),
  'reducer can append spans'
);
select ok(
  not has_table_privilege('sherlock_reducer', 'analytics.activity_spans', 'update'),
  'reducer cannot update spans'
);
select ok(
  not has_table_privilege('sherlock_reducer', 'analytics.activity_spans', 'delete'),
  'reducer cannot delete spans'
);
select ok(
  not has_table_privilege('sherlock_reducer', 'telemetry.events', 'insert'),
  'reducer cannot insert source events'
);
select ok(
  not has_table_privilege('sherlock_reducer', 'telemetry.sessions', 'update'),
  'reducer cannot update session caches'
);
select ok(
  not has_table_privilege('sherlock_reader', 'telemetry.events', 'insert'),
  'reader cannot insert events'
);
select ok(
  not has_table_privilege('sherlock_reader', 'telemetry.ingest_batches', 'insert'),
  'reader cannot insert batches'
);

select ok(
  not has_table_privilege('sherlock_ingest', 'telemetry.ingest_batches', 'update'),
  'ingest cannot update batches'
);
select ok(
  not has_table_privilege('sherlock_ingest', 'telemetry.ingest_batches', 'delete'),
  'ingest cannot delete batches'
);
select ok(
  not has_table_privilege('sherlock_normalizer', 'telemetry.events', 'update'),
  'normalizer cannot update events'
);
select ok(
  not has_table_privilege('sherlock_normalizer', 'telemetry.events', 'delete'),
  'normalizer cannot delete events'
);
select ok(
  not has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'update'),
  'normalizer cannot update spans'
);
select ok(
  not has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'delete'),
  'normalizer cannot delete spans'
);

insert into telemetry.workspaces (id, slug, name) values
  ('00000000-0000-0000-0000-000000000001', 'test-one', 'Test One'),
  ('00000000-0000-0000-0000-000000000002', 'test-two', 'Test Two');
insert into telemetry.people (id, workspace_id, identity_key) values
  (
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000001',
    'test-person'
  ),
  (
    '00000000-0000-0000-0000-000000000102',
    '00000000-0000-0000-0000-000000000001',
    'other-test-person'
  );

insert into telemetry.sessions (
  id, workspace_id, person_id, collector_key, native_session_id,
  actor_role, role_version, started_at
) values
  (
    '00000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000101',
    'test-collector', 'test-session', 'primary', 'test-role-v1',
    '2026-08-15T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000000202',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000101',
    'test-collector', 'test-worker', 'worker', 'test-role-v1',
    '2026-08-15T00:00:01Z'
  ),
  (
    '00000000-0000-0000-0000-000000000203',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000101',
    'test-collector', 'test-guardian', 'guardian', 'test-role-v1',
    '2026-08-15T00:00:02Z'
  );

update telemetry.sessions
set parent_session_id = '00000000-0000-0000-0000-000000000201',
    parent_native_session_id = 'test-session'
where id in (
  '00000000-0000-0000-0000-000000000202',
  '00000000-0000-0000-0000-000000000203'
);

select ok(
  (
    select count(*) = 2
    from telemetry.sessions
    where parent_session_id = '00000000-0000-0000-0000-000000000201'
      and actor_role in ('worker', 'guardian')
  ),
  'synthetic worker and guardian sessions retain their parent and role'
);

insert into telemetry.ingest_batches (
  id, workspace_id, person_id, collector_key, source_kind, source_stream_key,
  generation_key, generation_seq, start_offset, end_offset,
  source_byte_count, source_sha256, storage_path, storage_encoding,
  stored_byte_count, stored_sha256, record_count, contract_version
) values (
  '00000000-0000-0000-0000-000000000301',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000101',
  'test-collector', 'rollout', 'test-stream', 'test-generation', 0, 0, 1, 1,
  repeat('a', 64), 'test-span-evidence', 'identity', 1, repeat('b', 64), 1,
  'test-v1'
);

insert into telemetry.native_records (
  workspace_id, batch_id, record_index, source_start_offset,
  source_end_offset, record_sha256, parse_status
) values (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000301', 0, 0, 1, repeat('c', 64), 'ok'
);

insert into telemetry.events (
  workspace_id, session_id, source_record_id, normalizer_version,
  projection_index, source_priority, event_kind, actor_role, server_received_at
) select
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000201', id, 'test-normalizer-v1',
  0, 100, 'lifecycle', 'primary', '2026-08-15T00:00:00Z'
from telemetry.native_records
where workspace_id = '00000000-0000-0000-0000-000000000001'
  and batch_id = '00000000-0000-0000-0000-000000000301';

create temporary table constraint_results (
  test_name text primary key,
  passed boolean not null
);

do $$
begin
  begin
    insert into telemetry.ingest_batches (
      workspace_id, person_id, collector_key, source_kind, source_stream_key,
      generation_key, generation_seq, start_offset, end_offset,
      source_byte_count, source_sha256, storage_path, storage_encoding,
      stored_byte_count, stored_sha256, record_count, contract_version
    ) values (
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000101',
      'collector', 'rollout', 'stream', 'generation', 0, 0, 1, 1,
      repeat('a', 64), 'tenant-mismatch', 'identity', 1, repeat('b', 64), 1, 'v1'
    );
    insert into constraint_results values ('tenant mismatch', false);
  exception when foreign_key_violation then
    insert into constraint_results values ('tenant mismatch', true);
  end;

  begin
    insert into telemetry.ingest_batches (
      workspace_id, person_id, collector_key, source_kind, source_stream_key,
      generation_key, generation_seq, start_offset, end_offset,
      source_byte_count, source_sha256, storage_path, storage_encoding,
      stored_byte_count, stored_sha256, record_count, contract_version
    ) values (
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000101',
      'collector', 'rollout', 'stream', 'generation', 0, 4, 4, 0,
      repeat('a', 64), 'invalid-range', 'identity', 1, repeat('b', 64), 1, 'v1'
    );
    insert into constraint_results values ('invalid range', false);
  exception when check_violation then
    insert into constraint_results values ('invalid range', true);
  end;

  begin
    insert into telemetry.ingest_batches (
      workspace_id, person_id, collector_key, source_kind, source_stream_key,
      generation_key, generation_seq, start_offset, end_offset,
      source_byte_count, source_sha256, storage_path, storage_encoding,
      stored_byte_count, stored_sha256, record_count, contract_version
    ) values (
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000101',
      'collector', 'rollout', 'stream', 'generation', 0, 0, 1, 1,
      'not-a-hash', 'invalid-hash', 'identity', 1, repeat('b', 64), 1, 'v1'
    );
    insert into constraint_results values ('invalid hash', false);
  exception when check_violation then
    insert into constraint_results values ('invalid hash', true);
  end;

  begin
    insert into analytics.activity_spans (
      workspace_id, session_id, person_id, span_key, activity_version,
      valid_from_event_id, started_at, ended_at, span_state, activity_kind,
      timing_basis, confidence, estimated_start, estimated_end, actor_role,
      start_event_id
    ) select
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000201',
      '00000000-0000-0000-0000-000000000102',
      'wrong-person', 'test-activity-v1', id,
      '2026-08-15T00:00:00Z', '2026-08-15T00:00:01Z',
      'active', 'point', 'point', 'inferred', false, true, 'primary', id
    from telemetry.events
    where workspace_id = '00000000-0000-0000-0000-000000000001'
      and session_id = '00000000-0000-0000-0000-000000000201';
    insert into constraint_results values ('span ownership mismatch', false);
  exception when foreign_key_violation then
    insert into constraint_results values ('span ownership mismatch', true);
  end;
end
$$;

select ok(passed, 'cross-workspace person attribution is rejected')
from constraint_results where test_name = 'tenant mismatch';
select ok(passed, 'invalid byte ranges are rejected')
from constraint_results where test_name = 'invalid range';
select ok(passed, 'invalid hashes are rejected')
from constraint_results where test_name = 'invalid hash';
select ok(passed, 'spans cannot attribute a session to another workspace person')
from constraint_results where test_name = 'span ownership mismatch';

select * from finish();

do $$
begin
  if not (
    to_regnamespace('telemetry') is not null and
    to_regnamespace('analytics') is not null and
    to_regclass('telemetry.workspaces') is not null and
    to_regclass('telemetry.people') is not null and
    to_regclass('telemetry.sessions') is not null and
    to_regclass('telemetry.ingest_batches') is not null and
    to_regclass('telemetry.native_records') is not null and
    to_regclass('telemetry.events') is not null and
    to_regclass('analytics.activity_spans') is not null and
    (select count(*) = 4 from pg_roles where rolname in (
      'sherlock_ingest', 'sherlock_normalizer', 'sherlock_reducer', 'sherlock_reader'
    )) and
    pg_has_role('postgres', 'sherlock_ingest', 'member') and
    pg_has_role('postgres', 'sherlock_normalizer', 'member') and
    pg_has_role('postgres', 'sherlock_reducer', 'member') and
    exists (
      select 1 from storage.buckets
      where id = 'telemetry-raw' and public = false
    ) and
    not has_schema_privilege('anon', 'telemetry', 'usage') and
    not has_schema_privilege('anon', 'analytics', 'usage') and
    not has_schema_privilege('authenticated', 'telemetry', 'usage') and
    not has_schema_privilege('authenticated', 'analytics', 'usage') and
    not has_table_privilege('anon', 'telemetry.ingest_batches', 'select') and
    not has_table_privilege('authenticated', 'telemetry.ingest_batches', 'select') and
    has_table_privilege('sherlock_ingest', 'telemetry.ingest_batches', 'insert') and
    has_table_privilege('sherlock_ingest', 'telemetry.native_records', 'insert') and
    has_column_privilege('sherlock_ingest', 'telemetry.people', 'id', 'insert') and
    has_column_privilege('sherlock_ingest', 'telemetry.people', 'github_id', 'update') and
    not has_column_privilege('sherlock_ingest', 'telemetry.people', 'identity_key', 'update') and
    not has_table_privilege('sherlock_ingest', 'telemetry.people', 'delete') and
    not has_table_privilege('sherlock_ingest', 'telemetry.events', 'insert') and
    not has_table_privilege('sherlock_ingest', 'analytics.activity_spans', 'insert') and
    has_table_privilege('sherlock_normalizer', 'telemetry.events', 'insert') and
    not has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'insert') and
    has_table_privilege('sherlock_reducer', 'telemetry.sessions', 'select') and
    has_table_privilege('sherlock_reducer', 'telemetry.events', 'select') and
    not has_table_privilege('sherlock_reducer', 'telemetry.ingest_batches', 'select') and
    not has_table_privilege('sherlock_reducer', 'telemetry.native_records', 'select') and
    has_table_privilege('sherlock_reducer', 'analytics.activity_spans', 'insert') and
    not has_table_privilege('sherlock_reducer', 'analytics.activity_spans', 'update') and
    not has_table_privilege('sherlock_reducer', 'analytics.activity_spans', 'delete') and
    not has_table_privilege('sherlock_reducer', 'telemetry.events', 'insert') and
    not has_table_privilege('sherlock_reducer', 'telemetry.sessions', 'update') and
    not has_table_privilege('sherlock_reader', 'telemetry.events', 'insert') and
    not has_table_privilege('sherlock_reader', 'telemetry.ingest_batches', 'insert') and
    not has_table_privilege('sherlock_ingest', 'telemetry.ingest_batches', 'update') and
    not has_table_privilege('sherlock_ingest', 'telemetry.ingest_batches', 'delete') and
    not has_table_privilege('sherlock_normalizer', 'telemetry.events', 'update') and
    not has_table_privilege('sherlock_normalizer', 'telemetry.events', 'delete') and
    not has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'update') and
    not has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'delete') and
    (select bool_and(passed) from constraint_results)
  ) then
    raise exception 'Sherlock schema verification failed';
  end if;
end
$$;

select jsonb_build_object(
  'all_passed', true,
  'assertion_count', 64,
  'tables', 7,
  'private_bucket', 'telemetry-raw'
) as verification;

rollback;
