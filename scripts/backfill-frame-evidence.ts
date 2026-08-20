#!/usr/bin/env -S deno run --allow-env --allow-net

import postgres from "npm:postgres@3.4.7";
import {
  FRAME_NORMALIZER_VERSIONS,
  FRAME_VERSION,
} from "../packages/frame-evidence/constants.js";
import { ACTIVITY_VERSION } from "../supabase/functions/sherlock-activity-reducer/reducer.ts";
import { PostgresFrameEvidenceProjector } from "../workers/telemetry-processor/frame-projector.ts";

interface Options {
  workspaceId: string;
  afterSessionId: string | null;
  sessionBatchSize: number;
  activate: boolean;
}

interface ActivationOptions {
  workspaceId: string;
  activate: boolean;
}

export const FRAME_ACTIVATION_PROOF_SQL = `
with current_source as (
  select s.id session_id, s.updated_at session_updated_at,
         max(e.id) through_event_id, count(*)::bigint source_event_count
    from telemetry.sessions s
    join telemetry.events e
      on e.workspace_id = s.workspace_id and e.session_id = s.id
   where s.workspace_id = $1 and e.normalizer_version = any($2::text[])
     and not e.is_replay
   group by s.id, s.updated_at
), latest_receipt as (
  select distinct on (session_id)
         session_id, through_event_id, source_event_count, session_updated_at
    from analytics.frame_projection_receipts
   where workspace_id = $1 and frame_version = $3
   order by session_id, id desc
)
select current_source.session_id::text session_id
  from current_source
  left join latest_receipt using (session_id)
 where latest_receipt.session_id is null
    or latest_receipt.through_event_id is distinct from current_source.through_event_id
    or latest_receipt.source_event_count <> current_source.source_event_count
    or latest_receipt.session_updated_at <> current_source.session_updated_at
 order by current_source.session_id
 limit 20
`;

export const FRAME_BLOCKING_JOBS_SQL = `
select id::text id, session_id::text session_id, status
  from processing.telemetry_jobs
 where workspace_id = $1 and status in ('queued', 'leased', 'failed')
   and (
     job_kind = 'normalize'
     or job_kind = 'reduce'
        and normalizer_version = any($2::text[])
        and activity_version = $3
   )
 order by id
 limit 20
`;

export async function proveAndActivateFrameProjection(
  sql: ReturnType<typeof postgres>,
  options: ActivationOptions,
): Promise<void> {
  await sql.begin("isolation level repeatable read", async (tx) => {
    const blockingJobs = await tx.unsafe(FRAME_BLOCKING_JOBS_SQL, [
      options.workspaceId,
      tx.array([...FRAME_NORMALIZER_VERSIONS]),
      ACTIVITY_VERSION,
    ]);
    if (blockingJobs.length > 0) {
      throw new Error(
        `frame activation blocked by ${blockingJobs.length} sampled unfinished or failed normalization or reduction jobs`,
      );
    }
    const missing = await tx.unsafe(FRAME_ACTIVATION_PROOF_SQL, [
      options.workspaceId,
      tx.array([...FRAME_NORMALIZER_VERSIONS]),
      FRAME_VERSION,
    ]);
    if (missing.length > 0) {
      throw new Error(
        `frame backfill snapshot is stale for ${missing.length} sampled sessions; rerun without --after-session`,
      );
    }
    if (options.activate) {
      await tx.unsafe(
        `insert into analytics.frame_projection_activations (
           workspace_id, frame_version
         ) values ($1, $2)
         on conflict (workspace_id, frame_version) do nothing`,
        [options.workspaceId, FRAME_VERSION],
      );
    }
  });
}

if (import.meta.main) {
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL is required");
  const options = parseArgs(Deno.args);
  const sql = postgres(databaseUrl, {
    prepare: false,
    max: 2,
    idle_timeout: 20,
  });
  const projector = PostgresFrameEvidenceProjector.connect(databaseUrl);
  let after = options.afterSessionId;
  let projected = 0;
  try {
    while (true) {
      const sessions = await sql.unsafe(
        `select s.id::text session_id, max(e.id)::text through_event_id,
                coalesce(max(j.request_generation), 1)::text request_generation
           from telemetry.sessions s
           join telemetry.events e
             on e.workspace_id = s.workspace_id and e.session_id = s.id
            and e.normalizer_version = any($2::text[]) and not e.is_replay
           left join processing.telemetry_jobs j
             on j.workspace_id = s.workspace_id and j.session_id = s.id
            and j.job_kind = 'reduce'
            and j.normalizer_version = any($2::text[])
            and j.activity_version = $5
          where s.workspace_id = $1 and ($3::uuid is null or s.id > $3::uuid)
          group by s.id
          order by s.id
          limit $4`,
        [
          options.workspaceId,
          sql.array([...FRAME_NORMALIZER_VERSIONS]),
          after,
          options.sessionBatchSize,
          ACTIVITY_VERSION,
        ],
      );
      for (const session of sessions) {
        await projector.projectSession({
          workspaceId: options.workspaceId,
          sessionId: String(session.session_id),
          throughEventId: BigInt(String(session.through_event_id)),
          requestGeneration: BigInt(String(session.request_generation)),
        });
        projected += 1;
      }
      if (sessions.length < options.sessionBatchSize) break;
      after = String(sessions.at(-1)!.session_id);
      console.log(JSON.stringify({
        event: "frame_backfill_checkpoint",
        workspace_id: options.workspaceId,
        after_session: after,
        projected_sessions: projected,
      }));
    }

    await proveAndActivateFrameProjection(sql, {
      workspaceId: options.workspaceId,
      activate: options.activate,
    });
    console.log(JSON.stringify({
      event: options.activate
        ? "frame_backfill_activated"
        : "frame_backfill_validated",
      workspace_id: options.workspaceId,
      frame_version: FRAME_VERSION,
      projected_sessions: projected,
      after_session: after,
    }));
  } finally {
    await Promise.allSettled([projector.close(), sql.end()]);
  }
}

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  let activate = false;
  for (let index = 0; index < args.length;) {
    const name = args[index];
    if (name === "--activate") {
      activate = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value) usage();
    values.set(name.slice(2), value);
    index += 2;
  }
  const workspaceId = values.get("workspace");
  if (!workspaceId) usage();
  return {
    workspaceId,
    afterSessionId: values.get("after-session") ?? null,
    sessionBatchSize: positiveInteger(
      values.get("session-batch-size") ?? "50",
      "session-batch-size",
    ),
    activate,
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function usage(): never {
  throw new Error(
    "usage: backfill-frame-evidence.ts --workspace <uuid> " +
      "[--after-session <uuid>] [--session-batch-size <n>] [--activate]",
  );
}
