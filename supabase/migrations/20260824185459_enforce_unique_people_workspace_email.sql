-- Keep source people facts intact if legacy duplicates exist. Operators need
-- the exact tenant-scoped identity and cardinality before deciding how to
-- repair attribution; this migration must never merge or delete people.
do $$
declare
  duplicate record;
begin
  select workspace_id, email, count(*) as person_count
    into duplicate
    from telemetry.people
   where email is not null
   group by workspace_id, email
  having count(*) > 1
   order by workspace_id, email
   limit 1;

  if found then
    raise exception using
      errcode = '23505',
      message = format(
        'cannot enforce unique people email: workspace_id=%s email=%L count=%s',
        duplicate.workspace_id,
        duplicate.email,
        duplicate.person_count
      ),
      detail = 'Resolve the duplicate attribution explicitly; no people rows were changed.';
  end if;
end
$$;

-- A failed or cancelled concurrent build can leave this same-named index in
-- pg_index with indisvalid = false. The Supabase CLI 2.114.0 migration
-- splitter does not run DROP INDEX CONCURRENTLY outside its pipeline, so do
-- the catalog check and ordinary drop together in this transaction-safe block.
-- Never replace a valid index: that indicates migration-history drift rather
-- than a retry of this unapplied migration and must be resolved explicitly.
do $$
declare
  existing_is_valid boolean;
begin
  select i.indisvalid
    into existing_is_valid
    from pg_catalog.pg_index i
    join pg_catalog.pg_class index_relation
      on index_relation.oid = i.indexrelid
    join pg_catalog.pg_namespace index_namespace
      on index_namespace.oid = index_relation.relnamespace
   where index_namespace.nspname = 'telemetry'
     and index_relation.relname = 'people_workspace_email_key';

  if existing_is_valid then
    raise exception using
      errcode = '55000',
      message = 'refusing to replace valid index telemetry.people_workspace_email_key',
      detail = 'The uniqueness invariant is already applied; reconcile migration history explicitly.';
  elsif existing_is_valid is false then
    drop index telemetry.people_workspace_email_key;
  end if;
end
$$;

-- CI pins Supabase CLI 2.114.0, which runs CONCURRENTLY outside its transaction batch.
create unique index concurrently people_workspace_email_key
  on telemetry.people (workspace_id, email)
  where email is not null;
