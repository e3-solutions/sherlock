-- Date-ranged excerpt search (search_sessions with start/end) could only find
-- text through events_message_search_idx, a GIN index with no time column:
-- every match in all history was fetched and the window applied afterwards.
-- 'deploy' has ~56k matches over ~44k heap blocks, so a cold 1-day search
-- read ~340 MB at random and hit the 10 s statement timeout (6 of the 8
-- search_sessions failures, Nov 2-4). This index lets the planner AND the GIN
-- bitmap with the window, so only blocks with in-window matches are read.
-- Follow the restart-safe concurrent-build convention from
-- 20261028213000_index_usage_query_windows: Supabase runs CREATE INDEX
-- CONCURRENTLY outside its migration transaction; invalid exact builds are
-- repaired under a short lock timeout, drift fails loud.
set statement_timeout = '30min';
set lock_timeout = '1s';

do $$
declare
  current_oid oid;
  current_is_valid boolean;
  current_is_ready boolean;
  current_matches_expected boolean;
  current_build_active boolean;
begin
  select i.indexrelid, i.indisvalid, i.indisready,
         i.indrelid = 'telemetry.events'::regclass and
         index_relation.relam = (
           select oid from pg_catalog.pg_am where amname = 'btree'
         ) and not i.indisunique and i.indexprs is null and
         i.indnkeyatts = 3 and i.indnatts = 3 and
         pg_get_indexdef(i.indexrelid) like
           '%(workspace_id, occurred_at, id)%' and
         i.indpred is not null and
         pg_get_expr(i.indpred, i.indrelid) =
           '((event_kind = ANY (ARRAY[''message''::text, ''agent_message''::text])) AND (NOT is_replay))'
    into current_oid, current_is_valid, current_is_ready,
         current_matches_expected
    from pg_catalog.pg_index i
    join pg_catalog.pg_class index_relation
      on index_relation.oid = i.indexrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = index_relation.relnamespace
   where namespace.nspname = 'telemetry'
     and index_relation.relname = 'events_message_window_idx';

  current_build_active := exists (
    select 1 from pg_catalog.pg_stat_progress_create_index progress
     where progress.index_relid = current_oid
  );

  if to_regclass('telemetry.events_message_window_idx') is not null and
      current_oid is null then
    raise exception using
      errcode = '55000',
      message = 'telemetry.events_message_window_idx is not an index';
  end if;

  if current_oid is not null then
    if not current_matches_expected or
        (current_is_valid and not current_is_ready) then
      raise exception using
        errcode = '55000',
        message = 'unexpected index telemetry.events_message_window_idx',
        detail = 'Reconcile the index definition before applying this migration.';
    elsif not current_is_valid then
      if current_build_active then
        raise exception using
          errcode = '55006',
          message = 'events_message_window_idx build is still active';
      end if;
      drop index telemetry.events_message_window_idx;
    end if;
  end if;
end
$$;

reset lock_timeout;
set maintenance_work_mem = '256MB';

create index concurrently if not exists events_message_window_idx
  on telemetry.events (workspace_id, occurred_at, id)
  where event_kind in ('message', 'agent_message') and not is_replay;

reset maintenance_work_mem;
reset statement_timeout;
