import postgres from "npm:postgres@3.4.7";
import {
  type BatchManifest,
  type CommittedReceipt,
  IngestError,
} from "./contract.ts";
import {
  type ActorRole,
  CLAUDE_NORMALIZER_VERSION,
  type EventProjection,
  normalizerVersionFor,
  projectBatch,
  type SessionProjection,
} from "./normalizer.ts";
import type { BatchNormalizer } from "./service.ts";
import type { NormalizationResult } from "./service.ts";

type Sql = ReturnType<typeof postgres>;
type TransactionSql = postgres.TransactionSql;
export interface NormalizerTransactionRunner {
  <T>(callback: (tx: TransactionSql) => Promise<T>): Promise<T>;
}

function pooledTransactionRunner(sql: Sql): NormalizerTransactionRunner {
  return <T>(callback: (tx: TransactionSql) => Promise<T>) =>
    sql.begin(callback) as Promise<T>;
}

export function normalizationStatementTimeout(
  statementTimeoutMs?: number,
  deadlineAtMs?: number,
  now = () => performance.now(),
): number | undefined {
  if (deadlineAtMs === undefined) return statementTimeoutMs;
  const remaining = Math.floor(deadlineAtMs - now());
  if (remaining <= 0) {
    const error = new Error("normalization deadline exceeded");
    Object.assign(error, { code: "processing_deadline_exceeded" });
    throw error;
  }
  return statementTimeoutMs === undefined
    ? remaining
    : Math.min(statementTimeoutMs, remaining);
}

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
  constructor(
    private readonly sql: Sql,
    private readonly transactionRunner: NormalizerTransactionRunner =
      pooledTransactionRunner(sql),
    private readonly ownsSql = true,
  ) {}

  static connect(databaseUrl: string): PostgresBatchNormalizer {
    const sql = postgres(databaseUrl, {
      prepare: false,
      max: 2,
      idle_timeout: 20,
    });
    return new PostgresBatchNormalizer(sql);
  }

  static fromReservedConnection(
    sql: Sql,
    transactionRunner: NormalizerTransactionRunner,
  ): PostgresBatchNormalizer {
    return new PostgresBatchNormalizer(sql, transactionRunner, false);
  }

  async close(): Promise<void> {
    if (this.ownsSql) await this.sql.end();
  }

  async normalize(
    receipt: CommittedReceipt,
    manifest: BatchManifest,
    source: Uint8Array,
    statementTimeoutMs?: number,
    deadlineAtMs?: number,
  ): Promise<NormalizationResult> {
    const projection = await projectBatch(manifest, source);
    const normalizerVersion = normalizerVersionFor(manifest);
    const timeout = normalizationStatementTimeout(
      statementTimeoutMs,
      deadlineAtMs,
    );
    return await this.transactionRunner(async (tx) => {
      if (timeout !== undefined) {
        await tx.unsafe("select set_config('statement_timeout', $1, true)", [
          `${Math.max(1, Math.floor(timeout))}ms`,
        ]);
      }
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
      const projectedEvents = normalizedSession &&
          normalizerVersion === CLAUDE_NORMALIZER_VERSION
        ? await rebindClaudePromptTurns(
          tx,
          receipt.workspace_id,
          normalizedSession.id,
          projection.events,
        )
        : projection.events;
      const events = projectedEvents.map((event) => ({
        workspace_id: receipt.workspace_id,
        session_id: normalizedSession?.id ?? null,
        source_record_id: sourceRecords[event.record_index].id,
        normalizer_version: normalizerVersion,
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
        [receipt.workspace_id, receipt.batch_id, normalizerVersion],
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
        normalizer_version: normalizerVersion,
      };
    });
  }
}

async function rebindClaudePromptTurns(
  tx: TransactionSql,
  workspaceId: string,
  sessionId: string,
  events: readonly EventProjection[],
): Promise<EventProjection[]> {
  const referencedParents = [
    ...new Set(
      events.flatMap((event) =>
        event.turn_id?.startsWith("claude:request:") &&
          event.parent_native_item_id
          ? [event.parent_native_item_id]
          : []
      ),
    ),
  ];
  const prior = referencedParents.length === 0 ? [] : await tx.unsafe(
    `select distinct on (native_item_id) native_item_id, turn_id
         from telemetry.events
        where workspace_id = $1 and session_id = $2
          and normalizer_version = $3 and not is_replay
          and native_item_id = any($4::text[])
          and turn_id like 'claude:prompt:%'
        order by native_item_id, source_priority desc,
                 occurred_at asc nulls last, id`,
    [
      workspaceId,
      sessionId,
      CLAUDE_NORMALIZER_VERSION,
      referencedParents,
    ],
  );
  const promptTurnByNativeItem = new Map<string, string>(
    prior.map((row) => [String(row.native_item_id), String(row.turn_id)]),
  );

  return events.map((event) => {
    const inherited = event.parent_native_item_id
      ? promptTurnByNativeItem.get(event.parent_native_item_id)
      : undefined;
    const turnId = inherited && event.turn_id?.startsWith("claude:request:")
      ? inherited
      : event.turn_id;
    if (
      event.native_item_id && turnId?.startsWith("claude:prompt:")
    ) {
      promptTurnByNativeItem.set(event.native_item_id, turnId);
    }
    return turnId === event.turn_id ? event : { ...event, turn_id: turnId };
  });
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
       and row(
         telemetry.sessions.native_thread_id,
         telemetry.sessions.parent_session_id,
         telemetry.sessions.parent_native_session_id,
         telemetry.sessions.actor_role,
         telemetry.sessions.role_version,
         telemetry.sessions.title,
         telemetry.sessions.project_key,
         telemetry.sessions.repo_remote,
         telemetry.sessions.branch,
         telemetry.sessions.cwd,
         telemetry.sessions.model,
         telemetry.sessions.started_at
       ) is distinct from row(
         coalesce(excluded.native_thread_id, telemetry.sessions.native_thread_id),
         coalesce(excluded.parent_session_id, telemetry.sessions.parent_session_id),
         coalesce(
           excluded.parent_native_session_id,
           telemetry.sessions.parent_native_session_id
         ),
         case when excluded.actor_role = 'unknown'
           then telemetry.sessions.actor_role else excluded.actor_role end,
         excluded.role_version,
         coalesce(excluded.title, telemetry.sessions.title),
         coalesce(excluded.project_key, telemetry.sessions.project_key),
         coalesce(excluded.repo_remote, telemetry.sessions.repo_remote),
         coalesce(excluded.branch, telemetry.sessions.branch),
         coalesce(excluded.cwd, telemetry.sessions.cwd),
         coalesce(excluded.model, telemetry.sessions.model),
         least(telemetry.sessions.started_at, excluded.started_at)
       )
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
  const resolvedRows = rows.length > 0 ? rows : await tx.unsafe(
    `select id, actor_role
         from telemetry.sessions
        where workspace_id = $1 and collector_key = $2
          and native_session_id = $3 and person_id = $4
        limit 1`,
    [
      receipt.workspace_id,
      receipt.collector_key,
      session.native_session_id,
      receipt.person_id,
    ],
  );
  if (resolvedRows.length === 0) {
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
      resolvedRows[0].id,
      receipt.workspace_id,
      receipt.collector_key,
      receipt.person_id,
      session.native_session_id,
    ],
  );
  return {
    id: String(resolvedRows[0].id),
    actor_role: String(resolvedRows[0].actor_role) as ActorRole,
  };
}
