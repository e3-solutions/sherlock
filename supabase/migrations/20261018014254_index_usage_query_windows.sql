-- Window-first discovery avoids walking the roster's all-history sessions.
-- Keep this index narrow: session discovery is index-only; token/native payloads
-- are fetched only for touched sessions. The history index excludes messages,
-- tools and replay projections without truncating reconciliation history.
-- Follow the restart-safe concurrent-build convention from recent-session lookup:
-- Supabase runs CREATE INDEX CONCURRENTLY outside its migration transaction;
-- invalid exact builds are repaired under a short lock timeout, drift fails loud.
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
         i.indnkeyatts = 4 and i.indnatts = 4 and
         pg_get_indexdef(i.indexrelid) like
           '%(workspace_id, occurred_at, session_id, id)%' and
         i.indpred is not null and
         pg_get_expr(i.indpred, i.indrelid) =
           '((event_kind = ''usage''::text) AND (NOT is_replay))'
    into current_oid, current_is_valid, current_is_ready,
         current_matches_expected
    from pg_catalog.pg_index i
    join pg_catalog.pg_class index_relation
      on index_relation.oid = i.indexrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = index_relation.relnamespace
   where namespace.nspname = 'telemetry'
     and index_relation.relname = 'events_usage_window_idx';

  current_build_active := exists (
    select 1 from pg_catalog.pg_stat_progress_create_index progress
     where progress.index_relid = current_oid
  );

  if to_regclass('telemetry.events_usage_window_idx') is not null and
      current_oid is null then
    raise exception using
      errcode = '55000',
      message = 'telemetry.events_usage_window_idx is not an index';
  end if;

  if current_oid is not null then
    if not current_matches_expected or
        (current_is_valid and not current_is_ready) then
      raise exception using
        errcode = '55000',
        message = 'unexpected index telemetry.events_usage_window_idx',
        detail = 'Reconcile the index definition before applying this migration.';
    elsif not current_is_valid then
      if current_build_active then
        raise exception using
          errcode = '55006',
          message = 'events_usage_window_idx build is still active';
      end if;
      drop index telemetry.events_usage_window_idx;
    end if;
  end if;
end
$$;

reset lock_timeout;

create index concurrently if not exists events_usage_window_idx
  on telemetry.events (workspace_id, occurred_at, session_id, id)
  where event_kind = 'usage' and not is_replay;

reset statement_timeout;

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
         i.indnkeyatts = 2 and i.indnatts = 2 and
         pg_get_indexdef(i.indexrelid) like
           '%(workspace_id, session_id)%' and
         i.indpred is not null and
         pg_get_expr(i.indpred, i.indrelid) =
           '((NOT is_replay) AND ((event_kind = ''usage''::text) OR ((event_kind = ''lifecycle''::text) AND (event_subtype = ''turn_context''::text))))'
    into current_oid, current_is_valid, current_is_ready,
         current_matches_expected
    from pg_catalog.pg_index i
    join pg_catalog.pg_class index_relation
      on index_relation.oid = i.indexrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = index_relation.relnamespace
   where namespace.nspname = 'telemetry'
     and index_relation.relname = 'events_usage_history_idx';

  current_build_active := exists (
    select 1 from pg_catalog.pg_stat_progress_create_index progress
     where progress.index_relid = current_oid
  );

  if to_regclass('telemetry.events_usage_history_idx') is not null and
      current_oid is null then
    raise exception using
      errcode = '55000',
      message = 'telemetry.events_usage_history_idx is not an index';
  end if;

  if current_oid is not null then
    if not current_matches_expected or
        (current_is_valid and not current_is_ready) then
      raise exception using
        errcode = '55000',
        message = 'unexpected index telemetry.events_usage_history_idx',
        detail = 'Reconcile the index definition before applying this migration.';
    elsif not current_is_valid then
      if current_build_active then
        raise exception using
          errcode = '55006',
          message = 'events_usage_history_idx build is still active';
      end if;
      drop index telemetry.events_usage_history_idx;
    end if;
  end if;
end
$$;

reset lock_timeout;

create index concurrently if not exists events_usage_history_idx
  on telemetry.events (workspace_id, session_id)
  where not is_replay and (event_kind = 'usage' or
    event_kind = 'lifecycle' and event_subtype = 'turn_context');

reset statement_timeout;
