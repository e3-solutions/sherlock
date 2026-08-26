#!/usr/bin/env -S deno run --allow-env --allow-net

import postgres from "npm:postgres@3.4.7";
import {
  FRAME_CLAUDE_NORMALIZER_VERSION,
  FRAME_CODEX_NORMALIZER_VERSION,
  FRAME_LEGACY_CODEX_NORMALIZER_VERSION,
  FRAME_NORMALIZER_VERSIONS,
  FRAME_PAIRING_NEIGHBORHOOD_SECONDS,
  FRAME_VERSION,
  FRAME_WINDOW_HOURS,
} from "../packages/frame-evidence/constants.js";
import { ACTIVITY_VERSION } from "../supabase/functions/sherlock-activity-reducer/reducer.ts";
import {
  frameSourceCutoverJoinSql,
  frameSourceNormalizerPredicateSql,
  nativeItemTimestampSql,
  PostgresFrameEvidenceProjector,
} from "../workers/telemetry-processor/frame-projector.ts";

interface Options {
  workspaceId: string;
  afterSessionId: string | null;
  sessionBatchSize: number;
  activate: boolean;
}

interface ActivationOptions {
  workspaceId: string;
  activate: boolean;
  windowStart?: Date;
}

const RELEVANT_EVENT_WINDOW_SQL = `(
  coalesce(e.occurred_at, e.observed_at, e.server_received_at)
    >= $3::timestamptz - make_interval(secs => $4)
  or ${nativeItemTimestampSql("e.native_item_id")}
    >= $3::timestamptz - make_interval(secs => $4)
)`;

export const FRAME_ACTIVATION_PROOF_SQL = `
with selected_events as materialized (
  select e.id, e.session_id, s.updated_at session_updated_at,
         e.occurred_at, e.observed_at, e.server_received_at, e.native_item_id
    from telemetry.events e
    join telemetry.sessions s
      on s.workspace_id = e.workspace_id and s.id = e.session_id
    join telemetry.native_records record
      on record.workspace_id = e.workspace_id and record.id = e.source_record_id
    join telemetry.ingest_batches batch
      on batch.workspace_id = record.workspace_id and batch.id = record.batch_id
    ${frameSourceCutoverJoinSql("s", "batch", "cutover")}
   where e.workspace_id = $1
     and ${frameSourceNormalizerPredicateSql("e", "s", "batch", "cutover")}
     and not e.is_replay
), relevant_sessions as (
  select distinct e.session_id from selected_events e
   where ${RELEVANT_EVENT_WINDOW_SQL}
), current_source as (
  select e.session_id, e.session_updated_at,
         max(e.id) through_event_id, count(*)::bigint source_event_count
    from selected_events e
    join relevant_sessions relevant using (session_id)
   group by e.session_id, e.session_updated_at
), latest_receipt as (
  select distinct on (session_id)
         session_id, through_event_id, source_event_count, session_updated_at
    from analytics.frame_projection_receipts
   where workspace_id = $1 and frame_version = $2
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

export const MISSING_NORMALIZATION_BATCHES_SQL = `
select batch.id::text batch_id
  from telemetry.ingest_batches batch
  left join telemetry.sessions session
    on session.workspace_id = batch.workspace_id
   and session.collector_key = batch.collector_key
   and session.native_session_id = batch.observed_native_session_id
  left join analytics.normalizer_cutovers cutover
    on cutover.workspace_id = batch.workspace_id
   and cutover.source_provider = batch.source_provider
   and cutover.to_normalizer_version = '${FRAME_CODEX_NORMALIZER_VERSION}'
 where batch.workspace_id = $1
   and coalesce(batch.last_occurred_at, batch.committed_at)
       >= $2::timestamptz - make_interval(secs => $3)
   and exists (
     select 1
       from telemetry.native_records record
      where record.workspace_id = batch.workspace_id
        and record.batch_id = batch.id
        and not exists (
          select 1
            from telemetry.events event
           where event.workspace_id = record.workspace_id
             and event.source_record_id = record.id
             and (
               batch.source_provider = 'claude_code'
               and event.normalizer_version = '${FRAME_CLAUDE_NORMALIZER_VERSION}'
               or batch.source_provider = 'codex'
               and (
                 cutover.cutover_at is null
                 or coalesce(
                   session.started_at,
                   batch.first_occurred_at,
                   batch.committed_at
                 ) >= cutover.cutover_at
               )
               and event.normalizer_version = '${FRAME_CODEX_NORMALIZER_VERSION}'
               or batch.source_provider = 'codex'
               and coalesce(
                 session.started_at,
                 batch.first_occurred_at,
                 batch.committed_at
               ) < cutover.cutover_at
               and event.normalizer_version in (
                 '${FRAME_LEGACY_CODEX_NORMALIZER_VERSION}',
                 '${FRAME_CODEX_NORMALIZER_VERSION}'
               )
             )
        )
   )
 order by batch.id
 limit 20
`;

export async function proveAndActivateFrameProjection(
  sql: ReturnType<typeof postgres>,
  options: ActivationOptions,
): Promise<void> {
  const windowStart = options.windowStart ?? new Date(
    Date.now() - FRAME_WINDOW_HOURS * 60 * 60 * 1_000,
  );
  await sql.begin("isolation level repeatable read", async (tx) => {
    await tx.unsafe("set local statement_timeout = '30s'");
    const missingNormalization = await tx.unsafe(
      MISSING_NORMALIZATION_BATCHES_SQL,
      [
        options.workspaceId,
        windowStart.toISOString(),
        FRAME_PAIRING_NEIGHBORHOOD_SECONDS,
      ],
    );
    if (missingNormalization.length > 0) {
      throw new Error(
        `frame activation blocked by ${missingNormalization.length} sampled batches without current normalization`,
      );
    }
    const missing = await tx.unsafe(FRAME_ACTIVATION_PROOF_SQL, [
      options.workspaceId,
      FRAME_VERSION,
      windowStart.toISOString(),
      FRAME_PAIRING_NEIGHBORHOOD_SECONDS,
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
  const coveredThrough = new Date();
  const coveredFrom = new Date(
    coveredThrough.getTime() - FRAME_WINDOW_HOURS * 60 * 60 * 1_000,
  );
  try {
    while (true) {
      const sessions = await sql.unsafe(
        `select s.id::text session_id,
                coalesce(max(j.request_generation), 1)::text request_generation
           from telemetry.sessions s
           join telemetry.events e
             on e.workspace_id = s.workspace_id and e.session_id = s.id
           join telemetry.native_records record
             on record.workspace_id = e.workspace_id
            and record.id = e.source_record_id
           join telemetry.ingest_batches batch
             on batch.workspace_id = record.workspace_id
            and batch.id = record.batch_id
           ${frameSourceCutoverJoinSql("s", "batch", "cutover")}
           left join processing.telemetry_jobs j
             on j.workspace_id = s.workspace_id and j.session_id = s.id
            and j.job_kind = 'reduce'
            and j.normalizer_version = any($7::text[])
            and j.activity_version = $4
          where s.workspace_id = $1 and ($2::uuid is null or s.id > $2::uuid)
            and ${
          frameSourceNormalizerPredicateSql("e", "s", "batch", "cutover")
        }
            and not e.is_replay
            and (
              coalesce(e.occurred_at, e.observed_at, e.server_received_at)
                >= $5::timestamptz - make_interval(secs => $6)
              or ${nativeItemTimestampSql("e.native_item_id")}
                >= $5::timestamptz - make_interval(secs => $6)
            )
          group by s.id
          order by s.id
          limit $3`,
        [
          options.workspaceId,
          after,
          options.sessionBatchSize,
          ACTIVITY_VERSION,
          coveredFrom.toISOString(),
          FRAME_PAIRING_NEIGHBORHOOD_SECONDS,
          sql.array([...FRAME_NORMALIZER_VERSIONS]),
        ],
      );
      for (const session of sessions) {
        await projector.projectSession({
          workspaceId: options.workspaceId,
          sessionId: String(session.session_id),
          requestGeneration: BigInt(String(session.request_generation)),
          now: coveredThrough,
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
      windowStart: coveredFrom,
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
