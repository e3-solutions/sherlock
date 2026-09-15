-- Deploy the v3-capable worker/readers first. New uploads use one corrected
-- interpretation, including uploads from sessions that began before deployment.
-- Existing jobs and source facts remain unchanged; no historical replay.
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
