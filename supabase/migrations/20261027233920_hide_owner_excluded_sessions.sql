-- COR-5002: owner session exclusions become a durable server-side tombstone.
--
-- Owners exclude sessions in ~/.sherlock/session-exclusions.json and the
-- collector stops uploading them, but copies uploaded before the exclusion
-- stayed visible: the privacy helpers only hid sherlock_access.restricted_people.
-- Collectors now report their excluded session ids (sherlock-rollout-ingest,
-- op "exclusions"), which are stored here additively and never deleted by the
-- collector path. Every reader surface that already hides restricted people
-- through these helpers now also hides those sessions and their descendants:
--
-- * hidden_session_ids()   sessions, events (session_id/related_session_id),
--                          activity_spans, frame_evidence_revisions,
--                          frame_projection_receipts, session_scm and, through
--                          sessions, bonaparte_run_classifications; also the
--                          Sesh reader's sessions policy and excerpt search.
-- * protected_record_ids() events with no session_id whose batch belongs to
--                          an excluded session (sessions cover all others).
-- * private_session_ids()  excluded sessions are not shown to the private
--                          principal either.
-- * sesh_sherlock_reader   a restrictive policy hides the excluded sessions'
--                          ingest batches, and with them the raw storage
--                          objects its storage policy joins through them.
--
-- Exclusions are scoped by (workspace_id, person_id, native_session_id): an id
-- reported for someone else's session matches nothing. Descendants are found
-- through resolved parent_session_id links and still-unresolved
-- parent_native_session_id links of the same person, at most 64 levels deep.
--
-- protected_record_ids() deliberately does not enumerate every native record
-- of excluded sessions: in production that is ~300k ids for a few hundred
-- sessions (24 s cold) and the helper runs inside every events/session_scm
-- reader query. Both of those policies already filter on hidden_session_ids();
-- only events without a session_id (25 lifecycle/unknown rows in production)
-- need the record-level check, so only those are looked up.
--
-- sherlock_access is an optional, production-only schema. Without it this
-- migration only adds the session lookup indexes and the updated drift gate.
-- With it, the current helpers must be the shapes the excerpt-search gate
-- pins (checked first), so an unrecognized privacy state fails closed.
-- CREATE OR REPLACE keeps each helper's OID, owner and ACL.

-- Serves both the exclusion lookup by owner and the cross-owner check below.
create index if not exists sessions_native_owner_idx
  on telemetry.sessions (workspace_id, native_session_id, person_id);
-- Unresolved children by owner; sessions_unresolved_parent_native_idx leads
-- with collector_key, which the exclusion lookup does not know.
create index if not exists sessions_owner_unresolved_parent_idx
  on telemetry.sessions (workspace_id, person_id, parent_native_session_id)
  where parent_session_id is null and parent_native_session_id is not null;

-- Refuse to touch an unrecognized privacy state (a re-run is recognized by the
-- gate this migration installs below).
do $verify_before$ begin perform analytics._assert_excerpt_search_policy_shape(); end $verify_before$;

do $migration$
begin
  if pg_catalog.to_regnamespace('sherlock_access') is null then
    return;
  end if;

  create table if not exists sherlock_access.owner_session_exclusions (
    workspace_id uuid not null,
    person_id uuid not null,
    native_session_id text not null,
    source text not null default 'collector',
    added_at timestamptz not null default now(),
    primary key (workspace_id, person_id, native_session_id),
    constraint owner_session_exclusions_native_session_id_check
      check (native_session_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    constraint owner_session_exclusions_source_check
      check (source in ('collector', 'operator'))
  );
  comment on table sherlock_access.owner_session_exclusions is
    'Owner-excluded native sessions; hidden with their descendants from every reader surface. Additive from collectors.';
  alter table sherlock_access.owner_session_exclusions enable row level security;
  revoke all on table sherlock_access.owner_session_exclusions from public;
  if exists (select from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on table sherlock_access.owner_session_exclusions from anon, authenticated, service_role;
  end if;

  -- Excluded sessions with the earliest exclusion that reaches them; a
  -- descendant created later carries its own created_at so watermark readers
  -- still see it.
  create or replace function sherlock_access.owner_excluded_sessions()
  returns table (workspace_id uuid, person_id uuid, session_id uuid, native_session_id text, added_at timestamptz)
  language sql stable security definer set search_path = ''
  as $body$
with recursive roots as (
  select s.workspace_id, s.person_id, s.id, s.native_session_id, s.created_at, x.added_at
  from sherlock_access.owner_session_exclusions x
  join telemetry.sessions s
    on s.workspace_id = x.workspace_id and s.person_id = x.person_id
   and s.native_session_id = x.native_session_id
  union all
  select s.workspace_id, s.person_id, s.id, s.native_session_id, s.created_at, x.added_at
  from sherlock_access.owner_session_exclusions x
  join telemetry.sessions s
    on s.workspace_id = x.workspace_id and s.person_id = x.person_id
   and s.parent_session_id is null and s.parent_native_session_id = x.native_session_id
), hidden (workspace_id, person_id, session_id, native_session_id, created_at, root_added_at, depth) as (
  select r.workspace_id, r.person_id, r.id, r.native_session_id, r.created_at, r.added_at, 0
  from roots r
  union all
  select c.workspace_id, c.person_id, c.id, c.native_session_id, c.created_at, h.root_added_at, h.depth + 1
  from hidden h
  cross join lateral (
    select k.workspace_id, k.person_id, k.id, k.native_session_id, k.created_at
    from telemetry.sessions k
    where k.workspace_id = h.workspace_id and k.person_id = h.person_id
      and k.parent_session_id = h.session_id
    union all
    select k.workspace_id, k.person_id, k.id, k.native_session_id, k.created_at
    from telemetry.sessions k
    where k.workspace_id = h.workspace_id and k.person_id = h.person_id
      and k.parent_session_id is null and k.parent_native_session_id = h.native_session_id
  ) c
  where h.depth < 64
)
select h.workspace_id, h.person_id, h.session_id, h.native_session_id,
  min(greatest(h.root_added_at, h.created_at)) as added_at
from hidden h
group by h.workspace_id, h.person_id, h.session_id, h.native_session_id
$body$;

  -- Excluded native ids per owner: reported roots (even before any session row
  -- exists) plus every resolved descendant.
  create or replace function sherlock_access.owner_excluded_native_keys()
  returns table (workspace_id uuid, person_id uuid, native_session_id text, added_at timestamptz)
  language sql stable security definer set search_path = ''
  as $body$
select k.workspace_id, k.person_id, k.native_session_id, min(k.added_at) as added_at
from (
  select x.workspace_id, x.person_id, x.native_session_id, x.added_at
  from sherlock_access.owner_session_exclusions x
  union all
  select s.workspace_id, s.person_id, s.native_session_id, s.added_at
  from sherlock_access.owner_excluded_sessions() s
) k
group by k.workspace_id, k.person_id, k.native_session_id
$body$;

  create or replace function sherlock_access.hidden_session_ids()
  returns setof uuid
  language sql stable security definer set search_path = ''
  as $body$
 select s.id from telemetry.sessions s
 join sherlock_access.restricted_people r on r.workspace_id=s.workspace_id and r.person_id=s.person_id
 union
 select child.id from telemetry.sessions parent
 join sherlock_access.restricted_people r on r.workspace_id=parent.workspace_id and r.person_id=parent.person_id
 join telemetry.sessions child on child.workspace_id=parent.workspace_id and child.parent_session_id=parent.id
 union
 select x.session_id from sherlock_access.owner_excluded_sessions() x
$body$;

  create or replace function sherlock_access.private_session_ids()
  returns setof uuid
  language sql stable security definer set search_path = ''
  as $body$
 select s.id from telemetry.sessions s
 join sherlock_access.restricted_people r on r.workspace_id=s.workspace_id and r.person_id=s.person_id
 where (s.parent_session_id is null or exists(
 select 1 from telemetry.sessions parent
 join sherlock_access.restricted_people pr on pr.workspace_id=parent.workspace_id and pr.person_id=parent.person_id
 where parent.workspace_id=s.workspace_id and parent.id=s.parent_session_id))
 and s.id not in (select x.session_id from sherlock_access.owner_excluded_sessions() x)
$body$;

  create or replace function sherlock_access.protected_record_ids()
  returns setof bigint
  language sql stable security definer set search_path = ''
  parallel unsafe cost 100 rows 1000 called on null input not leakproof
  as $body$
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
union all
select n.id
from telemetry.workspaces w
cross join lateral (
  select e.source_record_id
  from telemetry.events e
  where e.workspace_id = w.id and e.session_id is null
  offset 0
) e
join telemetry.native_records n on n.workspace_id = w.id and n.id = e.source_record_id
join telemetry.ingest_batches b on b.workspace_id = n.workspace_id and b.id = n.batch_id
where exists (select from sherlock_access.owner_session_exclusions)
  and ((b.workspace_id, b.person_id, b.observed_native_session_id) in (
         select k.workspace_id, k.person_id, k.native_session_id
         from sherlock_access.owner_excluded_native_keys() k)
    or (b.workspace_id, b.person_id, b.observed_parent_native_session_id) in (
         select k.workspace_id, k.person_id, k.native_session_id
         from sherlock_access.owner_excluded_native_keys() k))
$body$;

  -- Sesh sync contract: every excluded native session id (roots and
  -- descendants) first excluded after p_after, or all of them when null.
  -- The result drops the owner, so an id that names another person's session
  -- is left out: a collector can only hide its own person's sessions.
  create or replace function sherlock_access.excluded_native_session_ids(p_after timestamptz default null)
  returns table (native_session_id text, added_at timestamptz)
  language sql stable security definer set search_path = ''
  as $body$
select k.native_session_id, min(k.added_at) as added_at
from sherlock_access.owner_excluded_native_keys() k
where not exists (
  select from telemetry.workspaces w
  join telemetry.sessions s on s.workspace_id = w.id and s.native_session_id = k.native_session_id
  where s.workspace_id is distinct from k.workspace_id or s.person_id is distinct from k.person_id)
group by k.native_session_id
having p_after is null or min(k.added_at) > p_after
order by 2, 1
$body$;

  -- PostgREST exposes only public, graphql_public and telemetry, so the sync
  -- reads through this wrapper.
  create or replace function public.sherlock_excluded_native_session_ids(p_after timestamptz default null)
  returns table (native_session_id text, added_at timestamptz)
  language sql stable security definer set search_path = ''
  as $body$
select x.native_session_id, x.added_at
from sherlock_access.excluded_native_session_ids(p_after) x
$body$;

  -- Collector reports: additive, scoped to the authenticated caller.
  create or replace function sherlock_access.record_owner_session_exclusions(
    p_workspace_id uuid,
    p_person_id uuid,
    p_native_session_ids text[]
  )
  returns table (accepted integer, total integer)
  language plpgsql volatile security definer set search_path = ''
  as $body$
declare
  v_ids text[];
  v_accepted integer;
begin
  if p_workspace_id is null or p_person_id is null or p_native_session_ids is null
     or pg_catalog.cardinality(p_native_session_ids) > 5000
     or exists (select from pg_catalog.unnest(p_native_session_ids) i(id)
                 where i.id is null
                    or i.id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  then
    raise exception using errcode = '22023', message = 'owner_exclusions_invalid_argument';
  end if;
  if not exists (select from telemetry.people p where p.workspace_id = p_workspace_id and p.id = p_person_id) then
    raise exception using errcode = '22023', message = 'owner_exclusions_unknown_person';
  end if;
  select coalesce(pg_catalog.array_agg(distinct i.id), '{}') into v_ids
    from pg_catalog.unnest(p_native_session_ids) i(id);
  insert into sherlock_access.owner_session_exclusions (workspace_id, person_id, native_session_id, source)
  select p_workspace_id, p_person_id, i.id, 'collector'
    from pg_catalog.unnest(v_ids) i(id)
  on conflict do nothing;
  get diagnostics v_accepted = row_count;
  return query select v_accepted, pg_catalog.cardinality(v_ids);
end
$body$;

  revoke all on function sherlock_access.owner_excluded_sessions() from public;
  revoke all on function sherlock_access.owner_excluded_native_keys() from public;
  revoke all on function sherlock_access.excluded_native_session_ids(timestamptz) from public;
  revoke all on function public.sherlock_excluded_native_session_ids(timestamptz) from public;
  revoke all on function sherlock_access.record_owner_session_exclusions(uuid, uuid, text[]) from public;
  if exists (select from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function sherlock_access.owner_excluded_sessions() from anon, authenticated, service_role;
    revoke all on function sherlock_access.owner_excluded_native_keys() from anon, authenticated, service_role;
    revoke all on function sherlock_access.excluded_native_session_ids(timestamptz) from anon, authenticated;
    revoke all on function public.sherlock_excluded_native_session_ids(timestamptz) from anon, authenticated;
    revoke all on function sherlock_access.record_owner_session_exclusions(uuid, uuid, text[])
      from anon, authenticated, service_role;
    grant execute on function sherlock_access.excluded_native_session_ids(timestamptz) to service_role;
    grant execute on function public.sherlock_excluded_native_session_ids(timestamptz) to service_role;
  end if;
  if exists (select from pg_catalog.pg_roles where rolname = 'sesh_sherlock_reader') then
    grant execute on function sherlock_access.excluded_native_session_ids(timestamptz) to sesh_sherlock_reader;
    grant execute on function public.sherlock_excluded_native_session_ids(timestamptz) to sesh_sherlock_reader;
    -- Evaluated by the restrictive batch policy below as the reader itself.
    grant execute on function sherlock_access.owner_excluded_native_keys() to sesh_sherlock_reader;
    -- Restrictive: ANDed with the existing person-level policy. The raw
    -- storage policy finds objects through these rows, so it follows.
    drop policy if exists sesh_reader_owner_exclusions on telemetry.ingest_batches;
    create policy sesh_reader_owner_exclusions on telemetry.ingest_batches
      as restrictive for select to sesh_sherlock_reader
      using (
        not ((workspace_id, person_id, coalesce(observed_native_session_id, '')) in (
          select k.workspace_id, k.person_id, k.native_session_id
          from sherlock_access.owner_excluded_native_keys() k))
        and not ((workspace_id, person_id, coalesce(observed_parent_native_session_id, '')) in (
          select k.workspace_id, k.person_id, k.native_session_id
          from sherlock_access.owner_excluded_native_keys() k))
      );
  end if;
  -- The ingest function runs as sherlock_ingest and may only record.
  grant usage on schema sherlock_access to sherlock_ingest;
  grant execute on function sherlock_access.record_owner_session_exclusions(uuid, uuid, text[]) to sherlock_ingest;

  comment on function sherlock_access.excluded_native_session_ids(timestamptz) is
    'Owner-excluded native session ids (roots and descendants) with the time each became excluded; after p_after when given.';
  comment on function public.sherlock_excluded_native_session_ids(timestamptz) is
    'PostgREST wrapper for sherlock_access.excluded_native_session_ids(timestamptz).';
  comment on function sherlock_access.record_owner_session_exclusions(uuid, uuid, text[]) is
    'Additively records a collector''s excluded native session ids for its own person; returns newly stored and distinct counts.';
end
$migration$;

create or replace function analytics._assert_excerpt_search_policy_shape()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $gate$
declare
  c_tables constant regclass[] := array[
    'telemetry.events'::regclass, 'telemetry.sessions'::regclass, 'telemetry.people'::regclass
  ];
  v_search regprocedure := pg_catalog.to_regprocedure(
    'analytics.search_excerpt_candidates(uuid,text,timestamptz,timestamptz,timestamptz,text,uuid,uuid,integer)'
  );
  v_gate regprocedure := pg_catalog.to_regprocedure('analytics._assert_excerpt_search_policy_shape()');
  v_reader oid;
  v_owner oid;
  v_matched integer;
  v_applicable integer;
begin
  select r.oid into v_reader
    from pg_catalog.pg_roles r
   where r.rolname = 'sherlock_reader' and not r.rolsuper and not r.rolbypassrls;
  select p.proowner into v_owner
    from pg_catalog.pg_proc p
   where p.oid = v_search
     and p.proowner = (select g.proowner from pg_catalog.pg_proc g where g.oid = v_gate);
  if v_reader is null or v_owner is null then
    raise exception using errcode = '55000', message = 'excerpt_search_policy_unrecognized',
      detail = 'reader role or function owner';
  end if;

  -- Only the reader may execute the search, and nobody but the owner the gate.
  if (select p.proacl is null from pg_catalog.pg_proc p where p.oid = v_search)
     or exists (
       select from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
        where p.oid = v_search
          and not (a.privilege_type = 'EXECUTE'
                   and (a.grantee = v_owner or (a.grantee = v_reader and not a.is_grantable))))
     or not exists (
       select from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
        where p.oid = v_search and a.grantee = v_reader)
     or (select p.proacl is null from pg_catalog.pg_proc p where p.oid = v_gate)
     or exists (
       select from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
        where p.oid = v_gate and a.grantee <> v_owner)
     or exists (
       select from pg_catalog.pg_roles r
        where r.rolname in ('anon', 'authenticated', 'service_role')
          and pg_catalog.pg_has_role(r.oid, v_reader, 'MEMBER'))
  then
    raise exception using errcode = '55000', message = 'excerpt_search_policy_unrecognized',
      detail = 'function privileges';
  end if;

  -- Candidate IDs/scores are a term oracle, so revoking the reader's table
  -- access must disable nomination as well as the ordinary RLS recheck.
  if exists (select from pg_catalog.unnest(c_tables) t(relid)
              where not pg_catalog.has_table_privilege(v_reader, t.relid, 'SELECT')) then
    raise exception using errcode = '55000', message = 'excerpt_search_policy_unrecognized',
      detail = 'reader table privileges';
  end if;

  -- Plain tables that the owner reads without RLS and the reader does not.
  if (select pg_catalog.count(*) from pg_catalog.pg_class c where c.oid = any (c_tables)
       and c.relkind = 'r' and not c.relispartition and not c.relhassubclass
       and not exists (select from pg_catalog.pg_inherits i where i.inhrelid = c.oid)
       and not c.relforcerowsecurity
       and not pg_catalog.pg_has_role(v_reader, c.relowner, 'USAGE')
       and (pg_catalog.pg_has_role(v_owner, c.relowner, 'USAGE')
            or exists (select from pg_catalog.pg_roles r
                        where r.oid = v_owner and (r.rolsuper or r.rolbypassrls)))) <> 3
  then
    raise exception using errcode = '55000', message = 'excerpt_search_policy_unrecognized',
      detail = 'table ownership or row security';
  end if;

  if pg_catalog.to_regnamespace('sherlock_access') is null then
    if exists (select from pg_catalog.pg_class c where c.oid = any (c_tables) and c.relrowsecurity)
       or exists (select from pg_catalog.pg_policy p where p.polrelid = any (c_tables))
    then
      raise exception using errcode = '55000', message = 'excerpt_search_policy_unrecognized',
        detail = 'row security without the privacy schema';
    end if;
    return false;
  end if;

  if exists (select from pg_catalog.pg_class c where c.oid = any (c_tables) and not c.relrowsecurity) then
    raise exception using errcode = '55000', message = 'excerpt_search_policy_unrecognized',
      detail = 'row security disabled';
  end if;

  -- Every SELECT/ALL policy that reaches the reader, directly, through PUBLIC,
  -- or through an inherited role, must be the single pinned permissive reader
  -- policy of its table. Policies for roles the reader cannot use are ignored.
  with pinned (relid, qual) as (
    values
      ('telemetry.events'::regclass, $qual$
CASE
    WHEN ( SELECT sherlock_access.private_principal() AS private_principal) THEN ((source_record_id IN ( SELECT sherlock_access.protected_record_ids() AS protected_record_ids)) AND ((session_id IS NULL) OR (session_id IN ( SELECT sherlock_access.private_session_ids() AS private_session_ids))) AND ((related_session_id IS NULL) OR (related_session_id IN ( SELECT sherlock_access.private_session_ids() AS private_session_ids))))
    ELSE ((NOT (source_record_id IN ( SELECT sherlock_access.protected_record_ids() AS protected_record_ids))) AND ((session_id IS NULL) OR (NOT (session_id IN ( SELECT sherlock_access.hidden_session_ids() AS hidden_session_ids)))) AND ((related_session_id IS NULL) OR (NOT (related_session_id IN ( SELECT sherlock_access.hidden_session_ids() AS hidden_session_ids)))))
END$qual$),
      ('telemetry.sessions'::regclass, $qual$
CASE
    WHEN ( SELECT sherlock_access.private_principal() AS private_principal) THEN (id IN ( SELECT sherlock_access.private_session_ids() AS private_session_ids))
    ELSE (NOT (id IN ( SELECT sherlock_access.hidden_session_ids() AS hidden_session_ids)))
END$qual$),
      ('telemetry.people'::regclass, $qual$
CASE
    WHEN ( SELECT sherlock_access.private_principal() AS private_principal) THEN (id IN ( SELECT sherlock_access.protected_person_ids() AS protected_person_ids))
    ELSE (NOT (id IN ( SELECT sherlock_access.protected_person_ids() AS protected_person_ids)))
END$qual$)
  ), applicable as (
    select p.*
      from pg_catalog.pg_policy p
     where p.polrelid = any (c_tables)
       and p.polcmd in ('r', '*')
       and (0::oid = any (p.polroles)
            or exists (select from pg_catalog.unnest(p.polroles) r(roleid)
                        where r.roleid <> 0 and pg_catalog.pg_has_role(v_reader, r.roleid, 'USAGE')))
  ), normalized as (
    -- PR117 normalization: whitespace layout and punctuation spacing only.
    select a.polrelid, a.polcmd, a.polpermissive, a.polroles, a.polwithcheck,
      pg_catalog.rtrim(pg_catalog.regexp_replace(pg_catalog.btrim(pg_catalog.regexp_replace(
        pg_catalog.pg_get_expr(a.polqual, a.polrelid), '\s+', ' ', 'g')), ' ?([=,().;]) ?', '\1', 'g'), ';') qual
      from applicable a
  )
  select
    (select pg_catalog.count(distinct n.polrelid)
       from normalized n
       join pinned k on k.relid = n.polrelid
      where n.polcmd = 'r' and n.polpermissive and n.polwithcheck is null
        and n.polroles = array[v_reader]
        and n.qual = pg_catalog.rtrim(pg_catalog.regexp_replace(pg_catalog.btrim(pg_catalog.regexp_replace(
              k.qual, '\s+', ' ', 'g')), ' ?([=,().;]) ?', '\1', 'g'), ';')),
    (select pg_catalog.count(*) from applicable)
  into v_matched, v_applicable;
  if v_matched <> 3 or v_applicable <> 3 then
    raise exception using errcode = '55000', message = 'excerpt_search_policy_unrecognized',
      detail = 'reader policies';
  end if;

  -- COR-5002: the helpers below also hide owner-excluded sessions.
  -- The policies and this search call the same definer helpers in the same
  -- snapshot; pinning them also guarantees they never depend on the caller.
  with pinned (signature, rettype, retset, body) as (
    values
      ('sherlock_access.private_principal()', 'boolean'::regtype, false, $body$
 select session_user='sherlock_aqil_private_login'
 and pg_has_role(session_user,'sherlock_reader','member')
$body$),
      ('sherlock_access.protected_person_ids()', 'uuid'::regtype, true, $body$
 select person_id from sherlock_access.restricted_people
$body$),
      ('sherlock_access.private_session_ids()', 'uuid'::regtype, true, $body$
 select s.id from telemetry.sessions s
 join sherlock_access.restricted_people r on r.workspace_id=s.workspace_id and r.person_id=s.person_id
 where (s.parent_session_id is null or exists(
 select 1 from telemetry.sessions parent
 join sherlock_access.restricted_people pr on pr.workspace_id=parent.workspace_id and pr.person_id=parent.person_id
 where parent.workspace_id=s.workspace_id and parent.id=s.parent_session_id))
 and s.id not in (select x.session_id from sherlock_access.owner_excluded_sessions() x)
$body$),
      ('sherlock_access.hidden_session_ids()', 'uuid'::regtype, true, $body$
 select s.id from telemetry.sessions s
 join sherlock_access.restricted_people r on r.workspace_id=s.workspace_id and r.person_id=s.person_id
 union
 select child.id from telemetry.sessions parent
 join sherlock_access.restricted_people r on r.workspace_id=parent.workspace_id and r.person_id=parent.person_id
 join telemetry.sessions child on child.workspace_id=parent.workspace_id and child.parent_session_id=parent.id
 union
 select x.session_id from sherlock_access.owner_excluded_sessions() x
$body$),
      ('sherlock_access.protected_record_ids()', 'bigint'::regtype, true, $body$
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
union all
select n.id
from telemetry.workspaces w
cross join lateral (
  select e.source_record_id
  from telemetry.events e
  where e.workspace_id = w.id and e.session_id is null
  offset 0
) e
join telemetry.native_records n on n.workspace_id = w.id and n.id = e.source_record_id
join telemetry.ingest_batches b on b.workspace_id = n.workspace_id and b.id = n.batch_id
where exists (select from sherlock_access.owner_session_exclusions)
  and ((b.workspace_id, b.person_id, b.observed_native_session_id) in (
         select k.workspace_id, k.person_id, k.native_session_id
         from sherlock_access.owner_excluded_native_keys() k)
    or (b.workspace_id, b.person_id, b.observed_parent_native_session_id) in (
         select k.workspace_id, k.person_id, k.native_session_id
         from sherlock_access.owner_excluded_native_keys() k))
$body$),
      ('sherlock_access.owner_excluded_sessions()', 'record'::regtype, true, $body$
with recursive roots as (
  select s.workspace_id, s.person_id, s.id, s.native_session_id, s.created_at, x.added_at
  from sherlock_access.owner_session_exclusions x
  join telemetry.sessions s
    on s.workspace_id = x.workspace_id and s.person_id = x.person_id
   and s.native_session_id = x.native_session_id
  union all
  select s.workspace_id, s.person_id, s.id, s.native_session_id, s.created_at, x.added_at
  from sherlock_access.owner_session_exclusions x
  join telemetry.sessions s
    on s.workspace_id = x.workspace_id and s.person_id = x.person_id
   and s.parent_session_id is null and s.parent_native_session_id = x.native_session_id
), hidden (workspace_id, person_id, session_id, native_session_id, created_at, root_added_at, depth) as (
  select r.workspace_id, r.person_id, r.id, r.native_session_id, r.created_at, r.added_at, 0
  from roots r
  union all
  select c.workspace_id, c.person_id, c.id, c.native_session_id, c.created_at, h.root_added_at, h.depth + 1
  from hidden h
  cross join lateral (
    select k.workspace_id, k.person_id, k.id, k.native_session_id, k.created_at
    from telemetry.sessions k
    where k.workspace_id = h.workspace_id and k.person_id = h.person_id
      and k.parent_session_id = h.session_id
    union all
    select k.workspace_id, k.person_id, k.id, k.native_session_id, k.created_at
    from telemetry.sessions k
    where k.workspace_id = h.workspace_id and k.person_id = h.person_id
      and k.parent_session_id is null and k.parent_native_session_id = h.native_session_id
  ) c
  where h.depth < 64
)
select h.workspace_id, h.person_id, h.session_id, h.native_session_id,
  min(greatest(h.root_added_at, h.created_at)) as added_at
from hidden h
group by h.workspace_id, h.person_id, h.session_id, h.native_session_id
$body$),
      ('sherlock_access.owner_excluded_native_keys()', 'record'::regtype, true, $body$
select k.workspace_id, k.person_id, k.native_session_id, min(k.added_at) as added_at
from (
  select x.workspace_id, x.person_id, x.native_session_id, x.added_at
  from sherlock_access.owner_session_exclusions x
  union all
  select s.workspace_id, s.person_id, s.native_session_id, s.added_at
  from sherlock_access.owner_excluded_sessions() s
) k
group by k.workspace_id, k.person_id, k.native_session_id
$body$)
  )
  select pg_catalog.count(distinct p.oid)
    into v_matched
    from pinned k
    join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(k.signature)
   where p.prokind = 'f'
     and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'sql')
     and p.prosecdef and p.provolatile = 's'
     and p.proconfig = array['search_path=""']
     and p.prosqlbody is null
     and p.prorettype = k.rettype and p.proretset = k.retset
     and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = 'postgres')
     and pg_catalog.rtrim(pg_catalog.regexp_replace(pg_catalog.btrim(pg_catalog.regexp_replace(
           p.prosrc, '\s+', ' ', 'g')), ' ?([=,().;]) ?', '\1', 'g'), ';')
       = pg_catalog.rtrim(pg_catalog.regexp_replace(pg_catalog.btrim(pg_catalog.regexp_replace(
           k.body, '\s+', ' ', 'g')), ' ?([=,().;]) ?', '\1', 'g'), ';');
  if v_matched <> 7 then
    raise exception using errcode = '55000', message = 'excerpt_search_policy_unrecognized',
      detail = 'privacy helpers';
  end if;

  return true;
end
$gate$;


-- Deploying against an unrecognized policy state fails here instead of at the first search.
do $verify$
begin
  perform analytics._assert_excerpt_search_policy_shape();
end
$verify$;
