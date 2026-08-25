#!/usr/bin/env -S deno run --allow-env --allow-net

import postgres from "npm:postgres@3.4.7";
import { NORMALIZER_VERSION } from "../supabase/functions/sherlock-rollout-ingest/normalizer.ts";

interface Options {
  workspaceId: string;
  afterBatchId: string | null;
  batchSize: number;
}

export const ENQUEUE_CODEX_BACKFILL_SQL = `
with candidates as materialized (
  select id
    from telemetry.ingest_batches
   where workspace_id = $1 and source_provider = 'codex'
     and ($2::uuid is null or id > $2::uuid)
   order by id
   limit $3
), queued as (
  insert into processing.telemetry_jobs (
    workspace_id, job_kind, batch_id, normalizer_version, workload_class
  )
  select $1, 'normalize', id, $4, 'backfill'
    from candidates
  on conflict (workspace_id, batch_id, normalizer_version)
    where job_kind = 'normalize' do nothing
  returning batch_id
)
select candidates.id::text batch_id,
       exists (select 1 from queued where queued.batch_id = candidates.id)
         enqueued
  from candidates
 order by candidates.id
`;

if (import.meta.main) {
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL is required");
  const options = parseArgs(Deno.args);
  const sql = postgres(databaseUrl, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
  });
  let after = options.afterBatchId;
  let scanned = 0;
  let enqueued = 0;
  try {
    while (true) {
      const rows = await sql.unsafe(ENQUEUE_CODEX_BACKFILL_SQL, [
        options.workspaceId,
        after,
        options.batchSize,
        NORMALIZER_VERSION,
      ]);
      scanned += rows.length;
      enqueued += rows.filter((row) => row.enqueued === true).length;
      if (rows.length === 0) break;
      after = String(rows.at(-1)!.batch_id);
      console.log(JSON.stringify({
        event: "codex_v2_backfill_checkpoint",
        workspace_id: options.workspaceId,
        after_batch: after,
        scanned_batches: scanned,
        enqueued_jobs: enqueued,
      }));
      if (rows.length < options.batchSize) break;
    }
    console.log(JSON.stringify({
      event: "codex_v2_backfill_enqueued",
      workspace_id: options.workspaceId,
      normalizer_version: NORMALIZER_VERSION,
      scanned_batches: scanned,
      enqueued_jobs: enqueued,
    }));
  } finally {
    await sql.end();
  }
}

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value) usage();
    values.set(name.slice(2), value);
  }
  const workspaceId = values.get("workspace");
  if (!workspaceId) usage();
  const batchSize = Number(values.get("batch-size") ?? "1000");
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error("--batch-size must be a positive integer");
  }
  return {
    workspaceId,
    afterBatchId: values.get("after-batch") ?? null,
    batchSize,
  };
}

function usage(): never {
  throw new Error(
    "usage: enqueue-codex-v2-backfill.ts --workspace <uuid> " +
      "[--after-batch <uuid>] [--batch-size <n>]",
  );
}
