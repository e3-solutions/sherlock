-- GitHub sync reads one rolling window of active sessions. A failed concurrent
-- build can leave an invalid same-named index, so move only the exact expected
-- definition aside before dropping it concurrently. An exact valid index is a
-- restart-safe success; any other same-named relation remains loud schema drift.
set statement_timeout = '30min';
set lock_timeout = '5s';

do $$
declare
  current_oid oid;
  current_is_valid boolean;
  current_is_ready boolean;
  current_matches_expected boolean;
  current_build_active boolean;
  incomplete_oid oid;
  incomplete_is_valid boolean;
  incomplete_matches_expected boolean;
begin
  select i.indexrelid, i.indisvalid, i.indisready,
         i.indrelid = 'telemetry.events'::regclass and
         index_relation.relam = (
           select oid from pg_catalog.pg_am where amname = 'btree'
         ) and not i.indisunique and i.indexprs is null and
         i.indnkeyatts = 2 and i.indnatts = 3 and
         pg_get_indexdef(i.indexrelid) like
           '%(workspace_id, server_received_at DESC) INCLUDE (session_id)%' and
         pg_get_expr(i.indpred, i.indrelid) =
           '((session_id IS NOT NULL) AND (NOT is_replay))'
    into current_oid, current_is_valid, current_is_ready,
         current_matches_expected
    from pg_catalog.pg_index i
    join pg_catalog.pg_class index_relation
      on index_relation.oid = i.indexrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = index_relation.relnamespace
   where namespace.nspname = 'telemetry'
     and index_relation.relname = 'events_recent_sessions_idx';

  current_build_active := exists (
    select 1 from pg_catalog.pg_stat_progress_create_index progress
     where progress.index_relid = current_oid
  );

  select i.indexrelid, i.indisvalid,
         i.indrelid = 'telemetry.events'::regclass and
         index_relation.relam = (
           select oid from pg_catalog.pg_am where amname = 'btree'
         ) and not i.indisunique and i.indexprs is null and
         i.indnkeyatts = 2 and i.indnatts = 3 and
         pg_get_indexdef(i.indexrelid) like
           '%(workspace_id, server_received_at DESC) INCLUDE (session_id)%' and
         pg_get_expr(i.indpred, i.indrelid) =
           '((session_id IS NOT NULL) AND (NOT is_replay))'
    into incomplete_oid, incomplete_is_valid, incomplete_matches_expected
    from pg_catalog.pg_index i
    join pg_catalog.pg_class index_relation
      on index_relation.oid = i.indexrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = index_relation.relnamespace
   where namespace.nspname = 'telemetry'
     and index_relation.relname = 'events_recent_sessions_idx_incomplete';

  if to_regclass('telemetry.events_recent_sessions_idx') is not null and
      current_oid is null then
    raise exception using
      errcode = '55000',
      message = 'telemetry.events_recent_sessions_idx is not an index';
  end if;

  if to_regclass('telemetry.events_recent_sessions_idx_incomplete') is not null and
      incomplete_oid is null then
    raise exception using
      errcode = '55000',
      message = 'telemetry.events_recent_sessions_idx_incomplete is not an index';
  end if;

  if incomplete_oid is not null and
      (incomplete_is_valid or not incomplete_matches_expected) then
    raise exception using
      errcode = '55000',
      message = 'unexpected index telemetry.events_recent_sessions_idx_incomplete',
      detail = 'Reconcile the index definition before applying this migration.';
  end if;

  if current_oid is not null then
    if not current_matches_expected or
        (current_is_valid and not current_is_ready) then
      raise exception using
        errcode = '55000',
        message = 'unexpected index telemetry.events_recent_sessions_idx',
        detail = 'Reconcile the index definition before applying this migration.';
    elsif not current_is_valid then
      if current_build_active then
        raise exception using
          errcode = '55006',
          message = 'recent-session index build is still active';
      end if;
      if incomplete_oid is not null then
        raise exception using
          errcode = '55000',
          message = 'multiple incomplete recent-session indexes',
          detail = 'Reconcile the incomplete indexes before applying this migration.';
      end if;
      alter index telemetry.events_recent_sessions_idx
        rename to events_recent_sessions_idx_incomplete;
    end if;
  end if;
end
$$;

reset lock_timeout;

drop index concurrently if exists telemetry.events_recent_sessions_idx_incomplete;

create index concurrently if not exists events_recent_sessions_idx
  on telemetry.events (workspace_id, server_received_at desc)
  include (session_id)
  where session_id is not null and not is_replay;

reset statement_timeout;
