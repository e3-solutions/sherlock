import postgres from "npm:postgres@3.4.7";
import {
  FRAME_NORMALIZER_VERSIONS,
  FRAME_PAIRING_NEIGHBORHOOD_SECONDS,
  FRAME_VERSION,
  FRAME_WINDOW_HOURS,
} from "../../packages/frame-evidence/constants.js";

type Sql = ReturnType<typeof postgres>;

const UNKEYED_PROMPT_MATCH_MS = 2_000;
const ADJACENT_PROMPT_MATCH_MS = 100;
const ASSISTANT_REPRESENTATION_MATCH_MS = 3_000;
const DEFAULT_FRAME_LOCK_TIMEOUT_MS = 60_000;

export const FRAME_LOCK_TIMEOUT_SQL =
  "select set_config('statement_timeout', $1, false)";
export const FRAME_ADVISORY_LOCK_SQL =
  "select pg_advisory_lock(hashtextextended($1, 0))";
export const FRAME_ADVISORY_UNLOCK_SQL =
  "select pg_advisory_unlock(hashtextextended($1, 0))";
export const FRAME_RESET_TIMEOUT_SQL = "reset statement_timeout";

export interface FrameProjectionOptions {
  workspaceId: string;
  sessionId: string;
  throughEventId: bigint;
  requestGeneration: bigint;
  statementTimeoutMs?: number;
  now?: Date;
}

export interface FrameProjectionResult {
  candidate_count: number;
  inserted_count: number;
  tombstone_count: number;
  receipt_id: bigint | null;
}

export interface EvidenceState {
  evidence_kind: "activity" | "prompt";
  source_event_id: bigint;
  anchor_observed_at: string;
  observed_at: string;
  actor_role: "primary" | "worker" | "guardian" | "automation" | "unknown";
  event_kind: string;
  event_subtype: string | null;
  message_role: string | null;
  message_origin: string | null;
  prompt_identity: string | null;
  is_summary_candidate: boolean;
  is_tombstone: boolean;
}

export interface SourceEvent {
  id: bigint;
  person_id: string;
  session_id: string;
  normalizer_version: string;
  canonical_scope_key: string | null;
  logical_event_key: string | null;
  source_priority: number;
  event_kind: string;
  event_subtype: string | null;
  stored_actor_role: EvidenceState["actor_role"];
  actor_role: EvidenceState["actor_role"];
  occurred_at: string | null;
  source_observed_at: string;
  activity_observed_at: string;
  native_item_id: string | null;
  turn_id: string | null;
  message_role: string | null;
  message_origin: string | null;
  content_sha256: string | null;
  content_byte_size: number | null;
  has_content_excerpt: boolean;
  error_code: string | null;
  source_batch_id: string;
  source_record_index: number;
  source_start_offset: bigint;
  source_end_offset: bigint;
  source_native_type: string | null;
  source_native_payload_type: string | null;
  source_collector_key: string;
  source_kind: string;
  source_stream_key: string;
  generation_key: string;
  generation_seq: bigint;
}

interface PromptSource extends SourceEvent {
  prompt_identity: string;
  prompt_observed_at: string;
}

export const FRAME_SOURCE_EVENTS_SQL = `
select e.id::text id, s.person_id::text person_id, e.session_id::text session_id,
       e.normalizer_version, e.canonical_scope_key, e.logical_event_key,
       e.source_priority, e.event_kind, e.event_subtype,
       e.actor_role stored_actor_role,
       case when e.actor_role = 'unknown' and s.parent_session_id is not null
            then 'worker' else e.actor_role end actor_role,
       case when e.occurred_at is null then null else
         to_char(e.occurred_at at time zone 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
       end occurred_at,
       to_char(
         coalesce(e.occurred_at, e.observed_at, e.server_received_at)
           at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) source_observed_at,
       to_char(coalesce(
         case
           when e.native_item_id ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           then to_timestamp((
             ('x' || replace(
               substring(e.native_item_id from '[0-9a-f]{8}-[0-9a-f]{4}'),
               '-', ''
             ))::bit(48)::bigint
           ) / 1000.0)
           else null
         end,
         coalesce(e.occurred_at, e.observed_at, e.server_received_at)
       ) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
         activity_observed_at,
       e.native_item_id, e.turn_id, e.message_role, e.message_origin,
       e.content_sha256, e.content_byte_size,
       e.content_excerpt is not null has_content_excerpt,
       e.error_code,
       nr.batch_id::text source_batch_id, nr.record_index source_record_index,
       nr.source_start_offset::text source_start_offset,
       nr.source_end_offset::text source_end_offset,
       nr.native_type source_native_type,
       nr.native_payload_type source_native_payload_type,
       ib.collector_key source_collector_key, ib.source_kind,
       ib.source_stream_key, ib.generation_key,
       ib.generation_seq::text generation_seq
  from telemetry.events e
  join telemetry.sessions s
    on s.workspace_id = e.workspace_id and s.id = e.session_id
  join telemetry.native_records nr
    on nr.workspace_id = e.workspace_id and nr.id = e.source_record_id
  join telemetry.ingest_batches ib
    on ib.workspace_id = nr.workspace_id and ib.id = nr.batch_id
 where e.workspace_id = $1 and e.session_id = $2
   and e.normalizer_version = any($3::text[])
   and e.id <= $4 and not e.is_replay
   and (
     (
       e.actor_role <> 'automation'
       and e.event_kind in (
         'message', 'reasoning', 'tool_call', 'tool_result', 'agent_spawn',
         'agent_message', 'lifecycle', 'error'
       )
       and (e.event_kind <> 'message' or e.native_item_id is not null
            or e.event_subtype = 'user_message')
       and (e.event_kind <> 'lifecycle' or e.event_subtype in (
         'task_started', 'task_complete', 'turn_started', 'turn_complete'
       ))
       and coalesce(
         case
           when e.native_item_id ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           then to_timestamp((
             ('x' || replace(
               substring(e.native_item_id from '[0-9a-f]{8}-[0-9a-f]{4}'),
               '-', ''
             ))::bit(48)::bigint
           ) / 1000.0)
           else null
         end,
         coalesce(e.occurred_at, e.observed_at, e.server_received_at)
       ) >= $5::timestamptz - make_interval(secs => $7)
       and coalesce(
         case
           when e.native_item_id ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           then to_timestamp((
             ('x' || replace(
               substring(e.native_item_id from '[0-9a-f]{8}-[0-9a-f]{4}'),
               '-', ''
             ))::bit(48)::bigint
           ) / 1000.0)
           else null
         end,
         coalesce(e.occurred_at, e.observed_at, e.server_received_at)
       ) < $6::timestamptz + make_interval(secs => $7)
     ) or (
       e.event_kind = 'message' and e.message_origin = 'human'
       and e.message_role = 'user' and e.content_sha256 is not null
       and e.content_byte_size > 0 and e.error_code is null
       and e.actor_role = 'primary'
       and (
         coalesce(e.occurred_at, e.observed_at, e.server_received_at)
           >= $5::timestamptz - interval '2 seconds'
         and coalesce(e.occurred_at, e.observed_at, e.server_received_at)
           < $6::timestamptz + interval '2 seconds'
         or case
           when e.native_item_id ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           then to_timestamp((
             ('x' || replace(
               substring(e.native_item_id from '[0-9a-f]{8}-[0-9a-f]{4}'),
               '-', ''
             ))::bit(48)::bigint
           ) / 1000.0)
           else null
         end >= $5::timestamptz - interval '2 seconds'
         and case
           when e.native_item_id ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           then to_timestamp((
             ('x' || replace(
               substring(e.native_item_id from '[0-9a-f]{8}-[0-9a-f]{4}'),
               '-', ''
             ))::bit(48)::bigint
           ) / 1000.0)
           else null
         end < $6::timestamptz + interval '2 seconds'
       )
     )
   )
 order by e.id
`;

const PREVIOUS_SQL = `
select distinct on (evidence_kind, source_event_id)
       evidence_kind, source_event_id::text source_event_id,
       to_char(anchor_observed_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') anchor_observed_at,
       to_char(observed_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at,
       actor_role, event_kind, event_subtype,
       message_role, message_origin, prompt_identity, is_summary_candidate,
       is_tombstone
  from analytics.frame_evidence_revisions
 where workspace_id = $1 and session_id = $2 and frame_version = $3
   and anchor_observed_at >= $4::timestamptz - make_interval(secs => $6)
   and anchor_observed_at < $5::timestamptz + make_interval(secs => $6)
 order by evidence_kind, source_event_id, id desc
`;

export const FRAME_SOURCE_COORDINATES_SQL = `
select max(id)::text through_event_id, count(*)::text source_event_count
  from telemetry.events
 where workspace_id = $1 and session_id = $2
   and normalizer_version = any($3::text[])
   and not is_replay
`;

const REVISION_COLUMNS = [
  "receipt_id",
  "workspace_id",
  "session_id",
  "person_id",
  "frame_version",
  "evidence_kind",
  "source_event_id",
  "anchor_observed_at",
  "observed_at",
  "actor_role",
  "event_kind",
  "event_subtype",
  "message_role",
  "message_origin",
  "prompt_identity",
  "is_summary_candidate",
  "is_tombstone",
] as const;

export class PostgresFrameEvidenceProjector {
  constructor(private readonly sql: Sql) {}

  static connect(databaseUrl: string): PostgresFrameEvidenceProjector {
    return new PostgresFrameEvidenceProjector(postgres(databaseUrl, {
      prepare: false,
      max: 2,
      idle_timeout: 20,
    }));
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async projectSession(
    options: FrameProjectionOptions,
  ): Promise<FrameProjectionResult> {
    const coveredThrough = options.now ?? new Date();
    const coveredFrom = new Date(
      coveredThrough.getTime() - FRAME_WINDOW_HOURS * 60 * 60 * 1_000,
    );
    const lockKey = JSON.stringify([
      options.workspaceId,
      options.sessionId,
      FRAME_VERSION,
    ]);
    const connection = await this.sql.reserve();
    let lockAcquired = false;
    let sessionTimeoutSet = false;
    try {
      const lockTimeoutMs = Math.max(
        1,
        Math.floor(
          options.statementTimeoutMs ?? DEFAULT_FRAME_LOCK_TIMEOUT_MS,
        ),
      );
      await connection.unsafe(FRAME_LOCK_TIMEOUT_SQL, [
        `${lockTimeoutMs}ms`,
      ]);
      sessionTimeoutSet = true;
      await connection.unsafe(FRAME_ADVISORY_LOCK_SQL, [lockKey]);
      lockAcquired = true;
      await connection.unsafe(FRAME_RESET_TIMEOUT_SQL);
      sessionTimeoutSet = false;
      return await connection.begin(
        "isolation level repeatable read",
        async (tx) => {
          if (options.statementTimeoutMs !== undefined) {
            await tx.unsafe(
              "select set_config('statement_timeout', $1, true)",
              [
                `${Math.max(1, Math.floor(options.statementTimeoutMs))}ms`,
              ],
            );
          }
          await tx.unsafe("set local role sherlock_frame_projector");
          const sessions = await tx.unsafe(
            `select person_id::text person_id,
                to_char(date_trunc('milliseconds', started_at)
                  at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') started_at,
                to_char(updated_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') session_updated_at
           from telemetry.sessions where workspace_id = $1 and id = $2`,
            [options.workspaceId, options.sessionId],
          );
          if (sessions.length !== 1) {
            throw new Error("frame projection session missing");
          }
          const sessionStartedAt = dateString(sessions[0].started_at);
          const sessionUpdatedAt = String(sessions[0].session_updated_at);
          const coordinates = await tx.unsafe(FRAME_SOURCE_COORDINATES_SQL, [
            options.workspaceId,
            options.sessionId,
            tx.array([...FRAME_NORMALIZER_VERSIONS]),
          ]);
          const throughEventId = coordinates[0].through_event_id === null
            ? null
            : BigInt(String(coordinates[0].through_event_id));
          const sourceEventCount = BigInt(
            String(coordinates[0].source_event_count),
          );
          const rows = await tx.unsafe(FRAME_SOURCE_EVENTS_SQL, [
            options.workspaceId,
            options.sessionId,
            tx.array([...FRAME_NORMALIZER_VERSIONS]),
            throughEventId?.toString() ?? null,
            coveredFrom.toISOString(),
            coveredThrough.toISOString(),
            FRAME_PAIRING_NEIGHBORHOOD_SECONDS,
          ]);
          const sourceEvents = rows.map(sourceEventFromRow);
          const desired = canonicalEvidence(
            sourceEvents,
            sessionStartedAt,
            coveredFrom,
            coveredThrough,
          );
          const previousRows = await tx.unsafe(PREVIOUS_SQL, [
            options.workspaceId,
            options.sessionId,
            FRAME_VERSION,
            coveredFrom.toISOString(),
            coveredThrough.toISOString(),
            FRAME_PAIRING_NEIGHBORHOOD_SECONDS,
          ]);
          const previous = previousRows.map(evidenceFromRow);
          const changes = diffEvidence(desired, previous);
          const sourceStateSha256 = await fingerprintSourceState(
            sourceEvents,
            sessionStartedAt,
            sessionUpdatedAt,
          );
          const exact = await tx.unsafe(
            `select id::text id from analytics.frame_projection_receipts
          where workspace_id = $1 and session_id = $2 and frame_version = $3
            and through_event_id is not distinct from $4::bigint
            and source_event_count = $5 and source_state_sha256 = $6
            and request_generation = $7 and session_updated_at = $8
          order by id desc limit 1`,
            [
              options.workspaceId,
              options.sessionId,
              FRAME_VERSION,
              throughEventId?.toString() ?? null,
              sourceEventCount.toString(),
              sourceStateSha256,
              options.requestGeneration.toString(),
              sessionUpdatedAt,
            ],
          );
          if (exact.length > 0) {
            return {
              candidate_count: desired.length,
              inserted_count: 0,
              tombstone_count: 0,
              receipt_id: null,
            };
          }
          const receipts = await tx.unsafe(
            `insert into analytics.frame_projection_receipts (
           workspace_id, session_id, person_id, frame_version,
           covered_from, covered_through, through_event_id, source_event_count,
           source_state_sha256, request_generation, session_updated_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning id::text id`,
            [
              options.workspaceId,
              options.sessionId,
              String(sessions[0].person_id),
              FRAME_VERSION,
              coveredFrom.toISOString(),
              coveredThrough.toISOString(),
              throughEventId?.toString() ?? null,
              sourceEventCount.toString(),
              sourceStateSha256,
              options.requestGeneration.toString(),
              sessionUpdatedAt,
            ],
          );
          const receiptId = BigInt(String(receipts[0].id));
          if (changes.length > 0) {
            const inserts = changes.map((change) => ({
              receipt_id: receiptId.toString(),
              workspace_id: options.workspaceId,
              session_id: options.sessionId,
              person_id: String(sessions[0].person_id),
              frame_version: FRAME_VERSION,
              evidence_kind: change.evidence_kind,
              source_event_id: change.source_event_id.toString(),
              anchor_observed_at: change.anchor_observed_at,
              observed_at: change.observed_at,
              actor_role: change.actor_role,
              event_kind: change.event_kind,
              event_subtype: change.event_subtype,
              message_role: change.message_role,
              message_origin: change.message_origin,
              prompt_identity: change.prompt_identity,
              is_summary_candidate: change.is_summary_candidate,
              is_tombstone: change.is_tombstone,
            }));
            await tx`insert into analytics.frame_evidence_revisions ${
              tx(inserts, ...REVISION_COLUMNS)
            }`;
          }
          return {
            candidate_count: desired.length,
            inserted_count: changes.length,
            tombstone_count: changes.filter((change) =>
              change.is_tombstone
            ).length,
            receipt_id: receiptId,
          };
        },
      );
    } finally {
      try {
        if (lockAcquired) {
          await connection.unsafe(FRAME_ADVISORY_UNLOCK_SQL, [lockKey]);
        }
      } finally {
        try {
          if (sessionTimeoutSet) {
            await connection.unsafe(FRAME_RESET_TIMEOUT_SQL);
          }
        } finally {
          connection.release();
        }
      }
    }
  }
}

export function canonicalEvidence(
  sourceEvents: readonly SourceEvent[],
  sessionStartedAt: string,
  coveredFrom: Date,
  coveredThrough: Date,
): EvidenceState[] {
  return [
    ...canonicalActivity(
      sourceEvents,
      sessionStartedAt,
      coveredFrom,
      coveredThrough,
    ),
    ...canonicalPrompts(sourceEvents, coveredFrom, coveredThrough),
  ].sort(compareEvidence);
}

function canonicalActivity(
  events: readonly SourceEvent[],
  sessionStartedAt: string,
  coveredFrom: Date,
  coveredThrough: Date,
): EvidenceState[] {
  const eligible = events.filter(isActivityCandidate);
  const canonical = canonicalSemanticRows(eligible).filter((event) =>
    microseconds(event.activity_observed_at) >= microseconds(sessionStartedAt)
  );
  const conversation = canonical.filter(isConversationSource);
  const suppressed = representationSuppressed(conversation);
  return canonical.filter((event) =>
    !suppressed.has(event.id) &&
    inWindow(event.activity_observed_at, coveredFrom, coveredThrough)
  ).map((event) => ({
    evidence_kind: "activity",
    source_event_id: event.id,
    anchor_observed_at: event.activity_observed_at,
    observed_at: event.activity_observed_at,
    actor_role: event.actor_role,
    event_kind: event.event_kind,
    event_subtype: event.event_subtype,
    message_role: event.message_role,
    message_origin: event.message_origin,
    prompt_identity: null,
    is_summary_candidate: event.event_subtype === "user_message" &&
      event.message_role === "user" &&
      (event.message_origin === "human" ||
        event.message_origin === "parent_agent") &&
      event.has_content_excerpt,
    is_tombstone: false,
  }));
}

function canonicalPrompts(
  events: readonly SourceEvent[],
  coveredFrom: Date,
  coveredThrough: Date,
): EvidenceState[] {
  const candidates = events.filter(isPromptCandidate);
  const groups = semanticGroups(candidates);
  const canonical = canonicalSemanticRows(candidates);
  const adjacentSuppressed = adjacentPromptSuppressed(canonical);
  const unkeyedSubmitted = canonical.filter((event) =>
    (!event.canonical_scope_key || !event.logical_event_key) &&
    event.event_subtype === "user_message" && !adjacentSuppressed.has(event.id)
  );
  const nativeCandidates = candidates.filter((event) =>
    event.event_subtype === "message" && event.native_item_id !== null
  );
  const pairs = mutuallyUniquePromptPairs(unkeyedSubmitted, nativeCandidates);
  const sources: PromptSource[] = [];
  for (const event of canonical) {
    if (!event.canonical_scope_key || !event.logical_event_key) continue;
    const group = groups.get(semanticKey(event)) ?? [event];
    const keyedNativeItemId = group.map((row) =>
      row.event_subtype === "message" ? row.native_item_id : null
    ).filter((value): value is string =>
      value !== null
    ).sort().at(-1) ?? null;
    const hasSubmitted = group.some((row) =>
      row.event_subtype === "user_message"
    );
    if (!hasSubmitted) continue;
    sources.push({
      ...event,
      prompt_identity: keyedNativeItemId
        ? `native:${keyedNativeItemId}`
        : `logical:${event.canonical_scope_key}:${event.normalizer_version}:` +
          `${event.logical_event_key}:${event.event_kind}`,
      prompt_observed_at: keyedNativeItemId
        ? nativeItemObservedAt(keyedNativeItemId) ?? event.source_observed_at
        : event.source_observed_at,
    });
  }
  for (const event of unkeyedSubmitted) {
    const paired = pairs.get(event.id);
    sources.push({
      ...event,
      prompt_identity: event.native_item_id
        ? `native:${event.native_item_id}`
        : paired?.native_item_id
        ? `native:${paired.native_item_id}`
        : `event:${event.id}`,
      prompt_observed_at: event.native_item_id
        ? nativeItemObservedAt(event.native_item_id) ?? event.source_observed_at
        : paired?.activity_observed_at ?? event.source_observed_at,
    });
  }
  return sources.filter((event) =>
    inWindow(event.prompt_observed_at, coveredFrom, coveredThrough)
  ).map((event) => ({
    evidence_kind: "prompt",
    source_event_id: event.id,
    anchor_observed_at: event.source_observed_at,
    observed_at: event.prompt_observed_at,
    actor_role: event.actor_role,
    event_kind: event.event_kind,
    event_subtype: event.event_subtype,
    message_role: event.message_role,
    message_origin: event.message_origin,
    prompt_identity: event.prompt_identity,
    is_summary_candidate: false,
    is_tombstone: false,
  }));
}

function isActivityCandidate(event: SourceEvent): boolean {
  return event.stored_actor_role !== "automation" && [
    "message",
    "reasoning",
    "tool_call",
    "tool_result",
    "agent_spawn",
    "agent_message",
    "lifecycle",
    "error",
  ].includes(event.event_kind) &&
    (event.event_kind !== "message" || event.native_item_id !== null ||
      event.event_subtype === "user_message") &&
    (event.event_kind !== "lifecycle" || [
      "task_started",
      "task_complete",
      "turn_started",
      "turn_complete",
    ].includes(event.event_subtype ?? ""));
}

function isPromptCandidate(event: SourceEvent): boolean {
  return event.event_kind === "message" && event.message_origin === "human" &&
    event.message_role === "user" && event.content_sha256 !== null &&
    (event.content_byte_size ?? 0) > 0 && event.error_code === null &&
    event.stored_actor_role === "primary";
}

function canonicalSemanticRows(events: readonly SourceEvent[]): SourceEvent[] {
  const groups = semanticGroups(events);
  const result: SourceEvent[] = [];
  const groupedIds = new Set<bigint>();
  for (const rows of groups.values()) {
    rows.forEach((row) => groupedIds.add(row.id));
    result.push([...rows].sort(compareSemantic)[0]);
  }
  result.push(...events.filter((event) => !groupedIds.has(event.id)));
  return result.sort((left, right) => compareBigint(left.id, right.id));
}

function semanticGroups(
  events: readonly SourceEvent[],
): Map<string, SourceEvent[]> {
  const groups = new Map<string, SourceEvent[]>();
  for (const event of events) {
    if (!event.canonical_scope_key || !event.logical_event_key) continue;
    const key = semanticKey(event);
    const rows = groups.get(key) ?? [];
    rows.push(event);
    groups.set(key, rows);
  }
  return groups;
}

function semanticKey(event: SourceEvent): string {
  return JSON.stringify([
    event.session_id,
    event.canonical_scope_key,
    event.normalizer_version,
    event.logical_event_key,
    event.event_kind,
  ]);
}

function compareSemantic(left: SourceEvent, right: SourceEvent): number {
  if (left.source_priority !== right.source_priority) {
    return right.source_priority - left.source_priority;
  }
  if (left.occurred_at === null && right.occurred_at !== null) return 1;
  if (left.occurred_at !== null && right.occurred_at === null) return -1;
  const occurred = (left.occurred_at ?? "").localeCompare(
    right.occurred_at ?? "",
  );
  return occurred || compareBigint(left.id, right.id);
}

function isConversationSource(event: SourceEvent): boolean {
  if (
    !event.content_sha256 || event.logical_event_key !== null ||
    event.turn_id !== null
  ) {
    return false;
  }
  if (
    !(event.message_role === "assistant" || event.message_role === "user" &&
        (event.message_origin === "human" ||
          event.message_origin === "parent_agent"))
  ) {
    return false;
  }
  return event.event_kind === "agent_message" &&
      event.event_subtype === "agent_message" &&
      event.message_role === "assistant" &&
      event.source_native_type === "event_msg" &&
      event.source_native_payload_type === "agent_message" ||
    event.event_kind === "message" &&
      ["message", "user_message"].includes(event.event_subtype ?? "") &&
      ["assistant", "user"].includes(event.message_role ?? "") &&
      ["event_msg", "response_item"].includes(
        event.source_native_type ?? "",
      ) &&
      ["message", "user_message"].includes(
        event.source_native_payload_type ?? "",
      ) ||
    event.event_kind === "message" &&
      ["message", "user_message"].includes(event.event_subtype ?? "") &&
      ["assistant", "user"].includes(event.message_role ?? "") &&
      event.source_kind === "transcript" &&
      ["assistant", "user"].includes(event.source_native_type ?? "") &&
      event.source_native_payload_type === null;
}

function representationSuppressed(events: readonly SourceEvent[]): Set<bigint> {
  const suppressed = new Set<bigint>();
  const pairs: Array<{ left: bigint; right: bigint; suppress: bigint }> = [];
  for (const group of groupBy(events, representationContextKey).values()) {
    for (const left of group) {
      for (const right of group) {
        if (left.id === right.id || !sameRepresentationContext(left, right)) {
          continue;
        }
        if (
          left.event_kind === "agent_message" &&
          left.event_subtype === "agent_message" &&
          left.message_role === "assistant" &&
          left.source_native_type === "event_msg" &&
          left.source_native_payload_type === "agent_message" &&
          left.native_item_id === null &&
          right.event_kind === "message" && right.event_subtype === "message" &&
          right.message_role === "assistant" &&
          right.source_native_type === "response_item" &&
          right.source_native_payload_type === "message" &&
          distance(left.activity_observed_at, right.activity_observed_at) <=
            ASSISTANT_REPRESENTATION_MATCH_MS
        ) {
          pairs.push({ left: left.id, right: right.id, suppress: left.id });
        }
        if (
          left.event_kind === "message" &&
          left.event_subtype === "user_message" &&
          left.message_role === "user" &&
          left.source_native_type === "event_msg" &&
          left.source_native_payload_type === "user_message" &&
          left.native_item_id === null &&
          right.event_kind === "message" && right.event_subtype === "message" &&
          right.message_role === "user" &&
          right.source_native_type === "response_item" &&
          right.source_native_payload_type === "message" &&
          distance(left.activity_observed_at, right.activity_observed_at) <=
            UNKEYED_PROMPT_MATCH_MS
        ) {
          pairs.push({ left: left.id, right: right.id, suppress: right.id });
        }
      }
    }
  }
  const leftDegree = degrees(pairs.map((pair) => pair.left));
  const rightDegree = degrees(pairs.map((pair) => pair.right));
  for (const pair of pairs) {
    if (leftDegree.get(pair.left) === 1 && rightDegree.get(pair.right) === 1) {
      suppressed.add(pair.suppress);
    }
  }
  const byBatchRecord = groupBy(
    events,
    (event) => `${event.source_batch_id}:${event.source_record_index}`,
  );
  for (const later of events) {
    const earlier = byBatchRecord.get(
      `${later.source_batch_id}:${later.source_record_index - 1}`,
    ) ?? [];
    if (earlier.some((candidate) => adjacentUserCopy(candidate, later))) {
      suppressed.add(later.id);
    }
  }
  return suppressed;
}

function sameRepresentationContext(
  left: SourceEvent,
  right: SourceEvent,
): boolean {
  return left.person_id === right.person_id &&
    left.session_id === right.session_id &&
    left.actor_role === right.actor_role &&
    left.stored_actor_role === right.stored_actor_role &&
    left.content_sha256 === right.content_sha256 &&
    left.canonical_scope_key === right.canonical_scope_key &&
    left.source_collector_key === right.source_collector_key &&
    left.source_kind === right.source_kind &&
    left.source_stream_key === right.source_stream_key &&
    left.generation_key === right.generation_key &&
    left.generation_seq === right.generation_seq;
}

function adjacentUserCopy(earlier: SourceEvent, later: SourceEvent): boolean {
  return earlier.id !== later.id && earlier.person_id === later.person_id &&
    earlier.session_id === later.session_id &&
    earlier.actor_role === later.actor_role &&
    earlier.stored_actor_role === later.stored_actor_role &&
    earlier.content_sha256 !== null &&
    earlier.content_sha256 === later.content_sha256 &&
    earlier.canonical_scope_key === later.canonical_scope_key &&
    earlier.source_batch_id === later.source_batch_id &&
    later.source_record_index === earlier.source_record_index + 1 &&
    later.source_start_offset === earlier.source_end_offset &&
    earlier.event_kind === "message" && later.event_kind === "message" &&
    earlier.event_subtype === "user_message" &&
    later.event_subtype === "user_message" &&
    earlier.message_role === "user" && later.message_role === "user" &&
    earlier.source_native_type === "event_msg" &&
    later.source_native_type === "event_msg" &&
    earlier.source_native_payload_type === "user_message" &&
    later.source_native_payload_type === "user_message" &&
    earlier.native_item_id === null && later.native_item_id === null &&
    distance(earlier.activity_observed_at, later.activity_observed_at) <=
      ADJACENT_PROMPT_MATCH_MS;
}

function adjacentPromptSuppressed(events: readonly SourceEvent[]): Set<bigint> {
  const suppressed = new Set<bigint>();
  const byBatchRecord = groupBy(
    events,
    (event) => `${event.source_batch_id}:${event.source_record_index}`,
  );
  for (const duplicate of events) {
    const previousRows = byBatchRecord.get(
      `${duplicate.source_batch_id}:${duplicate.source_record_index - 1}`,
    ) ?? [];
    if (
      previousRows.some((previous) =>
        previous.id !== duplicate.id &&
        previous.session_id === duplicate.session_id &&
        previous.event_kind === duplicate.event_kind &&
        previous.event_subtype === duplicate.event_subtype &&
        previous.content_sha256 === duplicate.content_sha256 &&
        previous.source_batch_id === duplicate.source_batch_id &&
        previous.source_record_index === duplicate.source_record_index - 1 &&
        previous.source_end_offset === duplicate.source_start_offset &&
        previous.canonical_scope_key === duplicate.canonical_scope_key &&
        duplicate.event_subtype === "user_message" &&
        previous.source_native_type === "event_msg" &&
        previous.source_native_payload_type === "user_message" &&
        duplicate.source_native_type === "event_msg" &&
        duplicate.source_native_payload_type === "user_message" &&
        previous.native_item_id === null &&
        duplicate.native_item_id === null &&
        previous.logical_event_key === null &&
        duplicate.logical_event_key === null && previous.turn_id === null &&
        duplicate.turn_id === null &&
        distance(previous.source_observed_at, duplicate.source_observed_at) <=
          ADJACENT_PROMPT_MATCH_MS
      )
    ) suppressed.add(duplicate.id);
  }
  return suppressed;
}

function mutuallyUniquePromptPairs(
  submitted: readonly SourceEvent[],
  nativeCandidates: readonly SourceEvent[],
): Map<bigint, SourceEvent> {
  const pairs: Array<{ submitted: SourceEvent; native: SourceEvent }> = [];
  const nativeByContext = groupBy(nativeCandidates, promptPairContextKey);
  for (const source of submitted) {
    for (
      const native of nativeByContext.get(promptPairContextKey(source)) ?? []
    ) {
      if (
        source.session_id === native.session_id &&
        source.content_sha256 === native.content_sha256 &&
        source.source_collector_key === native.source_collector_key &&
        source.source_kind === native.source_kind &&
        source.source_stream_key === native.source_stream_key &&
        source.generation_key === native.generation_key &&
        source.generation_seq === native.generation_seq &&
        source.logical_event_key === null &&
        source.turn_id === null && native.logical_event_key === null &&
        native.turn_id === null &&
        distance(source.source_observed_at, native.source_observed_at) <=
          UNKEYED_PROMPT_MATCH_MS
      ) {
        pairs.push({ submitted: source, native });
      }
    }
  }
  const submittedDegree = degrees(pairs.map((pair) => pair.submitted.id));
  const nativeDegree = degrees(pairs.map((pair) => pair.native.id));
  return new Map(
    pairs.filter((pair) =>
      submittedDegree.get(pair.submitted.id) === 1 &&
      nativeDegree.get(pair.native.id) === 1
    ).map((pair) => [pair.submitted.id, pair.native]),
  );
}

function representationContextKey(event: SourceEvent): string {
  return JSON.stringify([
    event.person_id,
    event.session_id,
    event.actor_role,
    event.stored_actor_role,
    event.content_sha256,
    event.canonical_scope_key,
    event.source_collector_key,
    event.source_kind,
    event.source_stream_key,
    event.generation_key,
    event.generation_seq.toString(),
  ]);
}

function promptPairContextKey(event: SourceEvent): string {
  return JSON.stringify([
    event.session_id,
    event.content_sha256,
    event.source_collector_key,
    event.source_kind,
    event.source_stream_key,
    event.generation_key,
    event.generation_seq.toString(),
  ]);
}

function groupBy<T>(
  values: readonly T[],
  keyFor: (value: T) => string,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = result.get(key) ?? [];
    group.push(value);
    result.set(key, group);
  }
  return result;
}

export function diffEvidence(
  desired: readonly EvidenceState[],
  previous: readonly EvidenceState[],
): EvidenceState[] {
  const desiredByKey = uniqueEvidenceMap(desired);
  const previousByKey = uniqueEvidenceMap(previous);
  const changes: EvidenceState[] = [];
  for (const state of desired) {
    const prior = previousByKey.get(evidenceKey(state));
    if (!prior || !sameEvidence(state, prior)) changes.push(state);
  }
  for (const prior of previous) {
    if (!prior.is_tombstone && !desiredByKey.has(evidenceKey(prior))) {
      changes.push({ ...prior, is_tombstone: true });
    }
  }
  return changes.sort(compareEvidence);
}

export async function fingerprintEvidence(
  states: readonly EvidenceState[],
): Promise<string> {
  const canonical = [...states].sort(compareEvidence).map((state) => [
    state.evidence_kind,
    state.source_event_id.toString(),
    state.anchor_observed_at,
    state.observed_at,
    state.actor_role,
    state.event_kind,
    state.event_subtype,
    state.message_role,
    state.message_origin,
    state.prompt_identity,
    state.is_summary_candidate,
    state.is_tombstone,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical)),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function fingerprintSourceState(
  events: readonly SourceEvent[],
  sessionStartedAt: string,
  sessionUpdatedAt: string,
): Promise<string> {
  const canonical = [...events].sort((left, right) =>
    compareBigint(left.id, right.id)
  )
    .map((event) => [
      event.id.toString(),
      event.normalizer_version,
      event.canonical_scope_key,
      event.logical_event_key,
      event.source_priority,
      event.event_kind,
      event.event_subtype,
      event.stored_actor_role,
      event.actor_role,
      event.occurred_at,
      event.source_observed_at,
      event.activity_observed_at,
      event.native_item_id,
      event.turn_id,
      event.message_role,
      event.message_origin,
      event.content_sha256,
      event.content_byte_size,
      event.has_content_excerpt,
      event.error_code,
      event.source_batch_id,
      event.source_record_index,
      event.source_start_offset.toString(),
      event.source_end_offset.toString(),
      event.source_native_type,
      event.source_native_payload_type,
      event.source_collector_key,
      event.source_kind,
      event.source_stream_key,
      event.generation_key,
      event.generation_seq.toString(),
    ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([sessionStartedAt, sessionUpdatedAt, canonical]),
    ),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function uniqueEvidenceMap(
  states: readonly EvidenceState[],
): Map<string, EvidenceState> {
  const result = new Map<string, EvidenceState>();
  for (const state of states) {
    const key = evidenceKey(state);
    if (result.has(key)) throw new Error(`duplicate frame evidence key ${key}`);
    result.set(key, state);
  }
  return result;
}

function sameEvidence(left: EvidenceState, right: EvidenceState): boolean {
  return left.evidence_kind === right.evidence_kind &&
    left.source_event_id === right.source_event_id &&
    left.anchor_observed_at === right.anchor_observed_at &&
    left.observed_at === right.observed_at &&
    left.actor_role === right.actor_role &&
    left.event_kind === right.event_kind &&
    left.event_subtype === right.event_subtype &&
    left.message_role === right.message_role &&
    left.message_origin === right.message_origin &&
    left.prompt_identity === right.prompt_identity &&
    left.is_summary_candidate === right.is_summary_candidate &&
    left.is_tombstone === right.is_tombstone;
}

function evidenceKey(state: EvidenceState): string {
  return `${state.evidence_kind}:${state.source_event_id}`;
}

function compareEvidence(left: EvidenceState, right: EvidenceState): number {
  return left.evidence_kind.localeCompare(right.evidence_kind) ||
    compareBigint(left.source_event_id, right.source_event_id);
}

function sourceEventFromRow(row: Record<string, unknown>): SourceEvent {
  return {
    id: BigInt(String(row.id)),
    person_id: String(row.person_id),
    session_id: String(row.session_id),
    normalizer_version: String(row.normalizer_version),
    canonical_scope_key: nullableString(row.canonical_scope_key),
    logical_event_key: nullableString(row.logical_event_key),
    source_priority: Number(row.source_priority),
    event_kind: String(row.event_kind),
    event_subtype: nullableString(row.event_subtype),
    stored_actor_role: String(
      row.stored_actor_role,
    ) as SourceEvent["stored_actor_role"],
    actor_role: String(row.actor_role) as SourceEvent["actor_role"],
    occurred_at: nullableDateString(row.occurred_at),
    source_observed_at: dateString(row.source_observed_at),
    activity_observed_at: dateString(row.activity_observed_at),
    native_item_id: nullableString(row.native_item_id),
    turn_id: nullableString(row.turn_id),
    message_role: nullableString(row.message_role),
    message_origin: nullableString(row.message_origin),
    content_sha256: nullableString(row.content_sha256),
    content_byte_size: row.content_byte_size === null
      ? null
      : Number(row.content_byte_size),
    has_content_excerpt: Boolean(row.has_content_excerpt),
    error_code: nullableString(row.error_code),
    source_batch_id: String(row.source_batch_id),
    source_record_index: Number(row.source_record_index),
    source_start_offset: BigInt(String(row.source_start_offset)),
    source_end_offset: BigInt(String(row.source_end_offset)),
    source_native_type: nullableString(row.source_native_type),
    source_native_payload_type: nullableString(row.source_native_payload_type),
    source_collector_key: String(row.source_collector_key),
    source_kind: String(row.source_kind),
    source_stream_key: String(row.source_stream_key),
    generation_key: String(row.generation_key),
    generation_seq: BigInt(String(row.generation_seq)),
  };
}

function evidenceFromRow(row: Record<string, unknown>): EvidenceState {
  return {
    evidence_kind: String(row.evidence_kind) as EvidenceState["evidence_kind"],
    source_event_id: BigInt(String(row.source_event_id)),
    anchor_observed_at: dateString(row.anchor_observed_at),
    observed_at: dateString(row.observed_at),
    actor_role: String(row.actor_role) as EvidenceState["actor_role"],
    event_kind: String(row.event_kind),
    event_subtype: nullableString(row.event_subtype),
    message_role: nullableString(row.message_role),
    message_origin: nullableString(row.message_origin),
    prompt_identity: nullableString(row.prompt_identity),
    is_summary_candidate: Boolean(row.is_summary_candidate),
    is_tombstone: Boolean(row.is_tombstone),
  };
}

function nativeItemObservedAt(value: string): string | null {
  const match =
    /^[a-z][a-z0-9]*_([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .exec(value);
  if (!match) return null;
  const milliseconds = Number.parseInt(`${match[1]}${match[2]}`, 16);
  return Number.isSafeInteger(milliseconds)
    ? dateString(new Date(milliseconds))
    : null;
}

function inWindow(value: string, start: Date, end: Date): boolean {
  const time = microseconds(value);
  return time >= BigInt(start.getTime()) * 1_000n &&
    time < BigInt(end.getTime()) * 1_000n;
}

function distance(left: string, right: string): number {
  const delta = microseconds(left) - microseconds(right);
  return Number(delta < 0n ? -delta : delta) / 1_000;
}

const UTC_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/;

function microseconds(value: string): bigint {
  const canonical = dateString(value);
  const match = UTC_TIMESTAMP.exec(canonical);
  if (!match) {
    throw new Error("invalid frame evidence timestamp");
  }
  const seconds = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(seconds)) {
    throw new Error("invalid frame evidence timestamp");
  }
  return BigInt(seconds) * 1_000n + BigInt(match[2]);
}

function dateString(value: unknown): string {
  if (typeof value === "string") {
    const match = UTC_TIMESTAMP.exec(value);
    if (match) {
      return `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`;
    }
  }
  const result = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(result.getTime())) {
    throw new Error("invalid frame evidence timestamp");
  }
  const iso = result.toISOString();
  return `${iso.slice(0, -1)}000Z`;
}

function nullableDateString(value: unknown): string | null {
  return value === null || value === undefined ? null : dateString(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function degrees(values: readonly bigint[]): Map<bigint, number> {
  const result = new Map<bigint, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
