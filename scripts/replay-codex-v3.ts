#!/usr/bin/env -S deno run --allow-env --allow-net

import postgres from "npm:postgres@3.4.7";
import { CODEX_V3_NORMALIZER_VERSION } from "../supabase/functions/sherlock-rollout-ingest/normalizer.ts";
import { relevantBatchSql } from "./codex-v3-coverage.ts";

export interface ReplayOptions {
  workspaceId: string;
  start: string;
  end: string;
  apply: boolean;
}

// Include overlapping batches and late uploads. Source bytes and historical
// jobs remain untouched; completed/leased/failed v3 jobs are never reset.
export const REPLAY_BATCHES_SQL = `
select batch.id
  from telemetry.ingest_batches batch
 where batch.workspace_id = $1 and batch.source_provider = 'codex'
   and batch.committed_at < $3::timestamptz
   and ${relevantBatchSql("$2::timestamptz", "$3::timestamptz")}
`;

export function parseReplayArgs(args: string[]): ReplayOptions {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--apply") {
      apply = true;
      continue;
    }
    if (
      !["--workspace", "--start", "--end"].includes(name) || !args[index + 1]
    ) {
      throw new Error(
        "Usage: replay-codex-v3.ts --workspace UUID --start ISO --end ISO [--apply]",
      );
    }
    if (values.has(name)) throw new Error(`duplicate argument: ${name}`);
    values.set(name, args[++index]);
  }
  const workspaceId = values.get("--workspace") ?? "";
  const start = values.get("--start") ?? "";
  const end = values.get("--end") ?? "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      workspaceId,
    ) ||
    !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) ||
    Date.parse(start) >= Date.parse(end)
  ) {
    throw new Error("A workspace UUID and finite start < end are required");
  }
  return {
    workspaceId,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    apply,
  };
}

export async function replayCodexV3(
  sql: ReturnType<typeof postgres>,
  options: ReplayOptions,
) {
  return await sql.begin("isolation level repeatable read", async (tx) => {
    await tx.unsafe("set local statement_timeout = '30s'");
    const params = [
      options.workspaceId,
      options.start,
      options.end,
      CODEX_V3_NORMALIZER_VERSION,
    ];
    const [counts] = await tx.unsafe(
      `with candidates as (${REPLAY_BATCHES_SQL})
      select count(*)::int candidates, count(*) filter (where not exists (
        select 1 from processing.telemetry_jobs job
         where job.workspace_id = $1 and job.batch_id = candidates.id
           and job.job_kind = 'normalize' and job.normalizer_version = $4
      ))::int missing_jobs from candidates`,
      params,
    );
    let enqueued = 0;
    if (options.apply) {
      const rows = await tx.unsafe(
        `insert into processing.telemetry_jobs (
        workspace_id, job_kind, batch_id, normalizer_version, workload_class
      ) select $1, 'normalize', candidates.id, $4, 'backfill'
          from (${REPLAY_BATCHES_SQL}) candidates
      on conflict (workspace_id, batch_id, normalizer_version)
        where job_kind = 'normalize' do nothing returning id`,
        params,
      );
      enqueued = rows.length;
    }
    return {
      ...options,
      normalizerVersion: CODEX_V3_NORMALIZER_VERSION,
      candidates: Number(counts.candidates),
      missing_jobs: Number(counts.missing_jobs),
      enqueued,
    };
  });
}

if (import.meta.main) {
  const options = parseReplayArgs(Deno.args);
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL is required");
  const sql = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    console.log(JSON.stringify(await replayCodexV3(sql, options)));
  } finally {
    await sql.end();
  }
}
