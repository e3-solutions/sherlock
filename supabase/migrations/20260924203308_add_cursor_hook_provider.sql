-- Deploy Cursor-capable worker and readers before enabling collectors.
-- Preserve existing facts and their normalizer versions.
alter table telemetry.ingest_batches
  drop constraint ingest_batches_source_provider_check,
  add constraint ingest_batches_source_provider_check check (
    source_provider in ('codex', 'claude_code', 'cursor')
  ),
  add constraint ingest_batches_cursor_kind_check check (
    source_provider <> 'cursor' or source_kind = 'hook'
  );

create or replace function processing.enqueue_telemetry_job()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, processing
as $$
begin
  insert into processing.telemetry_jobs (
    workspace_id, job_kind, batch_id, normalizer_version, workload_class
  ) values (
    new.workspace_id, 'normalize', new.id,
    case new.source_provider
      when 'cursor' then 'sherlock.cursor-hook.v1'
      when 'claude_code' then 'sherlock.claude-code-transcript.v1'
      else 'sherlock.codex-rollout.v3'
    end,
    coalesce(new.processing_class_hint, case
      when new.last_occurred_at is not null
       and new.last_occurred_at < new.committed_at - interval '24 hours'
      then 'backfill' else 'live' end)
  ) on conflict (workspace_id, batch_id, normalizer_version)
    where job_kind = 'normalize' do nothing;
  return new;
end
$$;
revoke all on function processing.enqueue_telemetry_job() from public, anon, authenticated;
