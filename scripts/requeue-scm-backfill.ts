#!/usr/bin/env -S deno run --allow-env --allow-net

import postgres from "npm:postgres@3.4.7";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const REQUEUE_SCM_BACKFILL_SQL = `
with selected as materialized (
  select job.id
    from processing.telemetry_jobs job
   where job.workspace_id = $1
     and job.job_kind = 'normalize'
     and job.status in ('succeeded', 'failed')
     and exists (
       select 1
         from telemetry.native_records record
        where record.workspace_id = job.workspace_id
          and record.batch_id = job.batch_id
          and record.native_type = 'session_meta'
          and not exists (
            select 1
              from telemetry.scm_projections projection
             where projection.workspace_id = record.workspace_id
               and projection.source_record_id = record.id
               and projection.scm_version = 'sherlock.github-scm.v1'
          )
     )
   order by job.id
   limit $2
   for update skip locked
)
update processing.telemetry_jobs job
   set status = 'queued', workload_class = 'backfill', available_at = now(),
       attempt_count = 0, lease_token = null, lease_owner = null,
       lease_started_at = null, lease_expires_at = null,
       last_error_code = null, last_error = null, last_failed_at = null,
       completed_at = null, requeue_count = requeue_count + 1,
       updated_at = now()
  from selected
 where job.id = selected.id
returning job.id
`;

export async function requeueScmBackfill(
  databaseUrl: string,
  workspaceId: string,
  limit: number,
): Promise<number> {
  if (!UUID.test(workspaceId)) {
    throw new Error("SHERLOCK_WORKSPACE_ID is invalid");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("SHERLOCK_SCM_BACKFILL_LIMIT must be between 1 and 1000");
  }
  const sql = postgres(databaseUrl, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
  });
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_processor");
      return (await tx.unsafe(REQUEUE_SCM_BACKFILL_SQL, [workspaceId, limit]))
        .length;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  const rawLimit = Deno.env.get("SHERLOCK_SCM_BACKFILL_LIMIT") ?? "100";
  if (!/^\d+$/.test(rawLimit)) {
    throw new Error("SHERLOCK_SCM_BACKFILL_LIMIT must be an integer");
  }
  const requeued = await requeueScmBackfill(
    required("SUPABASE_DB_URL"),
    required("SHERLOCK_WORKSPACE_ID"),
    Number(rawLimit),
  );
  console.log(JSON.stringify({ event: "scm_backfill_requeued", requeued }));
}
