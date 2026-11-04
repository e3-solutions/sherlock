-- COR-5105: commit counters per collector and session, for the capture stall
-- alert that runs in the Jolly Roger fleet project. Counts, ids and times only,
-- never content. Aggregating ingest_batches directly takes ~13 s for 28 days,
-- and its session id column has no index, so two small rollups are refreshed
-- every five minutes from the last few hours through the existing per-person
-- committed_at index (a few milliseconds per run).
create table telemetry.collector_commit_hours (
  workspace_id uuid not null,
  person_id uuid not null,
  collector_key text not null,
  source_kind text not null,
  hour timestamptz not null,
  batches integer not null check (batches > 0),
  last_committed_at timestamptz not null,
  primary key (collector_key, source_kind, hour)
);

-- Last commit per session and collector: maps a machine's sessions to its
-- collector and shows a session Sherlock stopped receiving.
create table telemetry.collector_session_last (
  native_session_id text not null,
  collector_key text not null,
  last_committed_at timestamptz not null,
  primary key (native_session_id, collector_key)
);

alter table telemetry.collector_commit_hours enable row level security;
alter table telemetry.collector_session_last enable row level security;
revoke all on telemetry.collector_commit_hours, telemetry.collector_session_last
  from public, anon, authenticated;

-- Recomputes whole hours from p_from (default: the last two complete hours and
-- the current one), so a rerun or a late commit converges to exact counts.
-- Session times only move forward. Run once with an earlier p_from to backfill.
create function telemetry.refresh_collector_commit_hours(p_from timestamptz default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := date_trunc('hour', coalesce(p_from, now() - interval '2 hours'));
  n integer;
begin
  delete from telemetry.collector_commit_hours where hour >= v_from;
  with recent as materialized (
    select p.workspace_id, p.id as person_id, b.collector_key, b.source_kind, b.committed_at,
           b.observed_native_session_id
      from telemetry.people p
      cross join lateral (
        select collector_key, source_kind, committed_at, observed_native_session_id
          from telemetry.ingest_batches b
         where b.workspace_id = p.workspace_id
           and b.person_id = p.id
           and b.committed_at >= v_from
      ) b
  ), sessions as (
    insert into telemetry.collector_session_last as l (native_session_id, collector_key, last_committed_at)
    select observed_native_session_id, collector_key, max(committed_at)
      from recent
     where observed_native_session_id is not null
     group by 1, 2
    on conflict (native_session_id, collector_key) do update
       set last_committed_at = greatest(l.last_committed_at, excluded.last_committed_at)
  )
  insert into telemetry.collector_commit_hours
    (workspace_id, person_id, collector_key, source_kind, hour, batches, last_committed_at)
  select workspace_id, person_id, collector_key, source_kind,
         date_trunc('hour', committed_at), count(*), max(committed_at)
    from recent
   group by 1, 2, 3, 4, 5;
  get diagnostics n = row_count;
  delete from telemetry.collector_commit_hours where hour < now() - interval '40 days';
  delete from telemetry.collector_session_last where last_committed_at < now() - interval '40 days';
  return n;
end;
$$;

revoke all on function telemetry.refresh_collector_commit_hours(timestamptz)
  from public, anon, authenticated;

-- Read side for the sherlock-collector-activity Edge Function (service role
-- only). p_session_ids maps a machine's recent session ids to
-- [collector key, last commit time]; at most 2,000 ids.
create function public.sherlock_collector_activity(
  p_since timestamptz,
  p_session_ids text[] default '{}'
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'generated_at', now(),
    'latest_commit_at', (select max(last_committed_at) from telemetry.collector_commit_hours),
    'collectors', coalesce((
      select jsonb_agg(c order by c->>'collector_key')
        from (
          select jsonb_build_object(
                   'collector_key', h.collector_key,
                   'workspace_id', h.workspace_id,
                   'email', p.email,
                   'display_name', p.display_name,
                   'provider', case when bool_or(h.source_kind = 'rollout') then 'codex' else 'claude' end,
                   'last_committed_at', max(h.last_committed_at),
                   'hours', jsonb_agg(jsonb_build_array(extract(epoch from h.hour)::bigint, h.batches)
                                      order by h.hour)
                 ) as c
            from telemetry.collector_commit_hours h
            join telemetry.people p on p.id = h.person_id
           where h.hour >= date_trunc('hour', greatest(p_since, now() - interval '40 days'))
           group by h.collector_key, h.workspace_id, p.email, p.display_name
        ) collectors
    ), '[]'::jsonb),
    'sessions', coalesce((
      select jsonb_object_agg(s.id, jsonb_build_array(l.collector_key, l.last_committed_at))
        from unnest(p_session_ids[1:2000]) as s(id)
        cross join lateral (
          select collector_key, last_committed_at
            from telemetry.collector_session_last
           where native_session_id = s.id
           order by last_committed_at desc
           limit 1
        ) l
    ), '{}'::jsonb)
  );
$$;

revoke all on function public.sherlock_collector_activity(timestamptz, text[])
  from public, anon, authenticated;
grant execute on function public.sherlock_collector_activity(timestamptz, text[]) to service_role;

create extension if not exists pg_cron;

select cron.schedule(
  'sherlock-collector-commit-hours',
  '*/5 * * * *',
  $cron$ select telemetry.refresh_collector_commit_hours(); $cron$
);
