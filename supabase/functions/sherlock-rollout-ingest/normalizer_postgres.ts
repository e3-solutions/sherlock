import postgres from "npm:postgres@3.4.7";
import {
  type BatchManifest,
  type CommittedReceipt,
  IngestError,
} from "./contract.ts";
import {
  type ActorRole,
  NORMALIZER_VERSION,
  projectBatch,
  type SessionProjection,
} from "./normalizer.ts";
import type { BatchNormalizer } from "./service.ts";
import type { NormalizationResult } from "./service.ts";

type Sql = ReturnType<typeof postgres>;
type TransactionSql = postgres.TransactionSql;

const EVENT_COLUMNS = [
  "workspace_id",
  "session_id",
  "source_record_id",
  "normalizer_version",
  "projection_index",
  "canonical_scope_key",
  "logical_event_key",
  "source_priority",
  "is_replay",
  "event_kind",
  "event_subtype",
  "phase",
  "actor_role",
  "occurred_at",
  "observed_at",
  "server_received_at",
  "native_item_id",
  "turn_id",
  "tool_call_id",
  "message_role",
  "message_origin",
  "tool_name",
  "tool_status",
  "model",
  "project_key",
  "repo_remote",
  "branch",
  "cwd",
  "usage_stream_key",
  "usage_scope",
  "usage_is_cumulative",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "total_tokens",
  "collector_key",
  "source_kind",
  "source_stream_key",
  "generation_seq",
  "error_code",
  "content_sha256",
  "content_byte_size",
  "content_excerpt",
  "attributes",
] as const;

export class PostgresBatchNormalizer implements BatchNormalizer {
  constructor(private readonly sql: Sql) {}

  static connect(databaseUrl: string): PostgresBatchNormalizer {
    return new PostgresBatchNormalizer(
      postgres(databaseUrl, { prepare: false, max: 2, idle_timeout: 20 }),
    );
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async normalize(
    receipt: CommittedReceipt,
    manifest: BatchManifest,
    source: Uint8Array,
  ): Promise<NormalizationResult> {
    const projection = await projectBatch(manifest, source);
    return await this.sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_normalizer");
      const sourceRecords = await tx.unsafe(
        `select id, record_index
           from telemetry.native_records
          where workspace_id = $1 and batch_id = $2
          order by record_index`,
        [receipt.workspace_id, receipt.batch_id],
      );
      if (
        sourceRecords.length !== manifest.record_count ||
        sourceRecords.some((row, index) => Number(row.record_index) !== index)
      ) {
        throw new IngestError(
          "normalization_source_mismatch",
          "committed native records do not match the normalized source",
          500,
        );
      }

      const normalizedSession = projection.session
        ? await upsertSession(tx, receipt, projection.session)
        : null;
      const events = projection.events.map((event) => ({
        workspace_id: receipt.workspace_id,
        session_id: normalizedSession?.id ?? null,
        source_record_id: sourceRecords[event.record_index].id,
        normalizer_version: NORMALIZER_VERSION,
        projection_index: event.projection_index,
        canonical_scope_key: event.canonical_scope_key,
        logical_event_key: event.logical_event_key,
        source_priority: event.source_priority,
        is_replay: false,
        event_kind: event.event_kind,
        event_subtype: event.event_subtype,
        phase: event.phase,
        actor_role: normalizedSession?.actor_role ?? event.actor_role,
        occurred_at: event.occurred_at,
        observed_at: event.observed_at,
        server_received_at: receipt.committed_at,
        native_item_id: event.native_item_id,
        turn_id: event.turn_id,
        tool_call_id: event.tool_call_id,
        message_role: event.message_role,
        message_origin: event.message_origin,
        tool_name: event.tool_name,
        tool_status: event.tool_status,
        model: event.model,
        project_key: event.project_key,
        repo_remote: event.repo_remote,
        branch: event.branch,
        cwd: event.cwd,
        usage_stream_key: event.usage_stream_key,
        usage_scope: event.usage_scope,
        usage_is_cumulative: event.usage_is_cumulative,
        input_tokens: event.input_tokens,
        cached_input_tokens: event.cached_input_tokens,
        output_tokens: event.output_tokens,
        reasoning_tokens: event.reasoning_tokens,
        total_tokens: event.total_tokens,
        collector_key: receipt.collector_key,
        source_kind: receipt.source_kind,
        source_stream_key: receipt.source_stream_key,
        generation_seq: receipt.generation_seq,
        error_code: event.error_code,
        content_sha256: event.content_sha256,
        content_byte_size: event.content_byte_size,
        content_excerpt: event.content_excerpt,
        // postgres.js serializes objects for jsonb columns. Stringifying here
        // would store a JSON string, which our object-only constraint rejects.
        attributes: event.attributes ? tx.json(event.attributes) : null,
      }));
      for (let offset = 0; offset < events.length; offset += 500) {
        const eventBatch = events.slice(offset, offset + 500);
        await tx`insert into telemetry.events ${
          tx(eventBatch, ...EVENT_COLUMNS)
        } on conflict (source_record_id, normalizer_version, projection_index)
          do nothing`;
      }
      const missing = await tx.unsafe(
        `select count(*)::bigint as count
           from telemetry.native_records r
          where r.workspace_id = $1 and r.batch_id = $2
            and not exists (
              select 1 from telemetry.events e
               where e.source_record_id = r.id
                 and e.normalizer_version = $3
            )`,
        [receipt.workspace_id, receipt.batch_id, NORMALIZER_VERSION],
      );
      if (Number(missing[0]?.count ?? 0) !== 0) {
        throw new IngestError(
          "normalization_incomplete",
          "not every committed native record received a projection",
          500,
        );
      }
      return {
        session_ids: normalizedSession ? [normalizedSession.id] : [],
      };
    });
  }
}

async function upsertSession(
  tx: TransactionSql,
  receipt: CommittedReceipt,
  session: SessionProjection,
): Promise<{ id: string; actor_role: ActorRole }> {
  const lockNativeSessionIds = [
    session.native_session_id,
    session.parent_native_session_id,
  ].filter((value): value is string => value !== null)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  for (const nativeSessionId of lockNativeSessionIds) {
    await tx.unsafe(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [
        JSON.stringify([
          receipt.workspace_id,
          receipt.collector_key,
          nativeSessionId,
        ]),
      ],
    );
  }

  const parent = session.parent_native_session_id &&
      session.parent_native_session_id !== session.native_session_id
    ? await tx.unsafe(
      `select id from telemetry.sessions
        where workspace_id = $1 and collector_key = $2
          and person_id = $3 and native_session_id = $4
        limit 1`,
      [
        receipt.workspace_id,
        receipt.collector_key,
        receipt.person_id,
        session.parent_native_session_id,
      ],
    )
    : [];
  const rows = await tx.unsafe(
    `insert into telemetry.sessions (
       id, workspace_id, person_id, collector_key, native_session_id,
       native_thread_id, parent_session_id, parent_native_session_id,
       actor_role, role_version, title, project_key, repo_remote, branch,
       cwd, model, started_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17
     ) on conflict (workspace_id, collector_key, native_session_id) do update set
       native_thread_id = coalesce(excluded.native_thread_id, telemetry.sessions.native_thread_id),
       parent_session_id = coalesce(excluded.parent_session_id, telemetry.sessions.parent_session_id),
       parent_native_session_id = coalesce(
         excluded.parent_native_session_id,
         telemetry.sessions.parent_native_session_id
       ),
       actor_role = case when excluded.actor_role = 'unknown'
         then telemetry.sessions.actor_role else excluded.actor_role end,
       role_version = excluded.role_version,
       title = coalesce(excluded.title, telemetry.sessions.title),
       project_key = coalesce(excluded.project_key, telemetry.sessions.project_key),
       repo_remote = coalesce(excluded.repo_remote, telemetry.sessions.repo_remote),
       branch = coalesce(excluded.branch, telemetry.sessions.branch),
       cwd = coalesce(excluded.cwd, telemetry.sessions.cwd),
       model = coalesce(excluded.model, telemetry.sessions.model),
       started_at = least(telemetry.sessions.started_at, excluded.started_at),
       updated_at = now()
     where telemetry.sessions.person_id = excluded.person_id
     returning id, actor_role`,
    [
      crypto.randomUUID(),
      receipt.workspace_id,
      receipt.person_id,
      receipt.collector_key,
      session.native_session_id,
      session.native_thread_id,
      parent[0]?.id ?? null,
      session.parent_native_session_id,
      session.actor_role,
      session.role_version,
      session.title,
      session.project_key,
      session.repo_remote,
      session.branch,
      session.cwd,
      session.model,
      session.started_at ?? receipt.committed_at,
    ],
  );
  if (rows.length === 0) {
    throw new IngestError(
      "session_attribution_conflict",
      "the native session is already attributed to another person",
      409,
    );
  }
  await tx.unsafe(
    `update telemetry.sessions
        set parent_session_id = $1, updated_at = now()
      where workspace_id = $2 and collector_key = $3 and person_id = $4
        and parent_native_session_id = $5 and parent_session_id is null
        and id <> $1`,
    [
      rows[0].id,
      receipt.workspace_id,
      receipt.collector_key,
      receipt.person_id,
      session.native_session_id,
    ],
  );
  return {
    id: String(rows[0].id),
    actor_role: String(rows[0].actor_role) as ActorRole,
  };
}
