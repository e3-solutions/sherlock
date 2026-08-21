begin;

set local search_path = extensions, public, pg_catalog;
select plan(52);

select has_schema('product', 'private product schema exists');
select has_table('product', 'bottleneck_reports', 'report receipts are auditable');
select has_table('product', 'bottleneck_candidates', 'candidate claims are separate product facts');
select is(
  obj_description('product.bottleneck_reports'::regclass, 'pg_class'),
  'sherlock.bottleneck-product.v1; migration=20260821090000',
  'report table carries the exact product migration receipt'
);
select ok(
  exists (
    select 1 from pg_roles
     where rolname = 'sherlock_bottleneck_writer'
       and not rolcanlogin and not rolinherit and not rolsuper
       and not rolcreatedb and not rolcreaterole and not rolreplication
       and not rolbypassrls and rolconnlimit = 0
  ),
  'product writer has the exact safe role attributes'
);
select ok(
  (select count(*) = 2
          and count(*) filter (
            where member_role.rolname = 'sherlock_worker_login'
              and grantor_role.oid = (
                select nspowner from pg_namespace where nspname = 'product'
              )
              and not membership.admin_option
              and not membership.inherit_option
              and membership.set_option
          ) = 1
          and count(*) filter (
            where member_role.rolname = 'postgres'
              and grantor_role.rolname = 'supabase_admin'
              and membership.admin_option
              and not membership.inherit_option
              and not membership.set_option
          ) = 1
     from pg_auth_members as membership
     join pg_roles as granted_role on granted_role.oid = membership.roleid
     join pg_roles as member_role on member_role.oid = membership.member
     join pg_roles as grantor_role on grantor_role.oid = membership.grantor
    where granted_role.rolname = 'sherlock_bottleneck_writer'),
  'worker is the only SET-capable member beside the exact non-assumable Supabase admin edge'
);
select ok(
  exists (
    select 1 from pg_roles
     where rolname = 'sherlock_worker_login'
       and rolcanlogin and not rolinherit and not rolsuper
       and not rolcreatedb and not rolcreaterole and not rolreplication
       and not rolbypassrls
  ),
  'worker login has the intended safe login posture'
);
select ok(
  not exists (
    select 1
      from pg_auth_members as membership
      join pg_roles as member on member.oid = membership.member
     where member.rolname = 'sherlock_bottleneck_writer'
  ),
  'product writer is not a member of any other role'
);
select ok(
  (select product_namespace.nspowner <> writer.oid
          and count(*) filter (
            where schema_acl.grantee = writer.oid
              and schema_acl.privilege_type = 'USAGE'
              and not schema_acl.is_grantable
          ) = 1
          and count(*) filter (
            where schema_acl.grantee = writer.oid
              and schema_acl.privilege_type <> 'USAGE'
          ) = 0
          and count(*) filter (
            where schema_acl.grantee not in (product_namespace.nspowner, writer.oid)
          ) = 0
     from pg_namespace as product_namespace
     cross join lateral (
       select oid from pg_roles where rolname = 'sherlock_bottleneck_writer'
     ) as writer
     cross join lateral aclexplode(product_namespace.nspacl) as schema_acl
    where product_namespace.nspname = 'product'
    group by product_namespace.nspowner, writer.oid),
  'writer has exact non-grantable usage on the product schema'
);
select ok(
  (select count(*) = 3 and bool_and(
      product_function.proowner <> writer.oid
      and not product_function.prosecdef
      and (
        select count(*) = 1 and bool_and(
          function_acl.privilege_type = 'EXECUTE'
          and not function_acl.is_grantable
        )
          from aclexplode(product_function.proacl) as function_acl
         where function_acl.grantee = writer.oid
      )
      and not exists (
        select 1 from aclexplode(product_function.proacl) as function_acl
         where function_acl.grantee not in (product_function.proowner, writer.oid)
      )
    )
     from pg_proc as product_function
     cross join lateral (
       select oid from pg_roles where rolname = 'sherlock_bottleneck_writer'
     ) as writer
    where product_function.oid in (
      'product.valid_bottleneck_evidence_refs(jsonb)'::regprocedure,
      'product.enforce_bottleneck_candidate_count()'::regprocedure,
      'product.reject_bottleneck_mutation()'::regprocedure
    )),
  'writer has exact non-grantable execution on required non-owned functions'
);
select ok(
  not exists (
    select 1
      from pg_proc as product_function
      join pg_namespace as product_namespace
        on product_namespace.oid = product_function.pronamespace
     where product_namespace.nspname = 'product'
       and has_function_privilege(
         'sherlock_bottleneck_writer', product_function.oid, 'execute'
       )
       and product_function.oid not in (
         'product.valid_bottleneck_evidence_refs(jsonb)'::regprocedure,
         'product.enforce_bottleneck_candidate_count()'::regprocedure,
         'product.reject_bottleneck_mutation()'::regprocedure
       )
  ),
  'writer cannot execute unexpected product functions'
);
select ok(
  (select count(*) = 3 and bool_and(
      product_function.proowner = product_namespace.nspowner
      and product_language.lanname = 'plpgsql'
      and product_function.prokind = 'f'
      and not product_function.prosecdef
      and product_function.proconfig = array['search_path=pg_catalog']::text[]
      and case product_function.oid
        when 'product.valid_bottleneck_evidence_refs(jsonb)'::regprocedure then
          product_function.pronargs = 1
          and product_function.prorettype = 'boolean'::regtype
          and product_function.provolatile = 'i'
          and product_function.proisstrict
          and md5(product_function.prosrc) = '159c970f44390bc15d287c611924e57b'
        when 'product.enforce_bottleneck_candidate_count()'::regprocedure then
          product_function.pronargs = 0
          and product_function.prorettype = 'trigger'::regtype
          and product_function.provolatile = 'v'
          and not product_function.proisstrict
          and md5(product_function.prosrc) = '9724f8fe2f3a7f867399ebc1f88e8874'
        when 'product.reject_bottleneck_mutation()'::regprocedure then
          product_function.pronargs = 0
          and product_function.prorettype = 'trigger'::regtype
          and product_function.provolatile = 'v'
          and not product_function.proisstrict
          and md5(product_function.prosrc) = '29800e4093732398c0050fbce7fbcd19'
        else false
      end
    )
     from pg_proc as product_function
     join pg_namespace as product_namespace
       on product_namespace.oid = product_function.pronamespace
     join pg_language as product_language
       on product_language.oid = product_function.prolang
    where product_function.oid in (
      'product.valid_bottleneck_evidence_refs(jsonb)'::regprocedure,
      'product.enforce_bottleneck_candidate_count()'::regprocedure,
      'product.reject_bottleneck_mutation()'::regprocedure
    )),
  'required product functions retain exact metadata and body fingerprints'
);
select ok(
  has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_reports', 'select')
  and not has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_reports', 'insert')
  and (select product_table.relowner <> writer.oid
          and count(*) filter (
            where table_acl.grantee = writer.oid
              and table_acl.privilege_type = 'SELECT'
              and not table_acl.is_grantable
          ) = 1
          and count(*) filter (
            where table_acl.grantee = writer.oid
              and (table_acl.privilege_type <> 'SELECT'
                   or table_acl.is_grantable)
          ) = 0
          and count(*) filter (
            where table_acl.grantee not in (product_table.relowner, writer.oid)
          ) = 0
       from pg_class as product_table
       cross join lateral (
         select oid from pg_roles where rolname = 'sherlock_bottleneck_writer'
       ) as writer
       cross join lateral aclexplode(product_table.relacl) as table_acl
      where product_table.oid = 'product.bottleneck_reports'::regclass
      group by product_table.relowner, writer.oid),
  'writer has exact non-grantable table-wide select only on reports'
);
select ok(
  not has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_reports', 'update')
  and not has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_reports', 'delete')
  and not has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_reports', 'truncate')
  and not has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_reports', 'references')
  and not has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_reports', 'trigger'),
  'writer has no unsafe report-table privileges'
);
select ok(
  has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_candidates', 'select')
  and not has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_candidates', 'insert')
  and (select product_table.relowner <> writer.oid
          and count(*) filter (
            where table_acl.grantee = writer.oid
              and table_acl.privilege_type = 'SELECT'
              and not table_acl.is_grantable
          ) = 1
          and count(*) filter (
            where table_acl.grantee = writer.oid
              and (table_acl.privilege_type <> 'SELECT'
                   or table_acl.is_grantable)
          ) = 0
          and count(*) filter (
            where table_acl.grantee not in (product_table.relowner, writer.oid)
          ) = 0
       from pg_class as product_table
       cross join lateral (
         select oid from pg_roles where rolname = 'sherlock_bottleneck_writer'
       ) as writer
       cross join lateral aclexplode(product_table.relacl) as table_acl
      where product_table.oid = 'product.bottleneck_candidates'::regclass
      group by product_table.relowner, writer.oid),
  'writer has exact non-grantable table-wide select only on candidates'
);
select ok(
  not has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_candidates', 'update')
  and not has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_candidates', 'delete')
  and not has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_candidates', 'truncate')
  and not has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_candidates', 'references')
  and not has_table_privilege('sherlock_bottleneck_writer', 'product.bottleneck_candidates', 'trigger'),
  'writer has no unsafe candidate-table privileges'
);
select ok(
  (select count(*) = 16 and bool_and(
      column_acl.grantee = writer.oid
      and column_acl.privilege_type = 'INSERT'
      and not column_acl.is_grantable
      and case product_table.relname
        when 'bottleneck_reports' then product_column.attname in (
          'workspace_id', 'submission_id', 'request_sha256',
          'scope_snapshot_token', 'scope_window_start', 'scope_window_end',
          'scope_read_at', 'scope_completeness', 'candidate_count'
        )
        when 'bottleneck_candidates' then product_column.attname in (
          'workspace_id', 'report_id', 'ordinal', 'candidate_key', 'title',
          'claim', 'evidence_refs'
        )
        else false
      end
    )
      from pg_attribute as product_column
      join pg_class as product_table on product_table.oid = product_column.attrelid
      cross join lateral (
        select oid from pg_roles where rolname = 'sherlock_bottleneck_writer'
      ) as writer
      cross join lateral aclexplode(product_column.attacl) as column_acl
     where product_column.attrelid in (
             'product.bottleneck_reports'::regclass,
             'product.bottleneck_candidates'::regclass
           )
       and product_column.attnum > 0
       and not product_column.attisdropped
  ),
  'writer has exactly the sixteen non-grantable insert-column privileges'
);
select ok(
  has_sequence_privilege('sherlock_bottleneck_writer', 'product.bottleneck_reports_id_seq', 'select')
  and has_sequence_privilege('sherlock_bottleneck_writer', 'product.bottleneck_reports_id_seq', 'usage')
  and not has_sequence_privilege('sherlock_bottleneck_writer', 'product.bottleneck_reports_id_seq', 'update')
  and pg_get_serial_sequence('product.bottleneck_reports', 'id') =
    'product.bottleneck_reports_id_seq'
  and (select product_sequence.relowner <> writer.oid
          and product_sequence.relpersistence = 'p'
          and identity_column.attidentity = 'a'
          and sequence_parameters.seqtypid = 'bigint'::regtype
          and sequence_parameters.seqstart = 1
          and sequence_parameters.seqincrement = 1
          and sequence_parameters.seqmax = 9223372036854775807
          and sequence_parameters.seqmin = 1
          and sequence_parameters.seqcache = 1
          and not sequence_parameters.seqcycle
          and count(*) filter (
            where sequence_acl.grantee = writer.oid
              and sequence_acl.privilege_type in ('SELECT', 'USAGE')
              and not sequence_acl.is_grantable
          ) = 2
          and count(*) filter (
            where sequence_acl.grantee = writer.oid
              and (sequence_acl.privilege_type not in ('SELECT', 'USAGE')
                   or sequence_acl.is_grantable)
          ) = 0
          and count(*) filter (
            where sequence_acl.grantee not in (product_sequence.relowner, writer.oid)
          ) = 0
       from pg_class as product_sequence
       cross join lateral (
         select oid from pg_roles where rolname = 'sherlock_bottleneck_writer'
       ) as writer
       join pg_attribute as identity_column
         on identity_column.attrelid = 'product.bottleneck_reports'::regclass
        and identity_column.attname = 'id'
       join pg_sequence as sequence_parameters
         on sequence_parameters.seqrelid = product_sequence.oid
       cross join lateral aclexplode(product_sequence.relacl) as sequence_acl
      where product_sequence.oid = 'product.bottleneck_reports_id_seq'::regclass
      group by product_sequence.relowner, product_sequence.relpersistence,
               writer.oid, identity_column.attidentity,
               sequence_parameters.seqtypid, sequence_parameters.seqstart,
               sequence_parameters.seqincrement, sequence_parameters.seqmax,
               sequence_parameters.seqmin, sequence_parameters.seqcache,
               sequence_parameters.seqcycle),
  'writer has exact report identity-sequence privileges and binding'
);
select ok(
  has_sequence_privilege('sherlock_bottleneck_writer', 'product.bottleneck_candidates_id_seq', 'select')
  and has_sequence_privilege('sherlock_bottleneck_writer', 'product.bottleneck_candidates_id_seq', 'usage')
  and not has_sequence_privilege('sherlock_bottleneck_writer', 'product.bottleneck_candidates_id_seq', 'update')
  and pg_get_serial_sequence('product.bottleneck_candidates', 'id') =
    'product.bottleneck_candidates_id_seq'
  and (select product_sequence.relowner <> writer.oid
          and product_sequence.relpersistence = 'p'
          and identity_column.attidentity = 'a'
          and sequence_parameters.seqtypid = 'bigint'::regtype
          and sequence_parameters.seqstart = 1
          and sequence_parameters.seqincrement = 1
          and sequence_parameters.seqmax = 9223372036854775807
          and sequence_parameters.seqmin = 1
          and sequence_parameters.seqcache = 1
          and not sequence_parameters.seqcycle
          and count(*) filter (
            where sequence_acl.grantee = writer.oid
              and sequence_acl.privilege_type in ('SELECT', 'USAGE')
              and not sequence_acl.is_grantable
          ) = 2
          and count(*) filter (
            where sequence_acl.grantee = writer.oid
              and (sequence_acl.privilege_type not in ('SELECT', 'USAGE')
                   or sequence_acl.is_grantable)
          ) = 0
          and count(*) filter (
            where sequence_acl.grantee not in (product_sequence.relowner, writer.oid)
          ) = 0
       from pg_class as product_sequence
       cross join lateral (
         select oid from pg_roles where rolname = 'sherlock_bottleneck_writer'
       ) as writer
       join pg_attribute as identity_column
         on identity_column.attrelid = 'product.bottleneck_candidates'::regclass
        and identity_column.attname = 'id'
       join pg_sequence as sequence_parameters
         on sequence_parameters.seqrelid = product_sequence.oid
       cross join lateral aclexplode(product_sequence.relacl) as sequence_acl
      where product_sequence.oid = 'product.bottleneck_candidates_id_seq'::regclass
      group by product_sequence.relowner, product_sequence.relpersistence,
               writer.oid, identity_column.attidentity,
               sequence_parameters.seqtypid, sequence_parameters.seqstart,
               sequence_parameters.seqincrement, sequence_parameters.seqmax,
               sequence_parameters.seqmin, sequence_parameters.seqcache,
               sequence_parameters.seqcycle),
  'writer has exact candidate identity-sequence privileges and binding'
);
select ok(
  not exists (
    select 1
      from pg_class as product_relation
      join pg_namespace as product_namespace
        on product_namespace.oid = product_relation.relnamespace
      cross join lateral (
        select oid from pg_roles where rolname = 'sherlock_bottleneck_writer'
      ) as writer
     where product_namespace.nspname = 'product'
       and product_relation.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
       and product_relation.relname not in (
         'bottleneck_reports', 'bottleneck_candidates',
         'bottleneck_reports_id_seq', 'bottleneck_candidates_id_seq'
       )
       and (
         product_relation.relowner = writer.oid
         or exists (
           select 1 from aclexplode(product_relation.relacl) as relation_acl
            where relation_acl.grantee <> product_relation.relowner
         )
       )
  ),
  'unexpected product relations have no writer or ambient privileges'
);
select ok(
  not has_schema_privilege('sherlock_bottleneck_writer', 'telemetry', 'usage')
  and not has_schema_privilege('sherlock_bottleneck_writer', 'telemetry', 'create'),
  'writer cannot use or create in telemetry');
select ok(
  not has_schema_privilege('sherlock_bottleneck_writer', 'analytics', 'usage')
  and not has_schema_privilege('sherlock_bottleneck_writer', 'analytics', 'create'),
  'writer cannot use or create in analytics');
select ok(
  not has_schema_privilege('sherlock_bottleneck_writer', 'processing', 'usage')
  and not has_schema_privilege('sherlock_bottleneck_writer', 'processing', 'create'),
  'writer cannot use or create in processing');
select ok(
  not has_table_privilege('sherlock_bottleneck_writer', 'telemetry.events', 'select'),
  'writer cannot read canonical events'
);
select ok(
  not exists (
    select 1
      from pg_class as source_relation
      join pg_namespace as source_namespace
        on source_namespace.oid = source_relation.relnamespace
      cross join lateral (
        select oid from pg_roles where rolname = 'sherlock_bottleneck_writer'
      ) as writer
     where source_namespace.nspname in ('telemetry', 'analytics', 'processing')
       and (
         source_relation.relowner = writer.oid
         or exists (
           select 1 from aclexplode(source_relation.relacl) as source_acl
            where source_acl.grantee = writer.oid
         )
       )
  )
  and not exists (
    select 1
      from pg_proc as source_function
      join pg_namespace as source_namespace
        on source_namespace.oid = source_function.pronamespace
      cross join lateral (
        select oid from pg_roles where rolname = 'sherlock_bottleneck_writer'
      ) as writer
     where source_namespace.nspname in ('telemetry', 'analytics', 'processing')
       and (
         source_function.proowner = writer.oid
         or exists (
           select 1 from aclexplode(source_function.proacl) as source_acl
            where source_acl.grantee = writer.oid
         )
       )
  ),
  'writer has no direct source relation or function ACLs'
);
select ok(
  has_table_privilege('sherlock_reader', 'telemetry.events', 'select')
  and not has_table_privilege('sherlock_reader', 'product.bottleneck_reports', 'insert'),
  'existing reader remains read-only and is not widened to product writes'
);
select ok(
  not has_schema_privilege('sherlock_ingest', 'product', 'usage')
  and not has_schema_privilege('sherlock_normalizer', 'product', 'usage')
  and not has_schema_privilege('sherlock_reader', 'product', 'usage')
  and not has_schema_privilege('sherlock_reducer', 'product', 'usage')
  and not has_schema_privilege('sherlock_processor', 'product', 'usage')
  and not has_schema_privilege('sherlock_frame_projector', 'product', 'usage'),
  'all non-product worker roles are explicitly revoked from product schema'
);
select ok(
  not exists (
    select 1 from information_schema.columns
     where table_schema = 'product' and table_name = 'bottleneck_reports'
       and column_name in (
         'person_id', 'installation_id', 'reviewer_id', 'review_status',
         'status', 'decision', 'agent', 'provider', 'version'
       )
  ),
  'reports contain no identity, review, or unclaimed agent metadata fields'
);
select ok(
  not exists (
    select 1 from information_schema.columns
     where table_schema = 'product' and table_name = 'bottleneck_candidates'
       and column_name in (
         'person_id', 'installation_id', 'reviewer_id', 'review_status',
         'status', 'decision', 'agent', 'provider', 'version'
       )
  ),
  'candidates contain no identity, review, or unclaimed agent metadata fields'
);
select ok(
  (select count(*) = 2 and bool_and(
      column_contract.relpersistence = 'p'
      and column_contract.column_hash = case column_contract.relname
        when 'bottleneck_reports' then 'f3c0e5a9a4368028fca03867e1866a75'
        when 'bottleneck_candidates' then '016e8ea38ea0d6b491939a97aaa9dee4'
        else null
      end
    )
     from (
       select product_table.relname, product_table.relpersistence,
              md5(jsonb_agg(jsonb_build_array(
                product_column.attnum, product_column.attname,
                format_type(product_column.atttypid, product_column.atttypmod),
                product_column.attnotnull, product_column.attidentity,
                product_column.attgenerated,
                coalesce(pg_get_expr(
                  column_default.adbin, column_default.adrelid
                ), ''),
                case when product_column.attcollation = 0 then ''
                  else format(
                    '%I.%I', collation_namespace.nspname,
                    product_collation.collname
                  )
                end
              ) order by product_column.attnum)::text) as column_hash
         from pg_class as product_table
         join pg_namespace as product_namespace
           on product_namespace.oid = product_table.relnamespace
         join pg_attribute as product_column
           on product_column.attrelid = product_table.oid
          and product_column.attnum > 0 and not product_column.attisdropped
         left join pg_attrdef as column_default
           on column_default.adrelid = product_column.attrelid
          and column_default.adnum = product_column.attnum
         left join pg_collation as product_collation
           on product_collation.oid = product_column.attcollation
         left join pg_namespace as collation_namespace
           on collation_namespace.oid = product_collation.collnamespace
        where product_namespace.nspname = 'product'
          and product_table.relname in (
            'bottleneck_reports', 'bottleneck_candidates'
          )
        group by product_table.relname, product_table.relpersistence
     ) as column_contract),
  'both permanent product tables retain the exact ordered 24-column contract'
);
select ok(
  (select count(*) = 2 and bool_and(
      product_column.attgenerated = 's'
      and format_type(product_column.atttypid, product_column.atttypmod) = 'text'
      and pg_get_expr(column_default.adbin, column_default.adrelid) =
        case product_column.attname
          when 'attribution_mode' then '''workspace_shared_bearer''::text'
          when 'trust' then '''untrusted_agent_generated_claim''::text'
        end
    )
     from pg_attribute as product_column
     join pg_attrdef as column_default
       on column_default.adrelid = product_column.attrelid
      and column_default.adnum = product_column.attnum
    where product_column.attrelid = 'product.bottleneck_reports'::regclass
      and product_column.attname in ('attribution_mode', 'trust')
      and not product_column.attisdropped),
  'report attribution and trust are exact fixed generated literals'
);
select ok(
  (select count(*) = 2 and bool_and(
      product_column.attgenerated = 's'
      and format_type(product_column.atttypid, product_column.atttypmod) = 'text'
      and pg_get_expr(column_default.adbin, column_default.adrelid) =
        case product_column.attname
          when 'attribution_mode' then '''workspace_shared_bearer''::text'
          when 'trust' then '''untrusted_agent_generated_claim''::text'
        end
    )
     from pg_attribute as product_column
     join pg_attrdef as column_default
       on column_default.adrelid = product_column.attrelid
      and column_default.adnum = product_column.attnum
    where product_column.attrelid = 'product.bottleneck_candidates'::regclass
      and product_column.attname in ('attribution_mode', 'trust')
      and not product_column.attisdropped),
  'candidate attribution and trust are exact fixed generated literals'
);
select ok(
  (select count(*) = 4 and bool_and(
      product_constraint.convalidated
      and not product_constraint.condeferrable
      and not product_constraint.condeferred
      and (
        product_constraint.contype = 'f'
        or exists (
          select 1 from pg_index as constraint_index
           where constraint_index.indexrelid = product_constraint.conindid
             and constraint_index.indisunique and constraint_index.indisvalid
             and constraint_index.indisready and constraint_index.indislive
        )
      )
      and case product_constraint.conname
        when 'bottleneck_reports_pkey' then
          product_constraint.contype = 'p'
          and product_constraint.conkey = '{1}'::smallint[]
        when 'bottleneck_reports_workspace_id_id_key' then
          product_constraint.contype = 'u'
          and product_constraint.conkey = '{2,1}'::smallint[]
        when 'bottleneck_reports_workspace_id_submission_id_key' then
          product_constraint.contype = 'u'
          and product_constraint.conkey = '{2,3}'::smallint[]
        when 'bottleneck_reports_workspace_id_fkey' then
          product_constraint.contype = 'f'
          and product_constraint.conkey = '{2}'::smallint[]
          and product_constraint.confrelid = 'telemetry.workspaces'::regclass
          and product_constraint.confkey = '{1}'::smallint[]
          and product_constraint.confupdtype = 'a'
          and product_constraint.confdeltype = 'a'
          and product_constraint.confmatchtype = 's'
        else false
      end
    ) from pg_constraint as product_constraint
    where product_constraint.conrelid = 'product.bottleneck_reports'::regclass
      and product_constraint.contype in ('p', 'u', 'f')),
  'reports have exactly the required primary, workspace, and idempotency constraints'
);
select ok(
  (select count(*) = 5 and bool_and(
      product_constraint.convalidated
      and not product_constraint.condeferrable
      and not product_constraint.condeferred
      and (
        product_constraint.contype = 'f'
        or exists (
          select 1 from pg_index as constraint_index
           where constraint_index.indexrelid = product_constraint.conindid
             and constraint_index.indisunique and constraint_index.indisvalid
             and constraint_index.indisready and constraint_index.indislive
        )
      )
      and case product_constraint.conname
        when 'bottleneck_candidates_pkey' then
          product_constraint.contype = 'p'
          and product_constraint.conkey = '{1}'::smallint[]
        when 'bottleneck_candidates_workspace_id_id_key' then
          product_constraint.contype = 'u'
          and product_constraint.conkey = '{2,1}'::smallint[]
        when 'bottleneck_candidates_report_id_ordinal_key' then
          product_constraint.contype = 'u'
          and product_constraint.conkey = '{3,4}'::smallint[]
        when 'bottleneck_candidates_report_id_candidate_key_key' then
          product_constraint.contype = 'u'
          and product_constraint.conkey = '{3,5}'::smallint[]
        when 'bottleneck_candidates_workspace_id_report_id_fkey' then
          product_constraint.contype = 'f'
          and product_constraint.conkey = '{2,3}'::smallint[]
          and product_constraint.confrelid = 'product.bottleneck_reports'::regclass
          and product_constraint.confkey = '{2,1}'::smallint[]
          and product_constraint.confupdtype = 'a'
          and product_constraint.confdeltype = 'a'
          and product_constraint.confmatchtype = 's'
        else false
      end
    ) from pg_constraint as product_constraint
    where product_constraint.conrelid = 'product.bottleneck_candidates'::regclass
      and product_constraint.contype in ('p', 'u', 'f')),
  'candidates have exactly the required primary, uniqueness, and workspace-bound FK constraints'
);
select ok(
  (select count(*) = 18 and bool_and(
      product_check.convalidated
      and product_check.conislocal
      and product_check.coninhcount = 0
      and not product_check.connoinherit
      and not product_check.condeferrable
      and not product_check.condeferred
      and md5(pg_get_expr(product_check.conbin, product_check.conrelid)) =
        case product_table.relname || '.' || product_check.conname
          when 'bottleneck_reports.bottleneck_reports_request_sha256_check'
            then '76283a0b6718e6748134b0d4d4152b98'
          when 'bottleneck_reports.bottleneck_reports_scope_snapshot_token_check'
            then '1d8f539474fc619b9146e461cc4c215c'
          when 'bottleneck_reports.bottleneck_reports_scope_completeness_check'
            then 'ca055b5efbf5da2c4974ef8f79b5c91c'
          when 'bottleneck_reports.bottleneck_reports_candidate_count_check'
            then 'de60cc02913cef93177813ba41868168'
          when 'bottleneck_reports.bottleneck_reports_id_positive_check'
            then '971d06b5efd12f11437a2da7ff1087b6'
          when 'bottleneck_reports.bottleneck_reports_scope_window_start_finite_check'
            then '4425e5aca9f051b429198ff6aaec3276'
          when 'bottleneck_reports.bottleneck_reports_scope_window_end_finite_check'
            then 'bef77c038c8f83b2d242489b619b385b'
          when 'bottleneck_reports.bottleneck_reports_scope_read_at_finite_check'
            then 'e033cf95bad1201a797dc60767f9c3ff'
          when 'bottleneck_reports.bottleneck_reports_created_at_finite_check'
            then 'b56439f320a65d4cbb40328834698b83'
          when 'bottleneck_reports.bottleneck_reports_window_bounds_check'
            then 'd66dd9657f10992b317ffa8aeab5baf3'
          when 'bottleneck_reports.bottleneck_reports_read_at_check'
            then '1206790d8ef5c2c5554855baaab3d385'
          when 'bottleneck_candidates.bottleneck_candidates_ordinal_check'
            then '32d73b0401dd46c62cf7fbc0a7508dde'
          when 'bottleneck_candidates.bottleneck_candidates_candidate_key_check'
            then '8cc0c5dbdb0553b5d9901f0d77374881'
          when 'bottleneck_candidates.bottleneck_candidates_title_check'
            then 'fdf4a23e1a745141adab8e8abbb6b965'
          when 'bottleneck_candidates.bottleneck_candidates_claim_check'
            then 'c6b7f8fb80f270e2b79d4ed5be6061d8'
          when 'bottleneck_candidates.bottleneck_candidates_evidence_refs_check'
            then 'd1370229f949a2ae1a39e3f23404e62d'
          when 'bottleneck_candidates.bottleneck_candidates_id_positive_check'
            then '971d06b5efd12f11437a2da7ff1087b6'
          when 'bottleneck_candidates.bottleneck_candidates_created_at_finite_check'
            then 'b56439f320a65d4cbb40328834698b83'
          else false::text
        end
    )
     from pg_constraint as product_check
     join pg_class as product_table on product_table.oid = product_check.conrelid
    where product_check.conrelid in (
            'product.bottleneck_reports'::regclass,
            'product.bottleneck_candidates'::regclass
          )
      and product_check.contype = 'c'),
  'all eighteen native checks retain exact flags and expression fingerprints'
);
select ok(
  (select count(*) = 6 and bool_and(
      product_trigger.tgenabled = 'O'
      and product_trigger.tgqual is null
      and product_trigger.tgnargs = 0
      and product_trigger.tgattr = ''::int2vector
      and product_trigger.tgparentid = 0
      and case product_table.relname || '.' || product_trigger.tgname
        when 'bottleneck_reports.bottleneck_reports_immutable' then
          product_trigger.tgtype = 27
          and product_trigger.tgfoid = 'product.reject_bottleneck_mutation()'::regprocedure
          and product_trigger.tgconstraint = 0
          and not product_trigger.tgdeferrable and not product_trigger.tginitdeferred
        when 'bottleneck_reports.bottleneck_reports_no_truncate' then
          product_trigger.tgtype = 34
          and product_trigger.tgfoid = 'product.reject_bottleneck_mutation()'::regprocedure
          and product_trigger.tgconstraint = 0
          and not product_trigger.tgdeferrable and not product_trigger.tginitdeferred
        when 'bottleneck_candidates.bottleneck_candidates_immutable' then
          product_trigger.tgtype = 27
          and product_trigger.tgfoid = 'product.reject_bottleneck_mutation()'::regprocedure
          and product_trigger.tgconstraint = 0
          and not product_trigger.tgdeferrable and not product_trigger.tginitdeferred
        when 'bottleneck_candidates.bottleneck_candidates_no_truncate' then
          product_trigger.tgtype = 34
          and product_trigger.tgfoid = 'product.reject_bottleneck_mutation()'::regprocedure
          and product_trigger.tgconstraint = 0
          and not product_trigger.tgdeferrable and not product_trigger.tginitdeferred
        when 'bottleneck_reports.bottleneck_reports_exact_candidate_count' then
          product_trigger.tgtype = 5
          and product_trigger.tgfoid = 'product.enforce_bottleneck_candidate_count()'::regprocedure
          and product_trigger.tgconstraint <> 0
          and product_trigger.tgdeferrable and product_trigger.tginitdeferred
        when 'bottleneck_candidates.bottleneck_candidates_exact_candidate_count' then
          product_trigger.tgtype = 5
          and product_trigger.tgfoid = 'product.enforce_bottleneck_candidate_count()'::regprocedure
          and product_trigger.tgconstraint <> 0
          and product_trigger.tgdeferrable and product_trigger.tginitdeferred
        else false
      end
    )
     from pg_trigger as product_trigger
     join pg_class as product_table on product_table.oid = product_trigger.tgrelid
    where product_trigger.tgrelid in (
            'product.bottleneck_reports'::regclass,
            'product.bottleneck_candidates'::regclass
          )
      and not product_trigger.tgisinternal),
  'all six product triggers have exact enabled definitions and integrity functions'
);
select ok(not has_schema_privilege('public', 'product', 'usage'),
  'public cannot use product schema');
select ok(not has_schema_privilege('anon', 'product', 'usage'),
  'anon cannot use product schema');
select ok(not has_schema_privilege('authenticated', 'product', 'usage'),
  'authenticated cannot use product schema');
select ok(
  not has_table_privilege('public', 'product.bottleneck_reports', 'select')
  and not has_table_privilege('anon', 'product.bottleneck_candidates', 'insert')
  and not has_table_privilege('authenticated', 'product.bottleneck_candidates', 'select'),
  'product tables are private from ambient application roles'
);

insert into telemetry.workspaces (id, slug, name)
values ('f0000000-0000-4000-8000-000000000001', 'bottleneck-test', 'Bottleneck test');
insert into product.bottleneck_reports (
  workspace_id, submission_id, request_sha256, scope_snapshot_token,
  scope_window_start, scope_window_end, scope_read_at,
  scope_completeness, candidate_count
) values (
  'f0000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000002', repeat('a', 64), 'snapshot',
  '2026-08-20T00:00:00Z', '2026-08-21T00:00:00Z', '2026-08-21T00:00:01Z',
  'all_candidates_within_scope', 0
);
set constraints all immediate;
select results_eq(
  $$select attribution_mode || ':' || trust
      from product.bottleneck_reports
     where submission_id = 'f0000000-0000-4000-8000-000000000002'$$,
  array['workspace_shared_bearer:untrusted_agent_generated_claim'],
  'empty complete batch persists fixed server truth'
);
select throws_ok(
  $$update product.bottleneck_reports set candidate_count = 1
     where submission_id = 'f0000000-0000-4000-8000-000000000002'$$,
  '55000', 'bottleneck reports are immutable',
  'report receipts are immutable for the table owner too'
);
select ok(
  product.valid_bottleneck_evidence_refs(
    '[{"type":"usage_summary","personId":"f0000000-0000-4000-8000-000000000001"},
      {"type":"prompt_bucket","personId":"f0000000-0000-4000-8000-000000000001","bucketStart":"2026-08-20T00:00:00.000Z"}]'::jsonb
  ),
  'typed evidence references accept the two exact variants in order'
);
select ok(
  not product.valid_bottleneck_evidence_refs(
    '[{"type":"usage_summary","personId":"f0000000-0000-4000-8000-000000000001","reviewer":"forbidden"}]'::jsonb
  ),
  'evidence references reject unknown fields'
);
select throws_ok(
  $$insert into product.bottleneck_reports (
      id, workspace_id, submission_id, request_sha256, scope_snapshot_token,
      scope_window_start, scope_window_end, scope_read_at,
      scope_completeness, candidate_count
    ) overriding system value values (
      -1, 'f0000000-0000-4000-8000-000000000001',
      'f0000000-0000-4000-8000-000000000010', repeat('c', 64), 'snapshot',
      '2026-08-20T00:00:00Z', '2026-08-21T00:00:00Z',
      '2026-08-21T00:00:01Z', 'all_candidates_within_scope', 0
    )$$,
  '23514',
  'new row for relation "bottleneck_reports" violates check constraint "bottleneck_reports_id_positive_check"',
  'reports reject a non-positive overridden identity'
);
select throws_ok(
  $$insert into product.bottleneck_candidates (
      id, workspace_id, report_id, ordinal, candidate_key, title, claim,
      evidence_refs
    ) overriding system value
    select -1, workspace_id, id, 0, 'negative-id', 'Negative id',
           'Negative identities cannot enter cursor traversal.',
           '[{"type":"usage_summary","personId":"f0000000-0000-4000-8000-000000000001"}]'::jsonb
      from product.bottleneck_reports
     where submission_id = 'f0000000-0000-4000-8000-000000000002'$$,
  '23514',
  'new row for relation "bottleneck_candidates" violates check constraint "bottleneck_candidates_id_positive_check"',
  'candidates reject a non-positive overridden identity'
);
select throws_ok(
  $$insert into product.bottleneck_reports (
      workspace_id, submission_id, request_sha256, scope_snapshot_token,
      scope_window_start, scope_window_end, scope_read_at,
      scope_completeness, candidate_count
    ) values (
      'f0000000-0000-4000-8000-000000000001',
      'f0000000-0000-4000-8000-000000000011', repeat('d', 64), 'snapshot',
      '-infinity', '2026-08-21T00:00:00Z', '2026-08-21T00:00:01Z',
      'all_candidates_within_scope', 0
    )$$,
  '23514',
  'new row for relation "bottleneck_reports" violates check constraint "bottleneck_reports_scope_window_start_finite_check"',
  'reports reject a negative-infinite scope start'
);
select throws_ok(
  $$insert into product.bottleneck_reports (
      workspace_id, submission_id, request_sha256, scope_snapshot_token,
      scope_window_start, scope_window_end, scope_read_at,
      scope_completeness, candidate_count
    ) values (
      'f0000000-0000-4000-8000-000000000001',
      'f0000000-0000-4000-8000-000000000012', repeat('e', 64), 'snapshot',
      '2026-08-20T00:00:00Z', 'infinity', 'infinity',
      'all_candidates_within_scope', 0
    )$$,
  '23514',
  'new row for relation "bottleneck_reports" violates check constraint "bottleneck_reports_scope_read_at_finite_check"',
  'reports reject an infinite scope end/read boundary'
);
select throws_ok(
  $$insert into product.bottleneck_reports (
      workspace_id, submission_id, request_sha256, scope_snapshot_token,
      scope_window_start, scope_window_end, scope_read_at,
      scope_completeness, candidate_count
    ) values (
      'f0000000-0000-4000-8000-000000000001',
      'f0000000-0000-4000-8000-000000000013', repeat('f', 64), 'snapshot',
      '2026-08-20T00:00:00Z', '2026-08-21T00:00:00Z', 'infinity',
      'all_candidates_within_scope', 0
    )$$,
  '23514',
  'new row for relation "bottleneck_reports" violates check constraint "bottleneck_reports_scope_read_at_finite_check"',
  'reports reject an infinite read timestamp'
);
select throws_ok(
  $$insert into product.bottleneck_reports (
      workspace_id, submission_id, request_sha256, scope_snapshot_token,
      scope_window_start, scope_window_end, scope_read_at,
      scope_completeness, candidate_count, created_at
    ) values (
      'f0000000-0000-4000-8000-000000000001',
      'f0000000-0000-4000-8000-000000000014', repeat('1', 64), 'snapshot',
      '2026-08-20T00:00:00Z', '2026-08-21T00:00:00Z',
      '2026-08-21T00:00:01Z', 'all_candidates_within_scope', 0, 'infinity'
    )$$,
  '23514',
  'new row for relation "bottleneck_reports" violates check constraint "bottleneck_reports_created_at_finite_check"',
  'reports reject an infinite creation timestamp'
);
select throws_ok(
  $$insert into product.bottleneck_candidates (
      workspace_id, report_id, ordinal, candidate_key, title, claim,
      evidence_refs, created_at
    )
    select workspace_id, id, 0, 'infinite-created-at', 'Infinite time',
           'Infinite creation timestamps are rejected.',
           '[{"type":"usage_summary","personId":"f0000000-0000-4000-8000-000000000001"}]'::jsonb,
           'infinity'
      from product.bottleneck_reports
     where submission_id = 'f0000000-0000-4000-8000-000000000002'$$,
  '23514',
  'new row for relation "bottleneck_candidates" violates check constraint "bottleneck_candidates_created_at_finite_check"',
  'candidates reject an infinite creation timestamp'
);

set constraints all deferred;
insert into product.bottleneck_reports (
  workspace_id, submission_id, request_sha256, scope_snapshot_token,
  scope_window_start, scope_window_end, scope_read_at,
  scope_completeness, candidate_count
) values (
  'f0000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000003', repeat('b', 64), 'mismatch-snapshot',
  '2026-08-20T00:00:00Z', '2026-08-21T00:00:00Z', '2026-08-21T00:00:01Z',
  'all_candidates_within_scope', 2
);
insert into product.bottleneck_candidates (
  workspace_id, report_id, ordinal, candidate_key, title, claim, evidence_refs
)
select
  workspace_id, id, 0, 'mismatch-proof', 'Mismatch proof',
  'One actual candidate does not satisfy the declared count of two.',
  '[{"type":"usage_summary","personId":"f0000000-0000-4000-8000-000000000001"}]'::jsonb
from product.bottleneck_reports
where submission_id = 'f0000000-0000-4000-8000-000000000003';
select throws_ok(
  $$set constraints all immediate$$,
  '23514', 'bottleneck candidate count mismatch',
  'deferred exact-count enforcement rejects an in-range declared/actual mismatch'
);

select * from finish();
rollback;
