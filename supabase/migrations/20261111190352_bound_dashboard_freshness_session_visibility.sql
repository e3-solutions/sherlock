-- Run the existing session visibility check once per recent session key.
-- Check source visibility once per recent ingest batch. Keep the event window
-- index, roster, and canonical rank.
-- The local migration history has no privacy helpers in this function; the
-- deployed definition does. Accept either known activity block, without
-- replacing the rest of the deployed definition.
set local lock_timeout = '1s';
set local statement_timeout = '5s';

do $migration$
declare
  target regprocedure := 'analytics.read_dashboard_freshness(uuid,text,text[],integer)'::regprocedure;
  before_change pg_catalog.pg_proc%rowtype;
  after_change pg_catalog.pg_proc%rowtype;
  activity_start constant text := '  ), activity_candidates as materialized (';
  activity_end constant text := '  ), latest_activity as materialized (';
  observed_start constant text := '           coalesce(';
  rank_start constant text := '           case when e.canonical_scope_key';
  source_start constant text := '      from telemetry.events e';
  provider_start constant text := '       and e.normalizer_version';
  definition text;
  replacement text;
  activity text;
  start_at integer;
  end_at integer;
  observed_at text;
  ranking text;
  filters text;
  primary_distinct text := 'distinct ';
  related_keys text := '';
  record_ctes text := '';
  session_guard text := '';
  related_guard text := '';
  related_column text := '';
  record_column text := '';
begin
  select * into strict before_change from pg_catalog.pg_proc where oid = target;
  if not before_change.prosecdef or before_change.provolatile <> 's' then
    raise exception 'Unexpected security or volatility for %', target;
  end if;

  definition := pg_catalog.pg_get_functiondef(target);
  start_at := strpos(definition, activity_start);
  end_at := strpos(definition, activity_end);
  if start_at = 0 or end_at <= start_at then
    raise exception 'Expected an activity candidate block in %', target;
  end if;
  activity := substr(definition, start_at, end_at - start_at);
  case pg_catalog.md5(activity)
    when '22e7c5d51f526d1655b4811412a35cb3' then
      null; -- repository definition does not call the optional privacy helpers
    when 'd3746b0ec0de174d9cbd41d428c703b0' then
      -- The related-session map assumes that session_visible requires an
      -- existing session. The source-record map expands record_visible's
      -- exact native record lookup and still calls its batch helper.
      if pg_catalog.md5(pg_catalog.pg_get_functiondef(
             'sherlock_access.session_visible(uuid,uuid)'::regprocedure
           )) is distinct from 'aad4d06f91df97ad08c63d02e4328e48'
         or pg_catalog.md5(pg_catalog.pg_get_functiondef(
             'sherlock_access.record_visible(uuid,bigint)'::regprocedure
           )) is distinct from '9ddc5fb7dfb211890e29e5d7ae078630'
         or pg_catalog.md5(pg_catalog.pg_get_functiondef(
             'sherlock_access.batch_visible(uuid,uuid)'::regprocedure
           )) is distinct from '6b6ff0ac915c20f2b85de52b5b8ebe52' then
        raise exception 'Unrecognized visibility helpers for %', target;
      end if;
      primary_distinct := ''; -- UNION with related keys already deduplicates
      record_ctes := $records$  ), recent_record_keys as materialized (
    select distinct workspace_id, source_record_id
      from recent_events
     where source_record_id is not null
  ), recent_records as materialized (
    select k.workspace_id, k.source_record_id, r.batch_id
      from recent_record_keys k
      cross join lateral (
        select r.batch_id
          from telemetry.native_records r
         where r.workspace_id = k.workspace_id and r.id = k.source_record_id
         offset 0
      ) r
  ), recent_batch_keys as materialized (
    select distinct workspace_id, batch_id from recent_records
  ), visible_recent_batches as materialized (
    select workspace_id, batch_id
      from recent_batch_keys
     where sherlock_access.batch_visible(workspace_id, batch_id)
  ), visible_recent_records as materialized (
    select r.workspace_id, r.source_record_id
      from recent_records r
      join visible_recent_batches b
        on b.workspace_id = r.workspace_id and b.batch_id = r.batch_id
$records$;
      related_keys := $related$    union
    select workspace_id, related_session_id from recent_events
     where related_session_id is not null
$related$;
      session_guard := $session$           and sherlock_access.session_visible(k.workspace_id, k.session_id)
$session$;
      related_guard := $visibility$      join visible_recent_records record
        on record.workspace_id = e.workspace_id and record.source_record_id = e.source_record_id
      left join visible_recent_sessions related
        on related.workspace_id = e.workspace_id and related.session_id = e.related_session_id
     where e.related_session_id is null or related.session_id is not null
$visibility$;
      related_column := ', e.related_session_id';
      record_column := 'e.source_record_id, ';
    else
      raise exception 'Unrecognized activity candidate block in %', target;
  end case;

  observed_at := rtrim(substr(activity, strpos(activity, observed_start),
      strpos(activity, rank_start) - strpos(activity, observed_start)), E',\n');
  ranking := rtrim(substr(activity, strpos(activity, rank_start),
      strpos(activity, source_start) - strpos(activity, rank_start)), E'\n');
  filters := rtrim(substr(activity, strpos(activity, provider_start)), E'\n');
  replacement := substr(definition, 1, start_at - 1)
    || format($activity$  ), recent_events as materialized (
    select e.id, e.workspace_id, e.session_id%7$s,
           %8$se.server_received_at, e.normalizer_version,
           e.event_kind, e.canonical_scope_key, e.logical_event_key,
           e.source_priority, e.occurred_at,
%1$s
      from telemetry.events e
      cross join p
     where e.workspace_id = p_workspace_id
%2$s
  ), recent_session_keys as materialized (
    select %9$sworkspace_id, session_id from recent_events
%4$s  ), visible_recent_sessions as materialized (
    select k.workspace_id, k.session_id, s.person_id, s.started_at
      from recent_session_keys k
      cross join lateral (
        select s.person_id, s.started_at
          from telemetry.sessions s
         where s.workspace_id = k.workspace_id and s.id = k.session_id
%5$s         offset 0
      ) s
%10$s  ), activity_candidates as materialized (
    select s.person_id, e.id, e.session_id, s.started_at session_started_at,
           e.server_received_at, e.observed_at,
%3$s
      from recent_events e
      join visible_recent_sessions s
        on s.workspace_id = e.workspace_id and s.session_id = e.session_id
      join roster r on r.person_id = s.person_id
%6$s$activity$,
         observed_at, filters, ranking, related_keys, session_guard, related_guard,
         related_column, record_column, primary_distinct, record_ctes)
    || substr(definition, end_at);
  execute replacement;

  select * into strict after_change from pg_catalog.pg_proc where oid = target;
  if after_change.proowner is distinct from before_change.proowner
     or after_change.proacl is distinct from before_change.proacl
     or after_change.proconfig is distinct from before_change.proconfig
     or after_change.prosecdef is distinct from before_change.prosecdef
     or after_change.provolatile is distinct from before_change.provolatile
     or pg_catalog.pg_get_functiondef(target) is distinct from replacement then
    raise exception 'Unexpected function definition or security change for %', target;
  end if;
end;
$migration$;
