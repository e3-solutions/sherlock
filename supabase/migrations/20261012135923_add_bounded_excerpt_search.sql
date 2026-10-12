-- The reader's excerpt search cannot use events_message_search_idx: the
-- production RLS policies on events, sessions, and people make PostgreSQL keep
-- the non-leakproof @@ (ts_match_vq) above the policy quals, so rare and no-hit
-- terms scan every message under the reader's statement timeout.
--
-- analytics.search_excerpt_candidates() runs one static query as the table
-- owner, which bypasses RLS and can use the GIN index, and applies the public
-- reader policy predicates explicitly before the LIMIT. It returns only event
-- ids and scores (at most p_limit + 1, so the caller can see overflow); the
-- caller rechecks those ids under normal RLS before reading any excerpt.
--
-- The explicit predicates are only equivalent to RLS while the live policies
-- and privacy helpers match what this file pins, so every call first runs
-- analytics._assert_excerpt_search_policy_shape(). It recognizes exactly two
-- states: no optional sherlock_access schema and no RLS on the three tables,
-- or the current production policies and helpers. Catalog text is compared to
-- the pinned constants and never executed. Anything else fails closed, so any
-- edit to those policies or helpers disables search until this pin is updated
-- by a reviewed migration. The private principal is deliberately unsupported.
--
-- New functions only: no raw telemetry, index, policy, role, or table grant
-- changes.
create function analytics._assert_excerpt_search_policy_shape()
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
 where s.parent_session_id is null or exists(
 select 1 from telemetry.sessions parent
 join sherlock_access.restricted_people pr on pr.workspace_id=parent.workspace_id and pr.person_id=parent.person_id
 where parent.workspace_id=s.workspace_id and parent.id=s.parent_session_id)
$body$),
      ('sherlock_access.hidden_session_ids()', 'uuid'::regtype, true, $body$
 select s.id from telemetry.sessions s
 join sherlock_access.restricted_people r on r.workspace_id=s.workspace_id and r.person_id=s.person_id
 union
 select child.id from telemetry.sessions parent
 join sherlock_access.restricted_people r on r.workspace_id=parent.workspace_id and r.person_id=parent.person_id
 join telemetry.sessions child on child.workspace_id=parent.workspace_id and child.parent_session_id=parent.id
$body$),
      ('sherlock_access.protected_record_ids()', 'bigint'::regtype, true, $body$
 select n.id from sherlock_access.restricted_people r
 join telemetry.ingest_batches b on b.workspace_id=r.workspace_id and b.person_id=r.person_id
 join telemetry.native_records n on n.workspace_id=b.workspace_id and n.batch_id=b.id
$body$),
      -- The bounded body installed by 20261012065436_bound_protected_record_lookup.sql.
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
  if v_matched <> 5 then
    raise exception using errcode = '55000', message = 'excerpt_search_policy_unrecognized',
      detail = 'privacy helpers';
  end if;

  return true;
end
$gate$;

comment on function analytics._assert_excerpt_search_policy_shape() is
  'Fails closed unless excerpt search predicates still equal the live reader RLS; true when the privacy schema is present.';

create function analytics.search_excerpt_candidates(
  p_workspace uuid,
  p_query text,
  p_start timestamptz,
  p_end timestamptz,
  p_read_at timestamptz,
  p_domain text,
  p_person uuid default null,
  p_session uuid default null,
  p_limit integer default 2000
)
returns table (event_id bigint, score real)
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $search$
declare
  v_query tsquery;
  v_privacy boolean;
  v_protected_records bigint[] := '{}';
  v_hidden_sessions uuid[] := '{}';
  v_protected_people uuid[] := '{}';
begin
  -- The normal reader transaction sets this role; members that did not are refused.
  if pg_catalog.current_setting('role') is distinct from 'sherlock_reader' then
    raise exception using errcode = '42501', message = 'excerpt_search_role_required';
  end if;
  if p_workspace is null or p_query is null or p_domain is null or p_limit is null
     or p_start is null or p_end is null or p_read_at is null
     or not (pg_catalog.isfinite(p_start) and pg_catalog.isfinite(p_end) and pg_catalog.isfinite(p_read_at))
     or p_start >= p_end or p_end > p_read_at or p_read_at > pg_catalog.clock_timestamp() + interval '5 seconds'
     or p_domain not in ('e3group.ai', 'sixtyfour.ai')
     or p_limit not between 1 and 2000
     or pg_catalog.char_length(p_query) not between 2 and 256
  then
    raise exception using errcode = '22023', message = 'excerpt_search_invalid_argument';
  end if;
  -- Allow at most five seconds of app/DB clock skew; a caller cannot advance
  -- the transaction snapshot. Larger future cuts fail closed.
  -- Empty and negation-only queries cannot use the index.
  v_query := pg_catalog.websearch_to_tsquery('simple'::regconfig, p_query);
  if pg_catalog.numnode(v_query) not between 1 and 31
     or pg_catalog.querytree(v_query) in ('', 'T')
  then
    raise exception using errcode = '22023', message = 'excerpt_search_invalid_query';
  end if;

  v_privacy := analytics._assert_excerpt_search_policy_shape();
  if v_privacy then
    if sherlock_access.private_principal() is distinct from false then
      raise exception using errcode = '0A000', message = 'excerpt_search_private_principal_unsupported';
    end if;
    -- array_agg keeps NULL members, so the = any tests below stay as
    -- three-valued as the policies' NOT IN.
    select coalesce(pg_catalog.array_agg(r.id), '{}') into v_protected_records
      from sherlock_access.protected_record_ids() r(id);
    select coalesce(pg_catalog.array_agg(h.id), '{}') into v_hidden_sessions
      from sherlock_access.hidden_session_ids() h(id);
    select coalesce(pg_catalog.array_agg(pp.id), '{}') into v_protected_people
      from sherlock_access.protected_person_ids() pp(id);
  end if;

  -- Every filter applies before the LIMIT; the subset is unordered on overflow.
  return query
  select e.id, pg_catalog.ts_rank_cd(e.message_search, v_query, 32)
    from telemetry.events e
    join telemetry.sessions s on s.workspace_id = e.workspace_id and s.id = e.session_id
    join telemetry.people pe on pe.workspace_id = s.workspace_id and pe.id = s.person_id
   where e.workspace_id = p_workspace
     and e.event_kind in ('message', 'agent_message')
     and e.message_search operator(pg_catalog.@@) v_query
     and not e.is_replay
     and e.content_excerpt is not null
     -- Versioned product-view filter: runtime user envelopes cannot consume
     -- the candidate budget. This does not change canonical prompt counts.
     and (e.message_role is distinct from 'user' or e.content_excerpt !~ '^[[:space:]]*(<recommended_plugins>|<in\-app\-browser\-context|<app\-context|<skills_instructions|<permissions instructions|<permissions_instructions>|<environment_context>|<collaboration_mode>|<apps_instructions>|<plugins_instructions>|<codex_delegation>|<heartbeat>|<turn_aborted>|<automation|<skill>|\# AGENTS\.md instructions|\# Bonaparte Implementation|The configured soft phase budget has expired\.|<external_codex_apps_open_page>|The following is the Codex agent history)')
     and e.occurred_at >= p_start and e.occurred_at < p_end
     and e.server_received_at <= p_read_at
     and pe.github_id is distinct from 'sherlock-smoke'
     and pg_catalog.split_part(pe.email, '@', 2) = p_domain
     and pg_catalog.split_part(pe.email, '@', 3) = ''
     and (p_person is null or s.person_id = p_person)
     and (p_session is null or s.id = p_session)
     -- The public branch of the pinned reader policies.
     and not (e.source_record_id in (select pg_catalog.unnest(v_protected_records)))
     and (e.session_id is null or not (e.session_id in (select pg_catalog.unnest(v_hidden_sessions))))
     and (e.related_session_id is null or not (e.related_session_id in (select pg_catalog.unnest(v_hidden_sessions))))
     and not (s.id in (select pg_catalog.unnest(v_hidden_sessions)))
     and not (pe.id in (select pg_catalog.unnest(v_protected_people)))
   limit p_limit + 1;
end
$search$;

comment on function analytics.search_excerpt_candidates(uuid, text, timestamptz, timestamptz, timestamptz, text, uuid, uuid, integer) is
  'Reader-visible excerpt search candidate event ids and scores, at most p_limit + 1; recheck under RLS before reading.';

revoke all on function analytics._assert_excerpt_search_policy_shape()
  from public, anon, authenticated, service_role, sherlock_reader;
revoke all on function analytics.search_excerpt_candidates(uuid, text, timestamptz, timestamptz, timestamptz, text, uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function analytics.search_excerpt_candidates(uuid, text, timestamptz, timestamptz, timestamptz, text, uuid, uuid, integer)
  to sherlock_reader;

-- Deploying against an unrecognized policy state fails here instead of at the first search.
do $verify$
begin
  perform analytics._assert_excerpt_search_policy_shape();
end
$verify$;
