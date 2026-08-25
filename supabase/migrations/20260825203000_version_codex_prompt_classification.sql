-- COR-3839: append a versioned Codex classification instead of rewriting v1.
-- Deploy the worker that treats null normalize targets as provider v1 before
-- applying this migration. The trigger switches new Codex work to v2; the
-- historical v2 backfill is enqueued separately and explicitly.
alter table telemetry.events
  drop constraint events_message_origin_check,
  add constraint events_message_origin_check check (
    message_origin is null or message_origin in (
      'human', 'parent_agent', 'worker', 'system', 'resumed_context',
      'runtime_context', 'unknown'
    )
  );

alter table analytics.frame_evidence_revisions
  drop constraint frame_evidence_revisions_summary_candidate_check,
  add constraint frame_evidence_revisions_summary_candidate_check check (
    not is_summary_candidate or (
      evidence_kind = 'activity' and message_role = 'user' and (
        event_subtype = 'user_message'
        and message_origin in ('human', 'parent_agent')
        or event_subtype = 'message' and message_origin = 'human'
      )
    )
  );

-- Normalization is now a versioned operational target. Historical jobs retain
-- their original provider version, including failed attempts without events.
-- Codex v2 history is enqueued later by the workspace-scoped backfill command.
alter table processing.telemetry_jobs
  drop constraint telemetry_jobs_target_shape_check;

drop index processing.telemetry_jobs_batch_key;

update processing.telemetry_jobs job
   set normalizer_version = case batch.source_provider
     when 'claude_code' then 'sherlock.claude-code-transcript.v1'
     else 'sherlock.codex-rollout.v1'
   end
  from telemetry.ingest_batches batch
 where job.job_kind = 'normalize' and job.normalizer_version is null
   and batch.workspace_id = job.workspace_id and batch.id = job.batch_id;

alter table processing.telemetry_jobs
  add constraint telemetry_jobs_target_shape_check check (
    (
      job_kind = 'normalize' and batch_id is not null and session_id is null
      and normalizer_version is not null and btrim(normalizer_version) <> ''
      and activity_version is null and target_event_id is null
      and request_generation is null
    ) or (
      job_kind = 'reduce' and batch_id is null and session_id is not null
      and normalizer_version is not null and activity_version is not null
      and target_event_id is not null and target_event_id > 0
      and request_generation is not null and request_generation > 0
    )
  );

create unique index telemetry_jobs_batch_key
  on processing.telemetry_jobs (workspace_id, batch_id, normalizer_version)
  where job_kind = 'normalize';

create or replace function processing.enqueue_telemetry_job()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, processing
as $$
declare
  target_normalizer_version text;
begin
  target_normalizer_version := case new.source_provider
    when 'claude_code' then 'sherlock.claude-code-transcript.v1'
    else 'sherlock.codex-rollout.v2'
  end;
  insert into processing.telemetry_jobs (
    workspace_id,
    job_kind,
    batch_id,
    normalizer_version,
    workload_class
  ) values (
    new.workspace_id,
    'normalize',
    new.id,
    target_normalizer_version,
    coalesce(
      new.processing_class_hint,
      case
        when new.last_occurred_at is not null
          and new.last_occurred_at < new.committed_at - interval '24 hours'
        then 'backfill'
        else 'live'
      end
    )
  ) on conflict (workspace_id, batch_id, normalizer_version)
    where job_kind = 'normalize' do nothing;
  return new;
end
$$;

comment on column processing.telemetry_jobs.normalizer_version is
  'Versioned normalization target for append-only derived events; reduce jobs consume the same immutable version identity.';
