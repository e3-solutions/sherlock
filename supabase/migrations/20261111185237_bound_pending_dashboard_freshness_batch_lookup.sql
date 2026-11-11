-- Keep the deployed freshness contract, including any environment-specific
-- visibility guards. Change only the join from pending jobs to their batches.
-- OFFSET 0 prevents flattening the lookup into a scan over batch history.
set local lock_timeout = '1s';
set local statement_timeout = '5s';

do $migration$
declare
  target regprocedure := 'analytics.read_dashboard_freshness(uuid,text,text[],integer)'::regprocedure;
  before_change pg_catalog.pg_proc%rowtype;
  after_change pg_catalog.pg_proc%rowtype;
  old_join constant text := $old$      from processing.telemetry_jobs j
      join telemetry.ingest_batches b
        on b.workspace_id = j.workspace_id and b.id = j.batch_id
      join roster r on r.person_id = b.person_id$old$;
  new_join constant text := $new$      from processing.telemetry_jobs j
      cross join lateral (
        select b.committed_at, b.person_id
          from telemetry.ingest_batches b
         where b.workspace_id = j.workspace_id and b.id = j.batch_id
         offset 0
      ) b
      join roster r on r.person_id = b.person_id$new$;
  definition text;
  replacement text;
begin
  select * into strict before_change from pg_catalog.pg_proc where oid = target;
  if not before_change.prosecdef or before_change.provolatile <> 's' then
    raise exception 'Unexpected security or volatility for %', target;
  end if;

  definition := pg_catalog.pg_get_functiondef(target);
  replacement := replace(definition, old_join, new_join);
  if length(definition) - length(replace(definition, old_join, '')) <> length(old_join) then
    raise exception 'Expected exactly one pending normalization batch join in %', target;
  end if;

  execute replacement;

  select * into strict after_change from pg_catalog.pg_proc where oid = target;
  if after_change.proowner is distinct from before_change.proowner
     or after_change.proacl is distinct from before_change.proacl
     or after_change.proconfig is distinct from before_change.proconfig
     or after_change.prosecdef is distinct from before_change.prosecdef
     or after_change.provolatile is distinct from before_change.provolatile
     or pg_catalog.pg_get_functiondef(target) is distinct from replacement then
    raise exception 'Unexpected function definition or security change for %', target;
  end if;
end;
$migration$;
