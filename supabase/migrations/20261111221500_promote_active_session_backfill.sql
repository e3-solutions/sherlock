-- COR-5279: a backfill upload from a session that is active right now goes to
-- the live queue.
--
-- The collector's backstop scan (reconcile) labels everything it uploads
-- "backfill", including the newest records of a running session's subagents.
-- Backfill waits whenever live work is busy, so a subagent active minutes ago
-- could sit in the queue for hours and miss the dashboard.
--
-- This trigger runs after ingest_batches_enqueue_processing (triggers on the
-- same event fire in name order) and moves the new batch's queued normalize
-- job from backfill to live when all of these hold:
--   * the collector hinted backfill;
--   * the batch's newest record is less than an hour older than its commit;
--   * its root session (the parent for a subagent) received a batch without a
--     backfill hint in the last hour, which means a hook saw it live.
-- The collector's hint stays recorded on the batch unchanged, and
-- enqueue_telemetry_job() (which picks the normalizer version) is untouched.
-- The queue already promotes a job's class this way when live demand needs it.

set local lock_timeout = '1s';

create or replace function processing.promote_active_session_backfill()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, processing, telemetry
as $$
declare
  v_root text := coalesce(
    new.observed_parent_native_session_id,
    new.observed_native_session_id
  );
begin
  if new.processing_class_hint = 'backfill'
     and v_root is not null
     and new.last_occurred_at is not null
     and new.last_occurred_at >= new.committed_at - interval '1 hour'
     and exists (
       select 1
         from telemetry.ingest_batches b
        where b.workspace_id = new.workspace_id
          and b.observed_native_session_id = v_root
          and b.id <> new.id
          and b.committed_at >= new.committed_at - interval '1 hour'
          and b.processing_class_hint is distinct from 'backfill'
     )
  then
    update processing.telemetry_jobs j
       set workload_class = 'live'
     where j.workspace_id = new.workspace_id
       and j.batch_id = new.id
       and j.job_kind = 'normalize'
       and j.status = 'queued'
       and j.workload_class = 'backfill';
  end if;
  return null;
end
$$;

revoke all on function processing.promote_active_session_backfill()
  from public, anon, authenticated;

drop trigger if exists ingest_batches_promote_active_session
  on telemetry.ingest_batches;
create trigger ingest_batches_promote_active_session
  after insert on telemetry.ingest_batches
  for each row execute function processing.promote_active_session_backfill();
