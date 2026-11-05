-- Windows over 25 hours still searched through events_message_search_idx,
-- which has no time column: a common word fetched every match in history
-- (deploy: 55,910 over ~44k heap blocks) and timed out cold. With btree_gin
-- one GIN index holds the UTC day next to message_search. The search names
-- each day of its window (day = any(...)), and every day is one exact entry
-- intersected with the words, so only that window's matches reach the heap.
-- A range on a raw timestamp would not do this: btree_gin turns
-- occurred_at < end into a scan of every earlier entry.
-- events_message_search_idx stays until this one is proven in use.
-- Restart-safe concurrent build, as in 20261104214000, with no statement
-- timeout (two passes over a 46 GB table) and 256 MB for the GIN sort.
set statement_timeout = 0;
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
           select oid from pg_catalog.pg_am where amname = 'gin'
         ) and not i.indisunique and i.indexprs is not null and
         i.indnkeyatts = 2 and i.indnatts = 2 and
         pg_get_indexdef(i.indexrelid) like
           '%USING gin ((((occurred_at AT TIME ZONE ''UTC''::text))::date), message_search)%' and
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
     and index_relation.relname = 'events_message_search_day_idx';

  current_build_active := exists (
    select 1 from pg_catalog.pg_stat_progress_create_index progress
     where progress.index_relid = current_oid
  );

  if to_regclass('telemetry.events_message_search_day_idx') is not null and
      current_oid is null then
    raise exception using
      errcode = '55000',
      message = 'telemetry.events_message_search_day_idx is not an index';
  end if;

  if current_oid is not null then
    if not current_matches_expected or
        (current_is_valid and not current_is_ready) then
      raise exception using
        errcode = '55000',
        message = 'unexpected index telemetry.events_message_search_day_idx',
        detail = 'Reconcile the index definition before applying this migration.';
    elsif not current_is_valid then
      if current_build_active then
        raise exception using
          errcode = '55006',
          message = 'events_message_search_day_idx build is still active';
      end if;
      drop index telemetry.events_message_search_day_idx;
    end if;
  end if;
end
$$;

reset lock_timeout;
set maintenance_work_mem = '256MB';

create index concurrently if not exists events_message_search_day_idx
  on telemetry.events
  using gin (((occurred_at at time zone 'UTC')::date), message_search)
  where event_kind in ('message', 'agent_message') and not is_replay;

reset maintenance_work_mem;
reset statement_timeout;
