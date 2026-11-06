-- events_message_search_day_idx (20261104233100) serves every excerpt search
-- that matches text, so the text-only GIN is unused: 0 scans from Nov 5
-- 01:23:56 UTC, when the day-scoped search went live, to Nov 6 02:13 UTC.
-- Dropping it frees 574 MB and one GIN update per message insert.
-- The Supabase CLI splitter does not run DROP INDEX CONCURRENTLY outside its
-- transaction (see 20260828172835), so this is a plain drop under a short
-- lock timeout: the table lock is held for a catalog change only, and if a
-- long query holds the table the drop gives up instead of queueing others.
set lock_timeout = '2s';

do $$
begin
  if not coalesce((
    select i.indisvalid and i.indisready
      from pg_catalog.pg_index i
     where i.indexrelid = pg_catalog.to_regclass('telemetry.events_message_search_day_idx')
  ), false) then
    raise exception using
      errcode = '55000',
      message = 'events_message_search_day_idx must be valid before the text-only GIN is dropped';
  end if;
end
$$;

drop index if exists telemetry.events_message_search_idx;

reset lock_timeout;
