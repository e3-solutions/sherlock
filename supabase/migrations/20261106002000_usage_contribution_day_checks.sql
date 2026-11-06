-- COR-5214: compare precomputed usage with raw usage, one UTC day at a time.
--
-- query_usage reads analytics.usage_contributions only while the refresh is
-- current, the window starts at or after backfill_cursor and no dirty mark is
-- older than 10 minutes. None of that notices a session that has raw usage but
-- was never computed, or was computed before some of its usage was inserted
-- and never marked dirty again (a missed trigger, a lost mark, a restore).
-- This check does.
--
-- For each covered day it records:
--   raw_sessions / raw_events: sessions and non-replay usage events that day;
--   computed_sessions: of those, sessions the refresh has computed;
--   contribution_rows: rows in usage_contributions for the day;
--   missing_sessions: raw usage, never computed, not waiting in the dirty queue;
--   stale_sessions: computed before a usage event of the day was inserted, and
--     not waiting in the dirty queue;
--   gap_session_ids: the missing and stale sessions.
-- Gap sessions are queued as dirty, so the minute refresh recomputes them.
-- usage_contribution_gap_open() is true for a window while any gap session of
-- a day it touches has not been recomputed since the check; query_usage then
-- uses the live query. So a gap closes as soon as the refresh catches up,
-- without another scan.
--
-- Cost: one indexed 1-day scan of usage events per day (about 7 s for a busy
-- day). The cron runs only outside the 03:00-19:00 UTC quiet hours: every
-- covered day of the last 8 at 19:30, and days with an open gap hourly.

set lock_timeout = '1s';

create table if not exists analytics.usage_contribution_checks (
  workspace_id uuid not null,
  day date not null,
  checked_at timestamptz not null,
  raw_sessions bigint not null,
  raw_events bigint not null,
  computed_sessions bigint not null,
  contribution_rows bigint not null,
  missing_sessions bigint not null,
  stale_sessions bigint not null,
  gap_session_ids uuid[] not null default '{}',
  primary key (workspace_id, day)
);
comment on table analytics.usage_contribution_checks is
  'COR-5214: latest per-day comparison of usage_contributions with raw usage events. Sessions in gap_session_ids keep query_usage on the live query until recomputed.';

alter table analytics.usage_contribution_checks enable row level security;
revoke all on table analytics.usage_contribution_checks from public;
do $revoke$
begin
  if exists (select from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on table analytics.usage_contribution_checks from anon, authenticated, service_role;
  end if;
end
$revoke$;

-- Check one UTC day of one workspace, queue gap sessions for recompute, and
-- record the result. Returns the recorded row.
create or replace function analytics.check_usage_contribution_day(p_workspace_id uuid, p_day date)
returns analytics.usage_contribution_checks
language plpgsql
volatile
security definer
set search_path = ''
as $body$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_row analytics.usage_contribution_checks;
begin
  if p_workspace_id is null or p_day is null then
    raise exception using errcode = '22023', message = 'usage_contribution_check_invalid';
  end if;
  v_start := p_day::timestamp at time zone 'UTC';
  v_end := v_start + interval '1 day';

  with raw as materialized (
    select e.session_id, pg_catalog.count(*) raw_events, pg_catalog.max(e.created_at) inserted_at
      from telemetry.events e
     where e.workspace_id = p_workspace_id and e.event_kind = 'usage' and not e.is_replay
       and e.occurred_at >= v_start and e.occurred_at < v_end
       and e.session_id is not null
     group by e.session_id
  ), assessed as materialized (
    select r.session_id, r.raw_events, cs.computed_at,
           cs.computed_at is null missing,
           cs.computed_at is not null and r.inserted_at > cs.computed_at stale,
           exists (select 1 from analytics.usage_contribution_dirty d
                    where d.workspace_id = p_workspace_id and d.session_id = r.session_id) dirty
      from raw r
      left join analytics.usage_contribution_sessions cs
        on cs.workspace_id = p_workspace_id and cs.session_id = r.session_id
  ), queued as (
    insert into analytics.usage_contribution_dirty as d (
      workspace_id, session_id, mark_seq, first_marked_at, last_marked_at
    )
    select p_workspace_id, a.session_id, pg_catalog.nextval('analytics.usage_contribution_mark_seq'),
           pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
      from assessed a
     where not a.dirty and (a.missing or a.stale)
     order by a.session_id
    on conflict (workspace_id, session_id) do update
       set mark_seq = excluded.mark_seq, last_marked_at = excluded.last_marked_at
    returning d.session_id
  )
  insert into analytics.usage_contribution_checks as c (
    workspace_id, day, checked_at, raw_sessions, raw_events, computed_sessions,
    contribution_rows, missing_sessions, stale_sessions, gap_session_ids
  )
  select p_workspace_id, p_day, pg_catalog.now(),
         (select pg_catalog.count(*) from assessed),
         (select coalesce(pg_catalog.sum(a.raw_events), 0)::bigint from assessed a),
         (select pg_catalog.count(*) from assessed a where not a.missing),
         (select pg_catalog.count(*) from analytics.usage_contributions u
           where u.workspace_id = p_workspace_id and u.usage_at >= v_start and u.usage_at < v_end),
         (select pg_catalog.count(*) from assessed a where not a.dirty and a.missing),
         (select pg_catalog.count(*) from assessed a where not a.dirty and a.stale),
         coalesce((select pg_catalog.array_agg(q.session_id order by q.session_id) from queued q), '{}')
  on conflict (workspace_id, day) do update set
    checked_at = excluded.checked_at, raw_sessions = excluded.raw_sessions,
    raw_events = excluded.raw_events, computed_sessions = excluded.computed_sessions,
    contribution_rows = excluded.contribution_rows, missing_sessions = excluded.missing_sessions,
    stale_sessions = excluded.stale_sessions, gap_session_ids = excluded.gap_session_ids
  returning * into v_row;
  return v_row;
end
$body$;
comment on function analytics.check_usage_contribution_day(uuid, date) is
  'COR-5214: compare one UTC day of usage_contributions with raw usage events, queue missing or stale sessions for recompute, record the result.';

-- True while a day that [p_start, p_end) touches has a gap session that has
-- not been recomputed since that day was checked. Reads no session data.
create or replace function analytics.usage_contribution_gap_open(
  p_workspace_id uuid, p_start timestamptz, p_end timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $body$
select exists (
  select 1
    from analytics.usage_contribution_checks c
    cross join lateral pg_catalog.unnest(c.gap_session_ids) g(session_id)
    left join analytics.usage_contribution_sessions cs
      on cs.workspace_id = c.workspace_id and cs.session_id = g.session_id
   where c.workspace_id = p_workspace_id
     and c.day >= (p_start at time zone 'UTC')::date
     and c.day <= (p_end at time zone 'UTC')::date
     and (cs.computed_at is null or cs.computed_at < c.checked_at)
)
$body$;
comment on function analytics.usage_contribution_gap_open(uuid, timestamptz, timestamptz) is
  'COR-5214: true while a checked day in the window has a gap session not yet recomputed; query_usage then reads live.';

-- Cron entry point. p_full: check every covered day of the last p_days;
-- otherwise only days whose gap is still open. Covered days start after the
-- backfill cursor's day; today is included.
create or replace function analytics.run_usage_contribution_checks(
  p_full boolean default false,
  p_days integer default 8
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $body$
declare
  v_state record;
  v_day date;
  v_today date := (pg_catalog.now() at time zone 'UTC')::date;
  v_checked integer := 0;
begin
  if p_days is null or p_days < 1 or p_days > 60 then
    raise exception using errcode = '22023', message = 'usage_contribution_check_days_invalid';
  end if;
  for v_state in
    select st.workspace_id, st.backfill_cursor from analytics.usage_contribution_state st
     order by st.workspace_id
  loop
    for v_day in
      select d.day::date
        from pg_catalog.generate_series(
          greatest(v_today - (p_days - 1), (v_state.backfill_cursor at time zone 'UTC')::date + 1),
          v_today, interval '1 day') d(day)
       where p_full or analytics.usage_contribution_gap_open(
         v_state.workspace_id, d.day::date::timestamp at time zone 'UTC',
         d.day::date::timestamp at time zone 'UTC')
       order by 1 desc
    loop
      perform analytics.check_usage_contribution_day(v_state.workspace_id, v_day);
      v_checked := v_checked + 1;
    end loop;
  end loop;
  return v_checked;
end
$body$;

revoke all on function analytics.check_usage_contribution_day(uuid, date) from public;
revoke all on function analytics.usage_contribution_gap_open(uuid, timestamptz, timestamptz) from public;
revoke all on function analytics.run_usage_contribution_checks(boolean, integer) from public;
do $revoke_functions$
begin
  if exists (select from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function analytics.check_usage_contribution_day(uuid, date) from anon, authenticated, service_role;
    revoke all on function analytics.usage_contribution_gap_open(uuid, timestamptz, timestamptz) from anon, authenticated, service_role;
    revoke all on function analytics.run_usage_contribution_checks(boolean, integer) from anon, authenticated, service_role;
  end if;
end
$revoke_functions$;
grant execute on function analytics.usage_contribution_gap_open(uuid, timestamptz, timestamptz) to sherlock_reader;

create extension if not exists pg_cron;
select cron.schedule(
  'sherlock-usage-contribution-checks-full',
  '30 19 * * *',
  $cron$ set statement_timeout = '15min'; select analytics.run_usage_contribution_checks(true, 8); $cron$
);
select cron.schedule(
  'sherlock-usage-contribution-checks-gaps',
  '45 0-2,20-23 * * *',
  $cron$ set statement_timeout = '15min'; select analytics.run_usage_contribution_checks(false, 8); $cron$
);

reset lock_timeout;
