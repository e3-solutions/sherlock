-- COR-5162 follow-up: refresh_usage_contributions() failed every run after
-- the first with "function pg_catalog.unnest(uuid[], bigint[]) does not
-- exist": the multi-argument unnest is FROM-clause syntax and cannot be
-- schema-qualified. Clear the dirty marks through ROWS FROM instead. The
-- body is otherwise unchanged; failed runs rolled back, so no state is lost.

-- One bounded refresh step per workspace: dirty sessions first, then backfill.
create or replace function analytics.refresh_usage_contributions(
  p_max_sessions integer default 40,
  p_backfill_step interval default interval '1 hour'
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $body$
declare
  v_workspace uuid;
  v_state analytics.usage_contribution_state;
  v_fingerprint text;
  v_sessions uuid[];
  v_dirty uuid[];
  v_marks bigint[];
  v_total integer := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('sherlock.usage_contributions')) then
    return 0;
  end if;
  for v_workspace in select w.id from telemetry.workspaces w order by w.id loop
    v_fingerprint := analytics.usage_cutover_fingerprint(v_workspace);
    select * into v_state from analytics.usage_contribution_state st
     where st.workspace_id = v_workspace for update;

    if not found or v_state.cutover_fingerprint is distinct from v_fingerprint then
      delete from analytics.usage_contributions u where u.workspace_id = v_workspace;
      delete from analytics.usage_contribution_sessions cs where cs.workspace_id = v_workspace;
      insert into analytics.usage_contribution_state as st (
        workspace_id, backfill_cursor, backfill_floor, cutover_fingerprint, refreshed_at
      ) values (
        v_workspace,
        greatest(pg_catalog.now(), coalesce((
          select e.occurred_at from telemetry.events e
           where e.workspace_id = v_workspace and e.event_kind = 'usage' and not e.is_replay
             and e.occurred_at is not null
           order by e.occurred_at desc limit 1), pg_catalog.now())) + interval '1 second',
        (select e.occurred_at from telemetry.events e
          where e.workspace_id = v_workspace and e.event_kind = 'usage' and not e.is_replay
            and e.occurred_at is not null
          order by e.occurred_at limit 1),
        v_fingerprint, null
      )
      on conflict (workspace_id) do update set
        backfill_cursor = excluded.backfill_cursor,
        backfill_floor = excluded.backfill_floor, cutover_fingerprint = excluded.cutover_fingerprint,
        refreshed_at = null;
      select * into v_state from analytics.usage_contribution_state st where st.workspace_id = v_workspace;
    end if;

    -- 1. Dirty sessions, oldest mark first, once quiet for 60 s or marked
    -- for 3 minutes (an active session is recomputed at most that often). Only the mark that was read is cleared: a session marked again
    -- meanwhile has a new mark_seq and stays dirty.
    select pg_catalog.array_agg(t.session_id order by t.first_marked_at),
           pg_catalog.array_agg(t.mark_seq order by t.first_marked_at)
      into v_dirty, v_marks
      from (
        select d.session_id, d.mark_seq, d.first_marked_at
          from analytics.usage_contribution_dirty d
         where d.workspace_id = v_workspace
           and (d.last_marked_at < pg_catalog.now() - interval '60 seconds'
                or d.first_marked_at < pg_catalog.now() - interval '3 minutes')
         order by d.first_marked_at
         limit p_max_sessions
      ) t;
    v_total := v_total + analytics.compute_usage_contributions(v_workspace, v_dirty);

    -- 2. Backfill one step of history, newest first.
    if v_state.backfill_floor is not null and v_state.backfill_cursor > v_state.backfill_floor then
      select pg_catalog.array_agg(t.session_id) into v_sessions from (
        select distinct e.session_id
          from telemetry.events e
         where e.workspace_id = v_workspace and e.event_kind = 'usage' and not e.is_replay
           and e.occurred_at >= v_state.backfill_cursor - p_backfill_step
           and e.occurred_at < v_state.backfill_cursor
           and e.session_id is not null
           and not exists (
             select 1 from analytics.usage_contribution_sessions cs
              where cs.workspace_id = v_workspace and cs.session_id = e.session_id)
         limit p_max_sessions
      ) t;
      v_total := v_total + analytics.compute_usage_contributions(v_workspace, v_sessions);
      if coalesce(pg_catalog.cardinality(v_sessions), 0) < p_max_sessions then
        update analytics.usage_contribution_state st
           set backfill_cursor = st.backfill_cursor - p_backfill_step
         where st.workspace_id = v_workspace;
      end if;
    end if;

    update analytics.usage_contribution_state st set refreshed_at = pg_catalog.now()
     where st.workspace_id = v_workspace;
    -- Last, so a concurrent ingest waits on these row locks only until commit.
    if v_dirty is not null then
      delete from analytics.usage_contribution_dirty d
       using rows from (pg_catalog.unnest(v_dirty), pg_catalog.unnest(v_marks)) m(session_id, mark_seq)
       where d.workspace_id = v_workspace and d.session_id = m.session_id
         and d.mark_seq = m.mark_seq;
    end if;
  end loop;
  return v_total;
end
$body$;

revoke all on function analytics.refresh_usage_contributions(integer, interval) from public;
do $revoke$
begin
  if exists (select from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function analytics.refresh_usage_contributions(integer, interval)
      from anon, authenticated, service_role;
  end if;
end
$revoke$;
