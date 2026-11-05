-- COR-5178: a narrow presence read for the Heartbeat leaf.
--
-- Heartbeat reads the old logger's codex_sessions and sees 7 of the 13 people
-- Sherlock sees. This function gives it who is actively coding, with which
-- agent, and when they were last active: ids, names and timestamps only, never
-- titles, branches, prompts or message content.
--
-- It runs as its owner, so it applies Sherlock's privacy rules itself:
-- sessions in sherlock_access.hidden_session_ids() (restricted people, their
-- child sessions, owner-excluded sessions) and the smoke-test account are left
-- out. sherlock_access is production-only, so the filter applies when present.
--
-- Access is one NOLOGIN role, sherlock_presence_reader, with EXECUTE on this
-- function and nothing else. The Heartbeat login (with its password) is
-- created outside migrations and granted this role.

create schema if not exists heartbeat_api;
revoke all on schema heartbeat_api from public;

do $role$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'sherlock_presence_reader') then
    create role sherlock_presence_reader nologin;
  end if;
end
$role$;
grant usage on schema heartbeat_api to sherlock_presence_reader;

create or replace function heartbeat_api.coding_presence(p_window_minutes integer default 120)
returns table (
  workspace_id uuid,
  person_id uuid,
  email text,
  display_name text,
  agent text,
  session_count bigint,
  primary_session_count bigint,
  last_activity_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_since timestamptz;
  v_filter boolean := pg_catalog.to_regprocedure('sherlock_access.hidden_session_ids()') is not null;
begin
  if p_window_minutes is null or p_window_minutes < 1 or p_window_minutes > 1440 then
    raise exception using errcode = '22023', message = 'coding_presence_window_invalid';
  end if;
  v_since := pg_catalog.now() - pg_catalog.make_interval(mins => p_window_minutes);
  return query execute pg_catalog.format($query$
    with activity as materialized (
      select w.id workspace_id, a.session_id, a.last_activity_at
        from telemetry.workspaces w
        cross join lateral (
          select e.session_id, pg_catalog.max(e.occurred_at) last_activity_at
            from telemetry.events e
           where e.workspace_id = w.id and e.event_kind = 'usage' and not e.is_replay
             and e.occurred_at >= $1 and e.occurred_at <= pg_catalog.now() + interval '5 minutes'
             and e.session_id is not null
           group by e.session_id
        ) a
    ), sessions as materialized (
      select a.workspace_id, a.session_id, a.last_activity_at, s.person_id, s.actor_role,
             (select case
                       when x.normalizer_version like 'sherlock.claude-code-transcript.%%' then 'claude'
                       when x.normalizer_version like 'sherlock.codex-rollout.%%' then 'codex'
                       else 'unknown' end
                from telemetry.events x
               where x.workspace_id = a.workspace_id and x.session_id = a.session_id
                 and x.event_kind = 'usage' and not x.is_replay
               order by x.occurred_at desc limit 1) agent
        from activity a
        join telemetry.sessions s on s.workspace_id = a.workspace_id and s.id = a.session_id
    )
    select s.workspace_id, pe.id, pe.email,
           coalesce(nullif(pg_catalog.btrim(pe.display_name), ''), 'Unknown'), s.agent,
           pg_catalog.count(*)::bigint,
           (pg_catalog.count(*) filter (where s.actor_role = 'primary'))::bigint,
           pg_catalog.max(s.last_activity_at)
      from sessions s
      join telemetry.people pe on pe.workspace_id = s.workspace_id and pe.id = s.person_id
     where pe.github_id is distinct from 'sherlock-smoke'
       %s
     group by s.workspace_id, pe.id, pe.email, pe.display_name, s.agent
     order by pg_catalog.max(s.last_activity_at) desc
  $query$, case when v_filter
    then 'and s.session_id not in (select h from sherlock_access.hidden_session_ids() h)'
    else '' end) using v_since;
end
$body$;
comment on function heartbeat_api.coding_presence(integer) is
  'COR-5178: per person and agent, sessions with model activity in the last p_window_minutes (1-1440) and the latest activity time. Ids, names and times only.';

revoke all on function heartbeat_api.coding_presence(integer) from public;
do $revoke$
begin
  if exists (select from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function heartbeat_api.coding_presence(integer) from anon, authenticated, service_role;
  end if;
end
$revoke$;
grant execute on function heartbeat_api.coding_presence(integer) to sherlock_presence_reader;
