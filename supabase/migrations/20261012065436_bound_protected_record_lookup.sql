-- sherlock_access is an optional, production-only schema. Its SECURITY DEFINER
-- protected_record_ids() lookup joins restricted people to their batches and
-- records, but with skewed join estimates PostgreSQL can expect many matching
-- batches and choose a hash join over a
-- full scan of millions of native_records to return a few thousand ids.
--
-- Both OFFSET 0 fences keep each lateral subquery as its own planning unit, so
-- it cannot be flattened back into that join: batch probes stay bounded to each
-- protected person and record probes stay bounded to each protected batch,
-- using the existing indexes despite skewed statistics. The result multiset is
-- unchanged. The PostgreSQL regression tests guard the plan shape.
--
-- This only rewrites the recognized original body. Anything else, including
-- changed security attributes, fails closed. CREATE OR REPLACE keeps the OID,
-- owner, ACL, and comment; every attribute is restated because replacement
-- resets omitted ones. No raw telemetry, grants, policies, or indexes change.
do $migration$
declare
  target regprocedure := to_regprocedure('sherlock_access.protected_record_ids()');
  original_body constant text := $original$
    select n.id
    from sherlock_access.restricted_people r
    join telemetry.ingest_batches b
      on b.workspace_id = r.workspace_id and b.person_id = r.person_id
    join telemetry.native_records n
      on n.workspace_id = b.workspace_id and n.batch_id = b.id
  $original$;
  bounded_body constant text := $bounded$
select n.id
from sherlock_access.restricted_people r
cross join lateral (
  select b.workspace_id, b.id
  from telemetry.ingest_batches b
  where b.workspace_id = r.workspace_id and b.person_id = r.person_id
  offset 0
) b
cross join lateral (
  select n.id
  from telemetry.native_records n
  where n.workspace_id = b.workspace_id and n.batch_id = b.id
  offset 0
) n
$bounded$;
  current_body text;
  normalized text[];
  known_attributes boolean;
  before_catalog jsonb;
  after_catalog jsonb;
begin
  if target is null then
    return;
  end if;

  select p.prosrc,
    p.prokind = 'f'
      and p.prolang = (select oid from pg_language where lanname = 'sql')
      and p.prorettype = 'bigint'::regtype and p.proretset
      and p.provolatile = 's' and p.prosecdef and not p.proleakproof
      and not p.proisstrict and p.proparallel = 'u'
      and p.procost = 100 and p.prorows = 1000
      and p.proconfig = array['search_path=""']
      and p.prosqlbody is null,
    to_jsonb(p) - 'prosrc' || jsonb_build_object('comment', obj_description(p.oid, 'pg_proc'))
  into current_body, known_attributes, before_catalog
  from pg_proc p
  where p.oid = target;

  if known_attributes is not true then
    raise exception 'sherlock_access.protected_record_ids() has unrecognized attributes; refusing to replace it';
  end if;

  -- Compare bodies ignoring whitespace layout and a trailing semicolon.
  select array_agg(
    rtrim(regexp_replace(btrim(regexp_replace(body, '\s+', ' ', 'g')), ' ?([=,().;]) ?', '\1', 'g'), ';')
    order by position
  )
  into normalized
  from unnest(array[current_body, original_body, bounded_body]) with ordinality as bodies(body, position);

  if normalized[1] = normalized[3] then
    return;
  elsif normalized[1] is distinct from normalized[2] then
    raise exception 'sherlock_access.protected_record_ids() has an unrecognized body; refusing to replace it';
  end if;

  execute format(
    'create or replace function sherlock_access.protected_record_ids() returns setof bigint
      language sql stable security definer set search_path = %L
      parallel unsafe cost 100 rows 1000 called on null input not leakproof
      as %L',
    '', bounded_body
  );

  select p.prosrc,
    to_jsonb(p) - 'prosrc' || jsonb_build_object('comment', obj_description(p.oid, 'pg_proc'))
  into current_body, after_catalog
  from pg_proc p
  where p.oid = target;

  if current_body is distinct from bounded_body then
    raise exception 'sherlock_access.protected_record_ids() body was not replaced';
  end if;
  if after_catalog is distinct from before_catalog then
    raise exception 'sherlock_access.protected_record_ids() metadata changed during replacement';
  end if;
end
$migration$;
