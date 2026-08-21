begin;

set local search_path = extensions, public, pg_catalog;
select plan(25);

select has_schema('product', 'private product schema exists');
select has_table(
  'product', 'bottleneck_submissions',
  'candidate batches use one product table'
);
select ok(
  to_regclass('product.bottleneck_reports') is null
  and to_regclass('product.bottleneck_candidates') is null,
  'no report or candidate child table remains'
);
select ok(
  (select array_agg(column_name::text order by ordinal_position)
     from information_schema.columns
    where table_schema = 'product'
      and table_name = 'bottleneck_submissions') = array[
        'workspace_id', 'submission_id', 'request_sha256', 'method', 'candidates',
        'attribution_mode', 'trust', 'client_claims_verified', 'created_at'
      ],
  'the table has the exact auditable column set'
);
select ok(
  exists (
    select 1 from pg_constraint
     where conrelid = 'product.bottleneck_submissions'::regclass
       and contype = 'p'
       and pg_get_constraintdef(oid) =
         'PRIMARY KEY (workspace_id, submission_id)'
  ),
  'workspace and submission form the exact lookup key'
);
select ok(
  not exists (
    select 1 from pg_constraint
     where conrelid = 'product.bottleneck_submissions'::regclass
       and contype = 'f'
  ),
  'product facts do not reference source schemas'
);
select ok(
  exists (
    select 1 from pg_roles
     where rolname = 'sherlock_bottleneck_writer'
       and not rolcanlogin and not rolinherit and not rolsuper
       and not rolcreatedb and not rolcreaterole and not rolreplication
       and not rolbypassrls and rolconnlimit = 0
  ),
  'writer is a constrained NOLOGIN role'
);
select ok(
  pg_has_role('sherlock_worker_login', 'sherlock_bottleneck_writer', 'member'),
  'the worker login can explicitly assume the writer'
);
select ok(
  has_schema_privilege('sherlock_bottleneck_writer', 'product', 'usage')
  and not has_schema_privilege('sherlock_bottleneck_writer', 'product', 'create'),
  'writer has product usage without create'
);
select ok(
  has_table_privilege(
    'sherlock_bottleneck_writer', 'product.bottleneck_submissions', 'select'
  ),
  'writer can reload exact batches'
);
select ok(
  (select array_agg(column_name::text order by column_name)
     from information_schema.column_privileges
    where grantee = 'sherlock_bottleneck_writer'
      and table_schema = 'product'
      and table_name = 'bottleneck_submissions'
      and privilege_type = 'INSERT') = array[
        'candidates', 'method', 'request_sha256', 'submission_id', 'workspace_id'
      ],
  'writer can insert only the five client-input columns'
);
select ok(
  not has_table_privilege(
    'sherlock_bottleneck_writer', 'product.bottleneck_submissions', 'insert'
  )
  and not has_table_privilege(
    'sherlock_bottleneck_writer', 'product.bottleneck_submissions', 'update'
  )
  and not has_table_privilege(
    'sherlock_bottleneck_writer', 'product.bottleneck_submissions', 'delete'
  )
  and not has_table_privilege(
    'sherlock_bottleneck_writer', 'product.bottleneck_submissions', 'truncate'
  )
  and not has_table_privilege(
    'sherlock_bottleneck_writer', 'product.bottleneck_submissions', 'references'
  )
  and not has_table_privilege(
    'sherlock_bottleneck_writer', 'product.bottleneck_submissions', 'trigger'
  ),
  'writer has no table-wide mutation or delegation privileges'
);
select ok(
  not exists (
    select 1 from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'product' and relation.relkind = 'S'
  ),
  'product schema has no sequences'
);
select ok(
  not exists (
    select 1 from pg_proc routine
    join pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'product'
  ),
  'product schema has no functions'
);
select ok(
  not exists (
    select 1 from pg_trigger
     where tgrelid = 'product.bottleneck_submissions'::regclass
       and not tgisinternal
  ),
  'product table has no custom triggers'
);
select ok(
  not has_schema_privilege('sherlock_bottleneck_writer', 'telemetry', 'usage')
  and not has_schema_privilege('sherlock_bottleneck_writer', 'analytics', 'usage')
  and not has_schema_privilege('sherlock_bottleneck_writer', 'processing', 'usage'),
  'writer cannot enter source or derived-data schemas'
);
select ok(
  not has_schema_privilege('public', 'product', 'usage')
  and not has_schema_privilege('anon', 'product', 'usage')
  and not has_schema_privilege('authenticated', 'product', 'usage')
  and not has_schema_privilege('service_role', 'product', 'usage'),
  'Data API and public roles cannot enter product'
);
select ok(
  (select bool_and(is_generated = 'ALWAYS')
     from information_schema.columns
    where table_schema = 'product'
      and table_name = 'bottleneck_submissions'
      and column_name in (
        'attribution_mode', 'trust', 'client_claims_verified'
      )),
  'all server truth columns are generated'
);
select ok(
  exists (
    select 1 from pg_constraint
     where conrelid = 'product.bottleneck_submissions'::regclass
       and contype = 'c'
       and pg_get_expr(conbin, conrelid) like '%octet_length%'
       and pg_get_expr(conbin, conrelid) like '%2162688%'
  ),
  'candidate JSON allows bounded jsonb text overhead above the 2 MiB transport cap'
);
select lives_ok(
  $$insert into product.bottleneck_submissions (
      workspace_id, submission_id, request_sha256, method, candidates
    ) values (
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222', repeat('a', 64), '{}', '[]'
    )$$,
  'empty candidate batches satisfy database JSON bounds'
);
select ok(
  (select attribution_mode = 'workspace_shared_bearer'
          and trust = 'unverified_client_claim'
          and not client_claims_verified
          and isfinite(created_at)
     from product.bottleneck_submissions
    where workspace_id = '11111111-1111-4111-8111-111111111111'
      and submission_id = '22222222-2222-4222-8222-222222222222'),
  'generated server facts are fixed and truthful'
);
select throws_ok(
  $$insert into product.bottleneck_submissions (
      workspace_id, submission_id, request_sha256, method, candidates
    ) values (
      gen_random_uuid(), gen_random_uuid(), repeat('b', 64), '{}',
      (select jsonb_agg(value) from generate_series(1, 51) value)
    )$$,
  '23514', null, 'database rejects 51 candidates'
);
select throws_ok(
  $$insert into product.bottleneck_submissions (
      workspace_id, submission_id, request_sha256, method, candidates
    ) values (gen_random_uuid(), gen_random_uuid(), repeat('c', 64), '{}', '{}')$$,
  '23514', null, 'candidates must be an array'
);
select throws_ok(
  $$insert into product.bottleneck_submissions (
      workspace_id, submission_id, request_sha256, method, candidates
    ) values (gen_random_uuid(), gen_random_uuid(), repeat('d', 64), '[]', '[]')$$,
  '23514', null, 'method must be an object'
);
select ok(
  to_regclass('telemetry.native_records') is not null
  and to_regclass('telemetry.events') is not null
  and to_regclass('analytics.activity_spans') is not null,
  'raw telemetry and derived analytics relations remain untouched'
);

select * from finish();
rollback;
