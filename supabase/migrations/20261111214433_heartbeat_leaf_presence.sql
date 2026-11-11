-- COR-5178: the Cosmos Heartbeat leaf (e3-heartbeat) reads all presence from Sherlock.
--
-- who_is_active already uses heartbeat_api.coding_presence. person_presence and
-- presence_history still read the old Codex logger store, which has had no Codex
-- data since Nov 4, so every Codex user looks idle. Two small functions give the
-- leaf the same facts from Sherlock:
--   person_sessions(emails, window_minutes)  top-level sessions active in the last <= 24 h
--                                            for up to 100
--                                            people (branch for who_is_active, the
--                                            session list for person_presence)
--   hourly_sessions(hours)                   sessions per person per hour, for the
--                                            aggregate presence_history
--
-- Same rules as 20261106010557_heartbeat_read_functions.sql: owner rights, the E3
-- workspace only, hidden sessions and the smoke-test account dropped, no content
-- (a session is named by heartbeat_api.session_key, never its id; repo URLs lose
-- any credentials), executable only by the NOLOGIN role sherlock_presence_reader.
--
-- Activity is model usage, as in coding_presence: a session's last activity is its
-- latest usage event.
--
-- It also creates heartbeat_leaf_login, the leaf's login, as a member of
-- sherlock_presence_reader with no other grants of its own. Like every login here it
-- still holds what PUBLIC holds (notably pg_net's net schema); narrowing PUBLIC is a
-- separate change. The role is created here WITHOUT a
-- password, so it cannot log in yet; the password is set separately as a SCRAM
-- verifier and never appears in migration history.

set lock_timeout = '1s';

create or replace function heartbeat_api.person_sessions(
  p_emails text[],
  p_window_minutes integer default 1440
)
returns table (
  person_id uuid,
  email text,
  display_name text,
  session_key text,
  agent text,
  repo_remote text,
  branch text,
  started_at timestamptz,
  ended_at timestamptz,
  last_activity_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_ws uuid := heartbeat_api.e3_workspace_id();
  v_since timestamptz;
begin
  if p_window_minutes is null or p_window_minutes < 1 or p_window_minutes > 1440 then
    raise exception using errcode = '22023', message = 'person_sessions_window_invalid';
  end if;
  if p_emails is null or pg_catalog.cardinality(p_emails) < 1
     or pg_catalog.cardinality(p_emails) > 100 then
    raise exception using errcode = '22023', message = 'person_sessions_emails_invalid';
  end if;
  v_since := pg_catalog.now() - pg_catalog.make_interval(mins => p_window_minutes);
  return query
  with who as materialized (
    select pe.id, pe.email, pe.display_name
      from telemetry.people pe
     where pe.workspace_id = v_ws
       and pg_catalog.lower(pe.email) in (select pg_catalog.lower(x) from pg_catalog.unnest(p_emails) x)
       and pe.github_id is distinct from 'sherlock-smoke'
  ), recent as materialized (
    -- Sessions with model usage in the window, found the way coding_presence finds them
    -- (index-only scan of events_usage_window_idx), so a long-running session counts no
    -- matter when it started.
    select e.session_id, pg_catalog.max(e.occurred_at) last_activity_at
      from telemetry.events e
     where e.workspace_id = v_ws and e.event_kind = 'usage' and not e.is_replay
       and e.occurred_at >= v_since and e.occurred_at <= pg_catalog.now() + interval '5 minutes'
       and e.session_id is not null
     group by e.session_id
  ), activity as materialized (
    -- Top-level sessions only (a Claude session with subagents is one agent).
    select s.id, s.person_id, s.repo_remote, s.branch, s.started_at, s.ended_at,
           r.last_activity_at,
           (select case when x.normalizer_version like 'sherlock.claude-code-transcript.%' then 'claude'
                        when x.normalizer_version like 'sherlock.codex-rollout.%' then 'codex'
                        else 'unknown' end
              from telemetry.events x
             where x.workspace_id = v_ws and x.session_id = s.id
               and x.event_kind = 'usage' and not x.is_replay
             order by x.occurred_at desc limit 1) agent
      from recent r
      join telemetry.sessions s on s.workspace_id = v_ws and s.id = r.session_id
     where s.person_id in (select w.id from who w)
       and s.actor_role = 'primary'
       and s.id not in (select h from heartbeat_api.hidden_sessions() h)
  ), ranked as materialized (
    select a.*, pg_catalog.row_number() over (
             partition by a.person_id order by a.last_activity_at desc, a.id) rn
      from activity a
  )
  select w.id, w.email, coalesce(nullif(pg_catalog.btrim(w.display_name), ''), 'Unknown'),
         heartbeat_api.session_key(a.id), a.agent,
         pg_catalog.regexp_replace(a.repo_remote, '://[^/@]*@', '://'),
         a.branch, a.started_at, a.ended_at, a.last_activity_at
    from ranked a
    join who w on w.id = a.person_id
   where a.rn <= 50  -- at most 50 sessions per person
   order by w.id, a.last_activity_at desc;
end
$body$;

create or replace function heartbeat_api.hourly_sessions(p_hours integer default 24)
returns table (
  person_id uuid,
  email text,
  hour_start timestamptz,
  sessions bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_ws uuid := heartbeat_api.e3_workspace_id();
  v_since timestamptz;
begin
  if p_hours is null or p_hours < 1 or p_hours > 168 then
    raise exception using errcode = '22023', message = 'hourly_sessions_hours_invalid';
  end if;
  -- Whole hours: the window starts at the top of the hour p_hours - 1 hours ago.
  v_since := pg_catalog.date_trunc('hour', pg_catalog.now())
             - pg_catalog.make_interval(hours => p_hours - 1);
  return query
  with activity as materialized (
    select e.session_id, pg_catalog.max(e.occurred_at) last_activity_at
      from telemetry.events e
     where e.workspace_id = v_ws and e.event_kind = 'usage' and not e.is_replay
       and e.occurred_at >= v_since and e.occurred_at <= pg_catalog.now() + interval '5 minutes'
       and e.session_id is not null
     group by e.session_id
  )
  -- Each top-level session counts once, in the hour of its latest activity.
  select pe.id, pe.email, pg_catalog.date_trunc('hour', a.last_activity_at),
         pg_catalog.count(*)::bigint
    from activity a
    join telemetry.sessions s on s.workspace_id = v_ws and s.id = a.session_id
    join telemetry.people pe on pe.workspace_id = v_ws and pe.id = s.person_id
   where s.actor_role = 'primary'
     and pe.github_id is distinct from 'sherlock-smoke'
     and a.session_id not in (select h from heartbeat_api.hidden_sessions() h)
   group by pe.id, pe.email, pg_catalog.date_trunc('hour', a.last_activity_at);
end
$body$;

revoke all on function heartbeat_api.person_sessions(text[], integer) from public;
revoke all on function heartbeat_api.hourly_sessions(integer) from public;
grant execute on function heartbeat_api.person_sessions(text[], integer) to sherlock_presence_reader;
grant execute on function heartbeat_api.hourly_sessions(integer) to sherlock_presence_reader;

-- The leaf's login. No password here (it cannot log in until one is set out of band).
do $do$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'heartbeat_leaf_login') then
    create role heartbeat_leaf_login login inherit nosuperuser nocreatedb nocreaterole
      noreplication nobypassrls connection limit 10;
  end if;
end
$do$;
grant sherlock_presence_reader to heartbeat_leaf_login;
alter role heartbeat_leaf_login set statement_timeout = '15s';
alter role heartbeat_leaf_login set idle_in_transaction_session_timeout = '30s';
alter role heartbeat_leaf_login set default_transaction_read_only = on;
-- If an earlier attempt created the role with another limit, set it here too.
alter role heartbeat_leaf_login connection limit 10;

reset lock_timeout;
