-- pg_net was initially installed without an explicit extension schema on the
-- hosted project. Its HTTP queue and response history are short-lived
-- operational state; recreate only the extension outside public. The Cron job
-- and every Sherlock telemetry/activity fact remain untouched.
do $$
begin
  if exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_net' and n.nspname = 'public'
  ) then
    drop extension pg_net;
    create extension pg_net with schema extensions;
  end if;
end
$$;
