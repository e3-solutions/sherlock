-- Deploy the v3-capable worker before this migration. Keep the existing
-- v1/v2 enqueue trigger and immutable cutover intact for v4/usage readers.
-- No historical jobs are enqueued here; use the bounded replay command.
create function processing.enqueue_codex_v3_job()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, processing
as $$
begin
  if new.source_provider = 'codex' then
    insert into processing.telemetry_jobs (
      workspace_id, job_kind, batch_id, normalizer_version, workload_class
    ) values (
      new.workspace_id, 'normalize', new.id, 'sherlock.codex-rollout.v3',
      coalesce(new.processing_class_hint, case
        when new.last_occurred_at is not null
         and new.last_occurred_at < new.committed_at - interval '24 hours'
        then 'backfill' else 'live' end)
    ) on conflict (workspace_id, batch_id, normalizer_version)
      where job_kind = 'normalize' do nothing;
  end if;
  return new;
end
$$;
revoke all on function processing.enqueue_codex_v3_job() from public, anon, authenticated;
create trigger enqueue_codex_v3_job
after insert on telemetry.ingest_batches
for each row execute function processing.enqueue_codex_v3_job();
