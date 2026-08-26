-- Events are append-ordered by server receipt time. Build this small rolling-
-- window index without blocking writes to the existing telemetry stream.
-- A cancelled concurrent build leaves an invalid same-named index. Repair only
-- that state; a valid index without ledger history is drift and must stay loud.
do $$
declare
  existing_is_valid boolean;
begin
  select i.indisvalid
    into existing_is_valid
    from pg_catalog.pg_index i
    join pg_catalog.pg_class relation on relation.oid = i.indexrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
   where namespace.nspname = 'telemetry'
     and relation.relname = 'events_server_received_brin_idx';

  if existing_is_valid then
    raise exception using
      errcode = '55000',
      message = 'refusing to replace valid index telemetry.events_server_received_brin_idx',
      detail = 'The index is already valid; reconcile migration history explicitly.';
  elsif existing_is_valid is false then
    drop index telemetry.events_server_received_brin_idx;
  end if;
end
$$;

create index concurrently events_server_received_brin_idx
  on telemetry.events using brin (server_received_at);
