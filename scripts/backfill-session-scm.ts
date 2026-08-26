#!/usr/bin/env -S deno run --allow-env --allow-net

import postgres from "npm:postgres@3.4.7";

const SCM_SOURCE_VERSION = "sherlock.github-scm.v1";
const PAGE_SIZE = 100;

type Sql = ReturnType<typeof postgres>;

const SCHEDULE_SCM_BACKFILL_SQL = `
with recent_sessions as materialized (
  select distinct workspace_id, session_id
    from telemetry.events
   where normalizer_version = 'sherlock.codex-rollout.v1'
     and not is_replay and session_id is not null
     and server_received_at >= now() - interval '26 hours'
), candidates as materialized (
  select job.id, job.workspace_id, job.batch_id
    from processing.telemetry_jobs job
    join telemetry.ingest_batches batch
      on batch.workspace_id = job.workspace_id and batch.id = job.batch_id
   where job.job_kind = 'normalize' and job.status = 'succeeded'
     and job.id > $1 and job.id <= $2
     and batch.source_provider = 'codex'
     and exists (
       select 1
         from telemetry.native_records record
        where record.workspace_id = job.workspace_id
          and record.batch_id = job.batch_id
          and record.native_type = 'session_meta'
     )
     and (
       batch.committed_at >= now() - interval '26 hours'
       or exists (
         select 1
           from telemetry.native_records meta
           join telemetry.events projection
             on projection.workspace_id = meta.workspace_id
            and projection.source_record_id = meta.id
            and projection.normalizer_version = 'sherlock.codex-rollout.v1'
            and not projection.is_replay
           join recent_sessions recent
             on recent.workspace_id = projection.workspace_id
            and recent.session_id = projection.session_id
          where meta.workspace_id = job.workspace_id
            and meta.batch_id = job.batch_id
            and meta.native_type = 'session_meta'
       )
     )
     and not exists (
       select 1
         from telemetry.native_records projected_record
         join telemetry.session_scm scm
           on scm.workspace_id = projected_record.workspace_id
          and scm.source_record_id = projected_record.id
          and scm.source_version = $3
        where projected_record.workspace_id = job.workspace_id
          and projected_record.batch_id = job.batch_id
     )
     and job.scm_backfill_version is distinct from $3
   order by job.id
   limit $4
     for update of job
), requeued as (
  update processing.telemetry_jobs job
     set workload_class = 'backfill', status = 'queued',
         available_at = now(), attempt_count = 0, completed_at = null,
         lease_token = null, lease_owner = null, lease_started_at = null,
         lease_expires_at = null, scm_backfill_version = $3,
         updated_at = now()
    from candidates
   where job.id = candidates.id and job.status = 'succeeded'
  returning job.id
)
select id::text id from requeued order by id
`;

async function scheduleScmBackfillPage(
  sql: Sql,
  afterJobId: bigint,
  throughJobId: bigint,
): Promise<bigint[]> {
  return await sql.begin(async (tx) => {
    await tx.unsafe("set local role sherlock_processor");
    const rows = await tx.unsafe(SCHEDULE_SCM_BACKFILL_SQL, [
      afterJobId.toString(),
      throughJobId.toString(),
      SCM_SOURCE_VERSION,
      PAGE_SIZE,
    ]);
    return rows.map((row) => BigInt(String(row.id)));
  });
}

if (import.meta.main) {
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL is required");
  const sql = postgres(databaseUrl, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
  });
  try {
    const through = await resolveJobCutoff(sql);
    let after = 0n;
    let scheduled = 0;
    while (after < through) {
      const ids = await scheduleScmBackfillPage(sql, after, through);
      if (ids.length === 0) break;
      after = ids.at(-1)!;
      scheduled += ids.length;
      console.log(JSON.stringify({
        event: "session_scm_backfill_checkpoint",
        after_job_id: after.toString(),
        through_job_id: through.toString(),
        scheduled_jobs: scheduled,
      }));
    }
    console.log(JSON.stringify({
      event: "session_scm_backfill_scheduled",
      after_job_id: after.toString(),
      through_job_id: through.toString(),
      scheduled_jobs: scheduled,
    }));
  } finally {
    await sql.end();
  }
}

async function resolveJobCutoff(sql: Sql): Promise<bigint> {
  return await sql.begin(async (tx) => {
    await tx.unsafe("set local role sherlock_processor");
    const rows = await tx.unsafe(
      `select coalesce(max(id), 0)::text id
         from processing.telemetry_jobs
        where job_kind = 'normalize'`,
    );
    return BigInt(String(rows[0]?.id ?? "0"));
  });
}
