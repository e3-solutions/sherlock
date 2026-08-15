begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(37);

select has_schema('telemetry', 'telemetry schema exists');
select has_schema('analytics', 'analytics schema exists');

select has_table('telemetry', 'workspaces', 'workspaces table exists');
select has_table('telemetry', 'people', 'people table exists');
select has_table('telemetry', 'sessions', 'sessions table exists');
select has_table('telemetry', 'ingest_batches', 'ingest_batches table exists');
select has_table('telemetry', 'native_records', 'native_records table exists');
select has_table('telemetry', 'events', 'events table exists');
select has_table('analytics', 'activity_spans', 'activity_spans table exists');

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
  pg_has_role('postgres', 'sherlock_ingest', 'member'),
  'Edge Function database login can assume the constrained ingest role'
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
  has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'insert'),
  'normalizer can insert spans'
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
  );

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
end
$$;

select ok(passed, 'cross-workspace person attribution is rejected')
from constraint_results where test_name = 'tenant mismatch';
select ok(passed, 'invalid byte ranges are rejected')
from constraint_results where test_name = 'invalid range';
select ok(passed, 'invalid hashes are rejected')
from constraint_results where test_name = 'invalid hash';

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
    (select count(*) = 3 from pg_roles where rolname in (
      'sherlock_ingest', 'sherlock_normalizer', 'sherlock_reader'
    )) and
    pg_has_role('postgres', 'sherlock_ingest', 'member') and
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
    not has_table_privilege('sherlock_ingest', 'telemetry.events', 'insert') and
    not has_table_privilege('sherlock_ingest', 'analytics.activity_spans', 'insert') and
    has_table_privilege('sherlock_normalizer', 'telemetry.events', 'insert') and
    has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'insert') and
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
  'assertion_count', 37,
  'tables', 7,
  'private_bucket', 'telemetry-raw'
) as verification;

rollback;
