import postgres from "npm:postgres@3.4.7";
import { requeueScmBackfill } from "./requeue-scm-backfill.ts";

const permission = await Deno.permissions.query({
  name: "env",
  variable: "SHERLOCK_TEST_DATABASE_URL",
});
const databaseUrl = permission.state === "granted"
  ? Deno.env.get("SHERLOCK_TEST_DATABASE_URL")
  : null;

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test({
  name: "SCM backfill narrow role requeues only missing projections",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 2 });
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const missingBatchId = crypto.randomUUID();
    const projectedBatchId = crypto.randomUUID();
    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name)
         values ($1, $2, 'SCM replay integration')`,
        [workspaceId, `scm-replay-${workspaceId}`],
      );
      await sql.unsafe(
        `insert into telemetry.people (id, workspace_id, identity_key)
         values ($1, $2, 'scm-replay-person')`,
        [personId, workspaceId],
      );
      for (const batchId of [missingBatchId, projectedBatchId]) {
        await sql.unsafe(
          `insert into telemetry.ingest_batches (
             id, workspace_id, person_id, collector_key, source_kind,
             source_stream_key, generation_key, generation_seq, start_offset,
             end_offset, source_byte_count, source_sha256, storage_path,
             storage_encoding, stored_byte_count, stored_sha256, record_count,
             contract_version
           ) values ($1, $2, $3, 'scm-replay', 'rollout', $4, $5, 0, 0, 1,
                     1, repeat('a', 64), $6, 'gzip', 1, repeat('b', 64), 1,
                     'sherlock.rollout-batch.v1')`,
          [
            batchId,
            workspaceId,
            personId,
            `stream-${batchId}`,
            `gen-${batchId}`,
            `path-${batchId}`,
          ],
        );
      }
      const records = await sql.unsafe(
        `insert into telemetry.native_records (
           workspace_id, batch_id, record_index, source_start_offset,
           source_end_offset, record_sha256, native_type, parse_status
         ) values
           ($1, $2, 0, 0, 1, repeat('c', 64), 'session_meta', 'ok'),
           ($1, $3, 0, 0, 1, repeat('d', 64), 'session_meta', 'ok')
         returning id, batch_id`,
        [workspaceId, missingBatchId, projectedBatchId],
      );
      const projectedRecord = records.find((row) =>
        String(row.batch_id) === projectedBatchId
      );
      await sql.unsafe(
        `insert into telemetry.scm_projections (
           workspace_id, source_record_id, scm_version, projection_status
         ) values ($1, $2, 'sherlock.github-scm.v1', 'no_match')`,
        [workspaceId, projectedRecord!.id],
      );
      await sql.unsafe(
        `insert into processing.telemetry_jobs (
           workspace_id, job_kind, batch_id, workload_class, status,
           completed_at
         ) values
           ($1, 'normalize', $2, 'live', 'succeeded', now()),
           ($1, 'normalize', $3, 'live', 'succeeded', now())`,
        [workspaceId, missingBatchId, projectedBatchId],
      );

      assert(await requeueScmBackfill(databaseUrl!, workspaceId, 10) === 1);
      const jobs = await sql.unsafe(
        `select batch_id::text batch_id, status, workload_class
           from processing.telemetry_jobs where workspace_id = $1`,
        [workspaceId],
      );
      const missing = jobs.find((row) => row.batch_id === missingBatchId);
      const projected = jobs.find((row) => row.batch_id === projectedBatchId);
      assert(
        missing?.status === "queued" && missing.workload_class === "backfill",
      );
      assert(projected?.status === "succeeded");
    } finally {
      for (
        const table of [
          "processing.telemetry_jobs",
          "telemetry.scm_projections",
          "telemetry.native_records",
          "telemetry.ingest_batches",
          "telemetry.people",
        ]
      ) {
        await sql.unsafe(`delete from ${table} where workspace_id = $1`, [
          workspaceId,
        ]);
      }
      await sql.unsafe("delete from telemetry.workspaces where id = $1", [
        workspaceId,
      ]);
      await sql.end();
    }
  },
});
