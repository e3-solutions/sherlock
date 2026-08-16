import postgres from "npm:postgres@3.4.7";
import {
  type ActivityEvent,
  type ActivitySpan,
  reduceActivity,
} from "./reducer.ts";

type Sql = ReturnType<typeof postgres>;
type TransactionSql = postgres.TransactionSql;

export interface ReduceSessionOptions {
  workspaceId: string;
  sessionId: string;
  normalizerVersion: string;
  activityVersion: string;
  throughEventId: bigint;
  eventPageSize?: number;
  maxEventCount?: number;
  statementTimeoutMs?: number;
  deadlineAtMs?: number;
  now?: () => number;
}

export interface ReduceSessionResult {
  session_id: string;
  cutoff_event_id: bigint | null;
  candidate_count: number;
  inserted_count: number;
  tombstone_count: number;
}

export interface ActivityReducerHooks {
  beforeWriteCommit?: () => void | Promise<void>;
}

export class ActivitySessionLimitError extends Error {
  readonly code = "session_event_limit_exceeded";

  constructor(
    public readonly sessionId: string,
    public readonly maximum: number,
  ) {
    super(`session ${sessionId} exceeds the ${maximum} event job limit`);
  }
}

export class ActivitySessionBusyError extends Error {
  readonly code = "session_busy";

  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} is already being reduced`);
  }
}

export class ActivitySessionDeadlineError extends Error {
  readonly code = "session_deadline_exceeded";

  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} exceeded the activity job deadline`);
  }
}

class StaleSessionReadError extends Error {}

interface PersistedSpan {
  span_key: string;
  started_at: string | null;
  ended_at: string | null;
  span_state: string;
  activity_kind: string;
  timing_basis: string;
  confidence: string;
  estimated_start: boolean;
  estimated_end: boolean;
  actor_role: string;
  project_key: string | null;
  start_event_id: bigint | null;
  end_event_id: bigint | null;
  is_tombstone: boolean;
}

const SPAN_COLUMNS = [
  "workspace_id",
  "session_id",
  "person_id",
  "span_key",
  "activity_version",
  "valid_from_event_id",
  "started_at",
  "ended_at",
  "span_state",
  "activity_kind",
  "timing_basis",
  "confidence",
  "estimated_start",
  "estimated_end",
  "actor_role",
  "project_key",
  "start_event_id",
  "end_event_id",
  "is_tombstone",
] as const;

const SPAN_SELECT = `
  span_key,
  to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as started_at,
  to_char(ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ended_at,
  span_state, activity_kind, timing_basis, confidence, estimated_start,
  estimated_end, actor_role, project_key, start_event_id, end_event_id,
  is_tombstone
`;

export class PostgresActivityReducer {
  constructor(
    private readonly sql: Sql,
    private readonly hooks: ActivityReducerHooks = {},
  ) {}

  static connect(
    databaseUrl: string,
    hooks: ActivityReducerHooks = {},
  ): PostgresActivityReducer {
    return new PostgresActivityReducer(
      postgres(databaseUrl, { prepare: false, max: 2, idle_timeout: 20 }),
      hooks,
    );
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async resolveWorkspaceCutoff(
    workspaceId: string,
    normalizerVersion: string,
    statementTimeoutMs?: number,
  ): Promise<bigint> {
    return await this.sql.begin(async (tx) => {
      await setStatementTimeout(tx, statementTimeoutMs);
      await tx.unsafe("set local role sherlock_reducer");
      const rows = await tx.unsafe(
        `select coalesce(max(id), 0)::text as cutoff
           from telemetry.events
          where workspace_id = $1 and normalizer_version = $2
            and session_id is not null`,
        [workspaceId, normalizerVersion],
      );
      return BigInt(String(rows[0].cutoff));
    });
  }

  async listSessionIds(options: {
    workspaceId: string;
    normalizerVersion: string;
    throughEventId: bigint;
    afterSessionId?: string | null;
    limit: number;
    statementTimeoutMs?: number;
  }): Promise<string[]> {
    return await this.sql.begin(async (tx) => {
      await setStatementTimeout(tx, options.statementTimeoutMs);
      await tx.unsafe("set local role sherlock_reducer");
      const rows = await tx.unsafe(
        `select distinct e.session_id as session_id
           from telemetry.events e
          where e.workspace_id = $1 and e.normalizer_version = $2
            and e.session_id is not null and e.id <= $3
            and ($4::uuid is null or e.session_id > $4::uuid)
          order by e.session_id
          limit $5`,
        [
          options.workspaceId,
          options.normalizerVersion,
          options.throughEventId.toString(),
          options.afterSessionId ?? null,
          options.limit,
        ],
      );
      return rows.map((row) => String(row.session_id));
    });
  }

  async reduceSession(
    options: ReduceSessionOptions,
  ): Promise<ReduceSessionResult> {
    try {
      return await this.reduceSessionBounded(options);
    } catch (error) {
      if (
        error instanceof ActivitySessionDeadlineError ||
        error instanceof Error && "code" in error && error.code === "57014"
      ) {
        throw new ActivitySessionDeadlineError(options.sessionId);
      }
      throw error;
    }
  }

  private async reduceSessionBounded(
    options: ReduceSessionOptions,
  ): Promise<ReduceSessionResult> {
    const session = await this.loadSession(
      options.workspaceId,
      options.sessionId,
      remainingStatementTimeout(options),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const events = await this.loadEvents(options);
      if (events.length === 0) {
        remainingStatementTimeout(options);
        return {
          session_id: options.sessionId,
          cutoff_event_id: null,
          candidate_count: 0,
          inserted_count: 0,
          tombstone_count: 0,
        };
      }
      const cutoff = events.at(-1)!.id;
      remainingStatementTimeout(options);
      const candidates = reduceActivity(options.sessionId, events);
      remainingStatementTimeout(options);
      try {
        return await this.sql.begin(async (tx) => {
          await setStatementTimeout(tx, remainingStatementTimeout(options));
          await tx.unsafe("set local role sherlock_reducer");
          await setStatementTimeout(tx, remainingStatementTimeout(options));
          const locks = await tx.unsafe(
            "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as acquired",
            [JSON.stringify([
              options.workspaceId,
              options.activityVersion,
              options.sessionId,
            ])],
          );
          if (!locks[0].acquired) {
            throw new ActivitySessionBusyError(options.sessionId);
          }
          await setStatementTimeout(tx, remainingStatementTimeout(options));
          const visible = await tx.unsafe(
            `select count(*)::text as count
               from telemetry.events
              where workspace_id = $1 and session_id = $2
                and normalizer_version = $3 and id <= $4`,
            [
              options.workspaceId,
              options.sessionId,
              options.normalizerVersion,
              options.throughEventId.toString(),
            ],
          );
          if (BigInt(String(visible[0].count)) !== BigInt(events.length)) {
            throw new StaleSessionReadError();
          }
          await setStatementTimeout(tx, remainingStatementTimeout(options));
          const previous = await latestSpans(
            tx,
            options.workspaceId,
            options.sessionId,
            options.activityVersion,
            cutoff,
          );
          const previousByKey = new Map(
            previous.map((span) => [span.span_key, span]),
          );
          const desiredByKey = new Map(
            candidates.map((span) => [span.span_key, span]),
          );
          const revisions: PersistedSpan[] = [];
          for (const candidate of candidates) {
            const desired = persisted(candidate);
            const prior = previousByKey.get(candidate.span_key);
            if (!prior || !sameProjection(prior, desired)) {
              revisions.push(desired);
            }
          }
          for (const prior of previous) {
            if (prior.is_tombstone || desiredByKey.has(prior.span_key)) {
              continue;
            }
            revisions.push({
              ...prior,
              started_at: null,
              ended_at: null,
              start_event_id: null,
              end_event_id: null,
              is_tombstone: true,
            });
          }
          if (revisions.length > 0) {
            await setStatementTimeout(tx, remainingStatementTimeout(options));
            const rows = revisions.map((span) => ({
              workspace_id: options.workspaceId,
              session_id: options.sessionId,
              person_id: session.personId,
              span_key: span.span_key,
              activity_version: options.activityVersion,
              valid_from_event_id: cutoff.toString(),
              started_at: span.started_at,
              ended_at: span.ended_at,
              span_state: span.span_state,
              activity_kind: span.activity_kind,
              timing_basis: span.timing_basis,
              confidence: span.confidence,
              estimated_start: span.estimated_start,
              estimated_end: span.estimated_end,
              actor_role: span.actor_role,
              project_key: span.project_key,
              start_event_id: span.start_event_id?.toString() ?? null,
              end_event_id: span.end_event_id?.toString() ?? null,
              is_tombstone: span.is_tombstone,
            }));
            await tx`insert into analytics.activity_spans ${
              tx(rows, ...SPAN_COLUMNS)
            }`;
          }
          await setStatementTimeout(tx, remainingStatementTimeout(options));
          await assertExactRevisions(
            tx,
            options.workspaceId,
            options.activityVersion,
            cutoff,
            revisions,
          );
          remainingStatementTimeout(options);
          await this.hooks.beforeWriteCommit?.();
          return {
            session_id: options.sessionId,
            cutoff_event_id: cutoff,
            candidate_count: candidates.length,
            inserted_count: revisions.length,
            tombstone_count: revisions.filter((span) => span.is_tombstone)
              .length,
          };
        });
      } catch (error) {
        if (error instanceof StaleSessionReadError && attempt < 2) continue;
        if (
          error instanceof ActivitySessionDeadlineError ||
          error instanceof Error && "code" in error && error.code === "57014"
        ) {
          throw new ActivitySessionDeadlineError(options.sessionId);
        }
        throw error;
      }
    }
    throw new Error("activity reducer exhausted stale-read retries");
  }

  private async loadSession(
    workspaceId: string,
    sessionId: string,
    statementTimeoutMs?: number,
  ): Promise<{ personId: string }> {
    return await this.sql.begin(async (tx) => {
      await setStatementTimeout(tx, statementTimeoutMs);
      await tx.unsafe("set local role sherlock_reducer");
      const rows = await tx.unsafe(
        `select person_id::text as person_id
           from telemetry.sessions
          where workspace_id = $1 and id = $2`,
        [workspaceId, sessionId],
      );
      if (rows.length !== 1) {
        throw new Error(`session ${sessionId} does not exist in workspace`);
      }
      return { personId: String(rows[0].person_id) };
    });
  }

  private async loadEvents(
    options: ReduceSessionOptions,
  ): Promise<ActivityEvent[]> {
    const result: ActivityEvent[] = [];
    const pageSize = options.eventPageSize ?? 1_000;
    let after = 0n;
    while (true) {
      const pageLimit = options.maxEventCount === undefined
        ? pageSize
        : Math.min(pageSize, options.maxEventCount - result.length + 1);
      if (pageLimit <= 0) {
        throw new ActivitySessionLimitError(
          options.sessionId,
          options.maxEventCount!,
        );
      }
      const page = await this.sql.begin(async (tx) => {
        await setStatementTimeout(tx, remainingStatementTimeout(options));
        await tx.unsafe("set local role sherlock_reducer");
        return await tx.unsafe(
          `select id::text as id, workspace_id::text as workspace_id,
                  session_id::text as session_id, normalizer_version,
                  canonical_scope_key, logical_event_key, source_priority,
                  is_replay, event_kind, event_subtype, phase, actor_role,
                  to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
                  to_char(observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as observed_at,
                  to_char(server_received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as server_received_at,
                  turn_id, tool_call_id, tool_status, message_origin, project_key
             from telemetry.events
            where workspace_id = $1 and session_id = $2
              and normalizer_version = $3 and id > $4 and id <= $5
            order by id
            limit $6`,
          [
            options.workspaceId,
            options.sessionId,
            options.normalizerVersion,
            after.toString(),
            options.throughEventId.toString(),
            pageLimit,
          ],
        );
      });
      result.push(...page.map(eventFromRow));
      if (
        options.maxEventCount !== undefined &&
        result.length > options.maxEventCount
      ) {
        throw new ActivitySessionLimitError(
          options.sessionId,
          options.maxEventCount,
        );
      }
      if (page.length < pageLimit) return result;
      after = result.at(-1)!.id;
    }
  }
}

function remainingStatementTimeout(
  options: ReduceSessionOptions,
): number | undefined {
  let timeout = options.statementTimeoutMs;
  if (options.deadlineAtMs === undefined) return timeout;
  const remaining = Math.floor(
    options.deadlineAtMs - (options.now ?? (() => performance.now()))(),
  );
  if (remaining <= 0) {
    throw new ActivitySessionDeadlineError(options.sessionId);
  }
  timeout = timeout === undefined ? remaining : Math.min(timeout, remaining);
  return Math.max(1, timeout);
}

async function setStatementTimeout(
  tx: TransactionSql,
  milliseconds: number | undefined,
): Promise<void> {
  if (milliseconds === undefined) return;
  await tx.unsafe("select set_config('statement_timeout', $1, true)", [
    `${milliseconds}ms`,
  ]);
}

async function latestSpans(
  tx: TransactionSql,
  workspaceId: string,
  sessionId: string,
  activityVersion: string,
  cutoff: bigint,
): Promise<PersistedSpan[]> {
  const rows = await tx.unsafe(
    `select distinct on (span_key) ${SPAN_SELECT}
       from analytics.activity_spans
      where workspace_id = $1 and session_id = $2 and activity_version = $3
        and valid_from_event_id <= $4
      order by span_key, valid_from_event_id desc, id desc`,
    [workspaceId, sessionId, activityVersion, cutoff.toString()],
  );
  return rows.map(spanFromRow);
}

async function assertExactRevisions(
  tx: TransactionSql,
  workspaceId: string,
  activityVersion: string,
  cutoff: bigint,
  expected: readonly PersistedSpan[],
): Promise<void> {
  if (expected.length === 0) return;
  const rows = await tx.unsafe(
    `select ${SPAN_SELECT}
       from analytics.activity_spans
      where workspace_id = $1 and activity_version = $2
        and valid_from_event_id = $3 and span_key = any($4::text[])
      order by span_key, id`,
    [
      workspaceId,
      activityVersion,
      cutoff.toString(),
      expected.map((span) => span.span_key),
    ],
  );
  const actual = new Map(rows.map((row) => {
    const span = spanFromRow(row);
    return [span.span_key, span];
  }));
  for (const span of expected) {
    const found = actual.get(span.span_key);
    if (!found || !sameProjection(found, span)) {
      throw new Error(
        `activity version ${activityVersion} produced a conflicting ${span.span_key}`,
      );
    }
  }
}

function eventFromRow(row: Record<string, unknown>): ActivityEvent {
  return {
    id: BigInt(String(row.id)),
    workspace_id: String(row.workspace_id),
    session_id: String(row.session_id),
    normalizer_version: String(row.normalizer_version),
    canonical_scope_key: nullableString(row.canonical_scope_key),
    logical_event_key: nullableString(row.logical_event_key),
    source_priority: Number(row.source_priority),
    is_replay: Boolean(row.is_replay),
    event_kind: String(row.event_kind),
    event_subtype: nullableString(row.event_subtype),
    phase: nullableString(row.phase),
    actor_role: nullableString(row.actor_role) as ActivityEvent["actor_role"],
    occurred_at: nullableString(row.occurred_at),
    observed_at: nullableString(row.observed_at),
    server_received_at: String(row.server_received_at),
    turn_id: nullableString(row.turn_id),
    tool_call_id: nullableString(row.tool_call_id),
    tool_status: nullableString(row.tool_status),
    message_origin: nullableString(row.message_origin),
    project_key: nullableString(row.project_key),
  };
}

function spanFromRow(row: Record<string, unknown>): PersistedSpan {
  return {
    span_key: String(row.span_key),
    started_at: nullableString(row.started_at),
    ended_at: nullableString(row.ended_at),
    span_state: String(row.span_state),
    activity_kind: String(row.activity_kind),
    timing_basis: String(row.timing_basis),
    confidence: String(row.confidence),
    estimated_start: Boolean(row.estimated_start),
    estimated_end: Boolean(row.estimated_end),
    actor_role: String(row.actor_role),
    project_key: nullableString(row.project_key),
    start_event_id: nullableBigInt(row.start_event_id),
    end_event_id: nullableBigInt(row.end_event_id),
    is_tombstone: Boolean(row.is_tombstone),
  };
}

function persisted(span: ActivitySpan): PersistedSpan {
  return { ...span, is_tombstone: false };
}

function sameProjection(left: PersistedSpan, right: PersistedSpan): boolean {
  return left.span_key === right.span_key &&
    left.started_at === right.started_at &&
    left.ended_at === right.ended_at &&
    left.span_state === right.span_state &&
    left.activity_kind === right.activity_kind &&
    left.timing_basis === right.timing_basis &&
    left.confidence === right.confidence &&
    left.estimated_start === right.estimated_start &&
    left.estimated_end === right.estimated_end &&
    left.actor_role === right.actor_role &&
    left.project_key === right.project_key &&
    left.start_event_id === right.start_event_id &&
    left.end_event_id === right.end_event_id &&
    left.is_tombstone === right.is_tombstone;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableBigInt(value: unknown): bigint | null {
  return value === null || value === undefined ? null : BigInt(String(value));
}
