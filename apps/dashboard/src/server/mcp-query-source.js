import { createHash } from "node:crypto";

import { FlameSourceError } from "./flame-source.js";

export const MCP_QUERY_SCHEMA_VERSION = "sherlock.query.v1";
export const MCP_QUERY_DEFAULT_LIMIT = 20;
export const MCP_QUERY_MAX_LIMIT = 100;
export const MCP_QUERY_MAX_GROUPS = 200;
export const MCP_QUERY_HISTORY_START = "1970-01-01T00:00:00.000Z";

const SESSION_CURSOR_VERSION = "s1";
const LEGACY_QUERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CURSOR_LENGTH = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_VERSIONS = Object.freeze([
  "sherlock.codex-rollout.v1",
  "sherlock.codex-rollout.v2",
  "sherlock.claude-code-transcript.v1",
]);

const FRAME_CODEX_VERSION = "sherlock.codex-rollout.v2";
const FRAME_LEGACY_CODEX_VERSION = "sherlock.codex-rollout.v1";
const FRAME_CLAUDE_VERSION = "sherlock.claude-code-transcript.v1";

// Match the canonical frame projector, including its pre-cutover v2 fallback
// for an immutable source record that has no non-replay v1 projection.
function activeNormalizerPredicate(event, session, batch, cutover) {
  return `(
    ${batch}.source_provider = 'claude_code'
    and ${event}.normalizer_version = '${FRAME_CLAUDE_VERSION}'
    or ${batch}.source_provider = 'codex'
    and (
      (${cutover}.cutover_at is null
       or ${session}.started_at >= ${cutover}.cutover_at)
      and ${event}.normalizer_version = '${FRAME_CODEX_VERSION}'
      or ${session}.started_at < ${cutover}.cutover_at
      and (
        ${event}.normalizer_version = '${FRAME_LEGACY_CODEX_VERSION}'
        or ${event}.normalizer_version = '${FRAME_CODEX_VERSION}'
        and not exists (
          select 1 from telemetry.events legacy
           where legacy.workspace_id = ${event}.workspace_id
             and legacy.source_record_id = ${event}.source_record_id
             and legacy.normalizer_version = '${FRAME_LEGACY_CODEX_VERSION}'
             and not legacy.is_replay
        )
      )
    )
  )`;
}

// Resolve canonical identity against all visible projections, not only those
// inside a reporting window. The partial canonical index bounds this lookup.
function canonicalWinnerPredicate(event, session) {
  return `not exists (
    select 1 from telemetry.events winner
    join telemetry.native_records winner_record
      on winner_record.workspace_id = winner.workspace_id
     and winner_record.id = winner.source_record_id
    join telemetry.ingest_batches winner_batch
      on winner_batch.workspace_id = winner_record.workspace_id
     and winner_batch.id = winner_record.batch_id
    left join analytics.normalizer_cutovers winner_cutover
      on winner_cutover.workspace_id = winner.workspace_id
     and winner_cutover.source_provider = winner_batch.source_provider
     and winner_cutover.to_normalizer_version = '${FRAME_CODEX_VERSION}'
    where winner.workspace_id = ${event}.workspace_id
      and winner.session_id = ${event}.session_id
      and winner.normalizer_version = ${event}.normalizer_version
      and winner.canonical_scope_key = ${event}.canonical_scope_key
      and winner.logical_event_key = ${event}.logical_event_key
      and winner.event_kind = ${event}.event_kind and not winner.is_replay
      and (winner.source_priority > ${event}.source_priority
        or winner.source_priority = ${event}.source_priority
          and (winner.occurred_at, winner.id) < (${event}.occurred_at, ${event}.id))
      and ${activeNormalizerPredicate("winner", session, "winner_batch", "winner_cutover")}
  )`;
}

function asDate(value, code = "flame_mcp_query_request_invalid") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new FlameSourceError(code);
  return date;
}

function safeCount(value) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new FlameSourceError("flame_database_result_invalid");
  }
  return number;
}

function optionalIso(value) {
  return value === null || value === undefined ? null : asDate(value).toISOString();
}

export function queryWindow({ start, end } = {}, now = new Date()) {
  const read = asDate(now);
  const endAt = end === undefined ? read : asDate(end);
  const startAt = start === undefined
    ? new Date(MCP_QUERY_HISTORY_START)
    : asDate(start);
  const duration = endAt.getTime() - startAt.getTime();
  if (duration <= 0 || endAt > read) {
    throw new FlameSourceError("flame_mcp_query_request_invalid");
  }
  return { startAt, endAt, readAt: read };
}

function parseLimit(value) {
  if (value === undefined) return MCP_QUERY_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MCP_QUERY_MAX_LIMIT) {
    throw new FlameSourceError("flame_mcp_query_request_invalid");
  }
  return value;
}

function sessionFingerprint({ workspaceId, startAt, endAt, personId, model }) {
  return createHash("sha256").update(JSON.stringify([
    workspaceId,
    startAt.toISOString(),
    endAt.toISOString(),
    personId ?? null,
    model ?? null,
  ])).digest("base64url").slice(0, 22);
}

export function encodeSessionCursor({ readAt, createdAt, sessionId, fingerprint }) {
  const body = Buffer.from(JSON.stringify([
    asDate(readAt).toISOString(),
    asDate(createdAt).toISOString(),
    sessionId,
    fingerprint,
  ]), "utf8").toString("base64url");
  const cursor = `${SESSION_CURSOR_VERSION}.${body}`;
  if (!UUID_PATTERN.test(sessionId) || cursor.length > MAX_CURSOR_LENGTH) {
    throw new FlameSourceError("flame_mcp_query_cursor_invalid");
  }
  return cursor;
}

function parseSessionCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  if (typeof cursor !== "string" || cursor.length > MAX_CURSOR_LENGTH) {
    throw new FlameSourceError("flame_mcp_query_cursor_invalid");
  }
  try {
    const [version, body, extra] = cursor.split(".");
    if (version !== SESSION_CURSOR_VERSION || !body || extra !== undefined ||
        !/^[A-Za-z0-9_-]+$/.test(body)) throw new Error("invalid_cursor");
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== body) {
      throw new Error("noncanonical_cursor");
    }
    const value = JSON.parse(decoded);
    if (!Array.isArray(value) || value.length !== 4 ||
        !UUID_PATTERN.test(value[2]) || typeof value[3] !== "string") {
      throw new Error("invalid_cursor");
    }
    return {
      readAt: asDate(value[0], "flame_mcp_query_cursor_invalid"),
      createdAt: asDate(value[1], "flame_mcp_query_cursor_invalid"),
      sessionId: value[2],
      fingerprint: value[3],
    };
  } catch (error) {
    if (error instanceof FlameSourceError) throw error;
    throw new FlameSourceError("flame_mcp_query_cursor_invalid");
  }
}

export function decodeSessionCursor(cursor, fingerprint) {
  const decoded = parseSessionCursor(cursor);
  if (decoded === null) return null;
  if (decoded.fingerprint !== fingerprint) {
    throw new FlameSourceError("flame_mcp_query_cursor_invalid");
  }
  const { fingerprint: _fingerprint, ...result } = decoded;
  return result;
}

function providerFromVersion(version) {
  if (version === "sherlock.claude-code-transcript.v1") return "claude";
  if (version === "sherlock.codex-rollout.v1" ||
      version === "sherlock.codex-rollout.v2") return "codex";
  return "unknown";
}

function sessionFromRow(row) {
  return {
    sessionId: String(row.session_id),
    personId: String(row.person_id),
    displayName: String(row.display_name),
    provider: providerFromVersion(row.normalizer_version),
    actorRole: String(row.actor_role),
    model: row.model === null || row.model === undefined ? "unknown" : String(row.model),
    startedAt: asDate(row.started_at).toISOString(),
    endedAt: optionalIso(row.ended_at),
    parentSessionId: row.parent_session_id === null || row.parent_session_id === undefined
      ? null
      : String(row.parent_session_id),
  };
}

function coverageReceipt(row, {
  observedUsageEvents, streams, missingBaselines, regressions, missingTokenComponents = [],
  arithmeticAssessed = true,
}) {
  const pending = safeCount(row?.pending_normalize_count);
  const reasons = [
    "collector_presence_not_proven",
    "normalization_failures_not_assessed",
  ];
  if (pending > 0) reasons.push("normalization_pending");
  if (missingBaselines > 0) reasons.push("cumulative_baseline_missing");
  if (regressions > 0) reasons.push("cumulative_counter_regressed");
  if (missingTokenComponents.length > 0) reasons.push("token_component_missing");
  if (!arithmeticAssessed) reasons.push("usage_arithmetic_not_assessed");
  const state = observedUsageEvents === 0 ? "missing" : "partial";
  return {
    state,
    basis: "observed_canonical_usage",
    reasons,
    observedUsageEvents,
    streams,
    pendingNormalizationJobs: pending,
    missingCumulativeBaselines: missingBaselines,
    regressedCumulativeStreams: regressions,
    missingTokenComponents,
    rawWatermark: optionalIso(row?.raw_watermark),
    canonicalWatermark: optionalIso(row?.canonical_watermark),
  };
}

function usageKey(row, groupBy) {
  const provider = String(row.provider);
  const person = groupBy === "model" ? null : String(row.person_id);
  const model = groupBy === "person" ? null : String(row.model);
  return JSON.stringify([person, provider, model]);
}

function emptyTokens() {
  return { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 };
}

export function buildUsageResult(rows, receipt, { groupBy, startAt, endAt, readAt }) {
  if (rows.length > MCP_QUERY_MAX_GROUPS) {
    throw new FlameSourceError("flame_mcp_query_result_too_large");
  }
  const groups = new Map();
  const observedStreams = new Set();
  const missingTokenComponents = new Set();
  let observedUsageEvents = 0;
  let missingBaselines = 0;
  const regressedStreams = new Set();
  for (const row of rows) {
    observedUsageEvents += safeCount(row.usage_event_count);
    for (const streamId of row.stream_ids ?? []) observedStreams.add(String(streamId));
    const rowMissingComponents = (row.missing_token_components ?? []).map(String);
    for (const component of rowMissingComponents) missingTokenComponents.add(component);
    missingBaselines += safeCount(row.missing_baseline_count);
    for (const streamId of row.regressed_stream_ids ?? []) regressedStreams.add(String(streamId));
    const key = usageKey(row, groupBy);
    const current = groups.get(key) ?? {
      ...(groupBy === "model" ? {} : {
        personId: String(row.person_id),
        displayName: String(row.display_name),
      }),
      provider: String(row.provider),
      ...(groupBy === "person" ? {} : { model: String(row.model) }),
      tokens: emptyTokens(),
      usageEventCount: 0,
      sessionIds: new Set(),
      missingTokenComponents: new Set(),
    };
    current.tokens.input += safeCount(row.input_tokens);
    current.tokens.cachedInput += safeCount(row.cached_input_tokens);
    current.tokens.output += safeCount(row.output_tokens);
    current.tokens.reasoning += safeCount(row.reasoning_tokens);
    current.tokens.total += safeCount(row.total_tokens);
    for (const sessionId of row.session_ids ?? []) current.sessionIds.add(String(sessionId));
    for (const component of rowMissingComponents) {
      current.missingTokenComponents.add(component);
    }
    current.usageEventCount += safeCount(row.usage_event_count);
    groups.set(key, current);
  }
  if (groups.size > MCP_QUERY_MAX_GROUPS) {
    throw new FlameSourceError("flame_mcp_query_result_too_large");
  }
  return {
    schemaVersion: MCP_QUERY_SCHEMA_VERSION,
    window: {
      startInclusive: startAt.toISOString(),
      endExclusive: endAt.toISOString(),
      readAt: readAt.toISOString(),
    },
    groupBy,
    groups: [...groups.values()].map(({
      sessionIds, missingTokenComponents: groupMissing, ...group
    }) => ({
      ...group,
      tokens: {
        input: groupMissing.has("input") ? null : group.tokens.input,
        cachedInput: groupMissing.has("cachedInput") ? null : group.tokens.cachedInput,
        output: groupMissing.has("output") ? null : group.tokens.output,
        reasoning: groupMissing.has("reasoning") ? null : group.tokens.reasoning,
        total: groupMissing.has("total") ? null : group.tokens.total,
      },
      sessionCount: sessionIds.size,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    coverage: coverageReceipt(receipt, {
      observedUsageEvents,
      streams: observedStreams.size,
      missingBaselines,
      regressions: regressedStreams.size,
      missingTokenComponents: [...missingTokenComponents].sort(),
    }),
  };
}

async function runQuery(tx, text, params, signal) {
  if (signal?.aborted) throw new FlameSourceError("flame_request_aborted");
  const query = params === undefined ? tx.unsafe(text) : tx.unsafe(text, params);
  const cancel = () => {
    const cancellation = query.cancel?.();
    if (cancellation && typeof cancellation.catch === "function") {
      void cancellation.catch(() => {});
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await query;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

const FRESHNESS_RECEIPT_SQL = `
select read_at, raw_watermark, canonical_watermark,
       oldest_pending_normalize, pending_normalize_count
  from analytics.read_dashboard_freshness($1, $2, $3, $4)
 limit 1
`;

const ROSTER_COUNT_SQL = `
select count(*)::bigint person_count
  from (
    select 1
      from telemetry.people pe
     where pe.workspace_id = $1
       and pe.github_id is distinct from 'sherlock-smoke'
       and split_part(pe.email, '@', 2) = $2
       and split_part(pe.email, '@', 3) = ''
     limit $3
  ) bounded_roster
`;

async function ensureRosterBound(tx, source, signal) {
  const rows = await runQuery(tx, ROSTER_COUNT_SQL, [
    source.workspaceId,
    source.expectedEmailDomain,
    source.maxPeople + 1,
  ], signal);
  if (safeCount(rows[0]?.person_count) > source.maxPeople) {
    throw new FlameSourceError("flame_mcp_query_roster_too_large");
  }
}

// The query selects the active append-only projection for each provider, removes
// canonical duplicates, and differences cumulative streams from the last
// pre-window observation. A stream that began inside the window has an implicit
// zero baseline; an older stream without a baseline is reported as partial.
export const QUERY_USAGE_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::timestamptz start_at,
         $3::timestamptz end_at, $4::text expected_email_domain
), roster as materialized (
  select pe.id person_id,
         coalesce(nullif(btrim(pe.display_name), ''), 'Unknown') display_name
    from telemetry.people pe cross join p
   where pe.workspace_id = p.workspace_id
     and pe.github_id is distinct from 'sherlock-smoke'
     and split_part(pe.email, '@', 2) = p.expected_email_domain
     and split_part(pe.email, '@', 3) = ''
), eligible_sessions as materialized (
  select s.id session_id, s.person_id, r.display_name, s.started_at,
         nullif(btrim(s.model), '') session_model
    from telemetry.sessions s
    join roster r on r.person_id = s.person_id
    cross join p
   where s.workspace_id = p.workspace_id and s.started_at < p.end_at
), window_candidates as materialized (
  select e.id, e.session_id, s.person_id, s.display_name, s.started_at,
         e.normalizer_version,
         case when e.normalizer_version = 'sherlock.claude-code-transcript.v1'
              then 'claude' else 'codex' end provider,
         coalesce(nullif(btrim(e.model), ''), s.session_model, 'unknown') model,
         e.usage_stream_key, e.usage_is_cumulative,
         e.input_tokens, e.cached_input_tokens, e.output_tokens,
         e.reasoning_tokens, e.total_tokens, e.occurred_at usage_at,
         row_number() over (
           partition by e.session_id, e.normalizer_version,
             coalesce(e.canonical_scope_key, 'event:' || e.id::text),
             coalesce(e.logical_event_key, 'event:' || e.id::text), e.event_kind
           order by e.source_priority desc, e.occurred_at, e.id
         ) canonical_rank
    from eligible_sessions s
    join telemetry.events e on e.session_id = s.session_id
    join telemetry.native_records nr
      on nr.workspace_id = e.workspace_id and nr.id = e.source_record_id
    join telemetry.ingest_batches ib
      on ib.workspace_id = nr.workspace_id and ib.id = nr.batch_id
    left join analytics.normalizer_cutovers c
      on c.workspace_id = e.workspace_id
     and c.source_provider = ib.source_provider
     and c.to_normalizer_version = '${FRAME_CODEX_VERSION}'
    cross join p
   where e.workspace_id = p.workspace_id and e.event_kind = 'usage'
     and not e.is_replay and e.occurred_at >= p.start_at
     and e.occurred_at < p.end_at
     and ${activeNormalizerPredicate("e", "s", "ib", "c")}
     and ${canonicalWinnerPredicate("e", "s")}
), window_events as materialized (
  select * from window_candidates where canonical_rank = 1
), streams as materialized (
  select distinct session_id, usage_stream_key, usage_is_cumulative,
         person_id, display_name, started_at
    from window_events
), baselines as materialized (
  select stream.*, baseline.id, baseline.normalizer_version, baseline.usage_at,
         baseline.input_tokens, baseline.cached_input_tokens,
         baseline.output_tokens, baseline.reasoning_tokens, baseline.total_tokens
    from streams stream cross join p
    left join lateral (
      select candidate.id, candidate.normalizer_version, candidate.usage_at,
             candidate.input_tokens,
             candidate.cached_input_tokens, candidate.output_tokens,
             candidate.reasoning_tokens, candidate.total_tokens
        from (
          select e.id, e.normalizer_version, e.occurred_at usage_at, e.input_tokens,
                 e.cached_input_tokens, e.output_tokens,
                 e.reasoning_tokens, e.total_tokens,
                 row_number() over (
                   partition by e.session_id, e.normalizer_version,
                     coalesce(e.canonical_scope_key, 'event:' || e.id::text),
                     coalesce(e.logical_event_key, 'event:' || e.id::text),
                     e.event_kind
                   order by e.source_priority desc, e.occurred_at, e.id
                 ) canonical_rank
            from telemetry.events e
            join telemetry.sessions baseline_session
              on baseline_session.workspace_id = e.workspace_id
             and baseline_session.id = e.session_id
            join telemetry.native_records nr
              on nr.workspace_id = e.workspace_id and nr.id = e.source_record_id
            join telemetry.ingest_batches ib
              on ib.workspace_id = nr.workspace_id and ib.id = nr.batch_id
            left join analytics.normalizer_cutovers c
              on c.workspace_id = e.workspace_id
             and c.source_provider = ib.source_provider
             and c.to_normalizer_version = '${FRAME_CODEX_VERSION}'
           where stream.usage_is_cumulative
             and e.workspace_id = p.workspace_id
             and e.session_id = stream.session_id and e.event_kind = 'usage'
             and not e.is_replay
             and e.usage_stream_key = stream.usage_stream_key
             and e.usage_is_cumulative is not distinct from stream.usage_is_cumulative
             and e.occurred_at < p.start_at
             and ${activeNormalizerPredicate("e", "baseline_session", "ib", "c")}
             and ${canonicalWinnerPredicate("e", "baseline_session")}
        ) candidate
       where candidate.canonical_rank = 1
       order by candidate.usage_at desc, candidate.id desc
       limit 1
    ) baseline on true
), timeline as materialized (
  select session_id, person_id, display_name, started_at,
         normalizer_version, provider, model, usage_stream_key,
         usage_is_cumulative, id, usage_at, input_tokens,
         cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
         true in_window
    from window_events
  union all
  select session_id, person_id, display_name, started_at,
         normalizer_version,
         case when normalizer_version = 'sherlock.claude-code-transcript.v1'
              then 'claude' else 'codex' end provider,
         'unknown' model, usage_stream_key, usage_is_cumulative, id, usage_at,
         input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
         total_tokens, false in_window
    from baselines where id is not null
), ordered as materialized (
  select *,
         lag(input_tokens) over stream_order previous_input,
         lag(cached_input_tokens) over stream_order previous_cached,
         lag(output_tokens) over stream_order previous_output,
         lag(reasoning_tokens) over stream_order previous_reasoning,
         lag(total_tokens) over stream_order previous_total,
         lag(id) over stream_order previous_id
    from timeline
  window stream_order as (
    partition by session_id, usage_stream_key, usage_is_cumulative
    order by usage_at, id
  )
), assessed as materialized (
  select *, bool_or(
    usage_is_cumulative and previous_id is not null and (
      input_tokens < previous_input or cached_input_tokens < previous_cached
      or output_tokens < previous_output or reasoning_tokens < previous_reasoning
      or total_tokens < previous_total
    )
  ) over (
    partition by session_id, usage_stream_key, usage_is_cumulative
  ) stream_regressed
  from ordered
), contributions as materialized (
  select *,
    case when stream_regressed then 0
         when not usage_is_cumulative then coalesce(input_tokens, 0)
         when previous_id is not null and previous_input is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(input_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(input_tokens, previous_input, 0) - coalesce(previous_input, 0), 0)
    end input_delta,
    case when stream_regressed then 0
         when not usage_is_cumulative then coalesce(cached_input_tokens, 0)
         when previous_id is not null and previous_cached is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(cached_input_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(cached_input_tokens, previous_cached, 0) - coalesce(previous_cached, 0), 0)
    end cached_delta,
    case when stream_regressed then 0
         when not usage_is_cumulative then coalesce(output_tokens, 0)
         when previous_id is not null and previous_output is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(output_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(output_tokens, previous_output, 0) - coalesce(previous_output, 0), 0)
    end output_delta,
    case when stream_regressed then 0
         when not usage_is_cumulative then coalesce(reasoning_tokens, 0)
         when previous_id is not null and previous_reasoning is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(reasoning_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(reasoning_tokens, previous_reasoning, 0) - coalesce(previous_reasoning, 0), 0)
    end reasoning_delta,
    case when stream_regressed then 0
         when not usage_is_cumulative then coalesce(total_tokens, 0)
         when previous_id is not null and previous_total is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(total_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(total_tokens, previous_total, 0) - coalesce(previous_total, 0), 0)
    end total_delta,
    (usage_is_cumulative and previous_id is null
      and started_at < (select start_at from p)) missing_baseline,
    stream_regressed regression
  from assessed where in_window
)
select person_id::text, display_name, provider, model,
       sum(input_delta)::bigint input_tokens,
       sum(cached_delta)::bigint cached_input_tokens,
       sum(output_delta)::bigint output_tokens,
       sum(reasoning_delta)::bigint reasoning_tokens,
       sum(total_delta)::bigint total_tokens,
       count(distinct session_id)::bigint session_count,
       count(*)::bigint usage_event_count,
       array_agg(distinct session_id::text) session_ids,
       array_agg(distinct session_id::text || ':' || usage_stream_key || ':' || usage_is_cumulative::text)
         stream_ids,
       count(*) filter (where missing_baseline)::bigint missing_baseline_count,
       array_agg(distinct session_id::text || ':' || usage_stream_key || ':' || usage_is_cumulative::text)
         filter (where regression) regressed_stream_ids,
       array_remove(array[
         case when bool_or(input_tokens is null or
           usage_is_cumulative and previous_id is not null and previous_input is null)
           then 'input' end,
         case when bool_or(cached_input_tokens is null or
           usage_is_cumulative and previous_id is not null and previous_cached is null)
           then 'cachedInput' end,
         case when bool_or(output_tokens is null or
           usage_is_cumulative and previous_id is not null and previous_output is null)
           then 'output' end,
         case when bool_or(reasoning_tokens is null or
           usage_is_cumulative and previous_id is not null and previous_reasoning is null)
           then 'reasoning' end,
         case when bool_or(total_tokens is null or
           usage_is_cumulative and previous_id is not null and previous_total is null)
           then 'total' end
       ], null) missing_token_components
 from contributions
 group by person_id, display_name, provider, model
 order by lower(display_name), person_id, provider, model
 limit ${MCP_QUERY_MAX_GROUPS + 1}
`;

export const LIST_SESSIONS_SQL = `
with page as materialized (
  select s.id, s.person_id, s.actor_role, s.model, s.started_at, s.ended_at,
         s.parent_session_id, s.created_at,
         coalesce(nullif(btrim(pe.display_name), ''), 'Unknown') display_name
    from telemetry.sessions s
    join telemetry.people pe
      on pe.workspace_id = s.workspace_id and pe.id = s.person_id
   where s.workspace_id = $1 and s.started_at >= $2 and s.started_at < $3
     and s.created_at <= $4
     and pe.github_id is distinct from 'sherlock-smoke'
     and split_part(pe.email, '@', 2) = $5 and split_part(pe.email, '@', 3) = ''
     and ($6::uuid is null or s.person_id = $6)
     and ($7::text is null or coalesce(nullif(btrim(s.model), ''), 'unknown') = $7)
     and ($8::timestamptz is null or (s.created_at, s.id) < ($8, $9::uuid))
   order by s.created_at desc, s.id desc
   limit $10
)
select page.id::text session_id, page.person_id::text, page.display_name,
       page.actor_role, coalesce(nullif(btrim(page.model), ''), 'unknown') model,
       page.started_at, page.ended_at, page.parent_session_id::text,
       page.created_at,
       provider.normalizer_version
  from page
  left join lateral (
    select e.normalizer_version
      from telemetry.events e
     where e.workspace_id = $1 and e.session_id = page.id and not e.is_replay
       and e.normalizer_version = any($11::text[])
     order by e.server_received_at desc, e.id desc limit 1
  ) provider on true
 order by page.created_at desc, page.id desc
`;

export const GET_SESSION_SQL = `
with selected as materialized (
  select s.id, s.person_id, s.actor_role, s.model, s.started_at, s.ended_at,
         s.parent_session_id,
         coalesce(nullif(btrim(pe.display_name), ''), 'Unknown') display_name
    from telemetry.sessions s
    join telemetry.people pe
      on pe.workspace_id = s.workspace_id and pe.id = s.person_id
   where s.workspace_id = $1 and s.id = $2
     and pe.github_id is distinct from 'sherlock-smoke'
     and split_part(pe.email, '@', 2) = $3 and split_part(pe.email, '@', 3) = ''
), candidates as materialized (
  select e.event_kind, e.normalizer_version,
         row_number() over (
           partition by e.session_id, e.normalizer_version,
             coalesce(e.canonical_scope_key, 'event:' || e.id::text),
             coalesce(e.logical_event_key, 'event:' || e.id::text), e.event_kind
           order by e.source_priority desc, e.occurred_at, e.id
         ) canonical_rank
    from selected s
    join telemetry.events e
      on e.workspace_id = $1 and e.session_id = s.id and not e.is_replay
    join telemetry.native_records nr
      on nr.workspace_id = e.workspace_id and nr.id = e.source_record_id
    join telemetry.ingest_batches ib
      on ib.workspace_id = nr.workspace_id and ib.id = nr.batch_id
    left join analytics.normalizer_cutovers c
      on c.workspace_id = e.workspace_id
     and c.source_provider = ib.source_provider
     and c.to_normalizer_version = '${FRAME_CODEX_VERSION}'
   where e.normalizer_version = any($4::text[])
     and ${activeNormalizerPredicate("e", "s", "ib", "c")}
), facts as (
  select count(*) filter (
           where event_kind = 'message' and canonical_rank = 1
         )::bigint messages,
         count(*) filter (
           where event_kind = 'tool_call' and canonical_rank = 1
         )::bigint tool_calls,
         count(*) filter (
           where event_kind = 'usage' and canonical_rank = 1
         )::bigint usage_events,
         max(normalizer_version) filter (where canonical_rank = 1) normalizer_version
    from candidates
)
select selected.id::text session_id, selected.person_id::text,
       selected.display_name, selected.actor_role,
       coalesce(nullif(btrim(selected.model), ''), 'unknown') model,
       selected.started_at, selected.ended_at, selected.parent_session_id::text,
       facts.normalizer_version, facts.messages, facts.tool_calls, facts.usage_events
  from selected cross join facts
`;

export const COVERAGE_SQL = `
with roster as materialized (
  select pe.id person_id
    from telemetry.people pe
   where pe.workspace_id = $1 and pe.github_id is distinct from 'sherlock-smoke'
     and split_part(pe.email, '@', 2) = $4 and split_part(pe.email, '@', 3) = ''
), candidates as materialized (
  select e.id, e.session_id,
         row_number() over (
           partition by e.session_id, e.normalizer_version,
             coalesce(e.canonical_scope_key, 'event:' || e.id::text),
             coalesce(e.logical_event_key, 'event:' || e.id::text), e.event_kind
           order by e.source_priority desc, e.occurred_at, e.id
         ) canonical_rank
    from telemetry.sessions s
    join roster r on r.person_id = s.person_id
    join telemetry.events e
      on e.workspace_id = s.workspace_id and e.session_id = s.id
    join telemetry.native_records nr
      on nr.workspace_id = e.workspace_id and nr.id = e.source_record_id
    join telemetry.ingest_batches ib
      on ib.workspace_id = nr.workspace_id and ib.id = nr.batch_id
    left join analytics.normalizer_cutovers c
      on c.workspace_id = s.workspace_id
     and c.source_provider = ib.source_provider
     and c.to_normalizer_version = '${FRAME_CODEX_VERSION}'
   where s.workspace_id = $1 and e.event_kind = 'usage' and not e.is_replay
     and e.occurred_at >= $2 and e.occurred_at < $3
     and e.normalizer_version = any($5::text[])
     and ${activeNormalizerPredicate("e", "s", "ib", "c")}
     and ${canonicalWinnerPredicate("e", "s")}
)
select count(distinct session_id)::bigint observed_sessions,
       count(*)::bigint observed_usage_events
  from candidates where canonical_rank = 1
`;

export function createSherlockQuerySource(source) {
  if (typeof source?.transaction !== "function" || typeof source?.readiness !== "function") {
    throw new TypeError("A direct Sherlock source is required");
  }
  const receiptParams = () => [
    source.workspaceId,
    source.expectedEmailDomain,
    PROVIDER_VERSIONS,
    source.maxPeople,
  ];
  return Object.freeze({
    async fetchDiagnostics({ signal } = {}) {
      const readiness = await source.readiness({ signal });
      if (readiness.status !== "ok") return readiness;
      const freshness = await source.fetchFreshness({ signal });
      return {
        status: "ok",
        mode: readiness.mode,
        readAt: freshness.read,
        rawWatermark: freshness.rawWatermark,
        canonicalWatermark: freshness.canonicalWatermark,
        oldestPendingNormalization: freshness.oldestPendingNormalize,
        pendingNormalizationJobs: freshness.pendingNormalize,
      };
    },

    async fetchUsage({ start, end, groupBy = "person_model", signal, now } = {}) {
      const window = queryWindow({ start, end }, now);
      return await source.transaction(async (tx) => {
        await ensureRosterBound(tx, source, signal);
        const receiptRows = await runQuery(
          tx, FRESHNESS_RECEIPT_SQL, receiptParams(), signal,
        );
        const rows = await runQuery(tx, QUERY_USAGE_SQL, [
          source.workspaceId,
          window.startAt.toISOString(),
          window.endAt.toISOString(),
          source.expectedEmailDomain,
        ], signal);
        return buildUsageResult(rows, receiptRows[0], { groupBy, ...window });
      }, { signal, statementTimeoutMs: 20_000 });
    },

    async fetchSessions({
      start, end, personId, model, cursor, limit, signal, now,
    } = {}) {
      const cursorPayload = parseSessionCursor(cursor);
      const requestNow = asDate(now ?? new Date());
      if (cursorPayload?.readAt > requestNow) {
        throw new FlameSourceError("flame_mcp_query_cursor_invalid");
      }
      let window = queryWindow({ start, end }, cursorPayload?.readAt ?? requestNow);
      if (personId !== undefined && !UUID_PATTERN.test(personId)) {
        throw new FlameSourceError("flame_mcp_query_request_invalid");
      }
      const pageSize = parseLimit(limit);
      let fingerprint = sessionFingerprint({
        workspaceId: source.workspaceId,
        ...window,
        personId,
        model,
      });
      // Cursors created before the all-history default used a trailing 24-hour
      // window. Let those in-flight pages finish without restoring that legacy
      // limit for new requests.
      if (cursorPayload && cursorPayload.fingerprint !== fingerprint && start === undefined) {
        const legacyEndAt = end === undefined ? cursorPayload.readAt : asDate(end);
        const legacyStartAt = new Date(legacyEndAt.getTime() - LEGACY_QUERY_WINDOW_MS);
        const legacyWindow = queryWindow({
          start: legacyStartAt,
          end: legacyEndAt,
        }, cursorPayload.readAt);
        const legacyFingerprint = sessionFingerprint({
          workspaceId: source.workspaceId,
          ...legacyWindow,
          personId,
          model,
        });
        if (cursorPayload.fingerprint === legacyFingerprint) {
          window = legacyWindow;
          fingerprint = legacyFingerprint;
        }
      }
      const decoded = decodeSessionCursor(cursor, fingerprint);
      const readAt = decoded?.readAt ?? window.readAt;
      const rows = await source.transaction(async (tx) => await runQuery(tx, LIST_SESSIONS_SQL, [
        source.workspaceId,
        window.startAt.toISOString(),
        window.endAt.toISOString(),
        readAt.toISOString(),
        source.expectedEmailDomain,
        personId ?? null,
        model ?? null,
        decoded?.createdAt.toISOString() ?? null,
        decoded?.sessionId ?? null,
        pageSize + 1,
        PROVIDER_VERSIONS,
      ], signal), { signal });
      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;
      return {
        schemaVersion: MCP_QUERY_SCHEMA_VERSION,
        window: {
          startInclusive: window.startAt.toISOString(),
          endExclusive: window.endAt.toISOString(),
          readAt: readAt.toISOString(),
        },
        sessions: page.map(sessionFromRow),
        nextCursor: hasMore ? encodeSessionCursor({
          readAt,
          createdAt: page.at(-1).created_at,
          sessionId: String(page.at(-1).session_id),
          fingerprint,
        }) : null,
      };
    },

    async fetchSession({ sessionId, signal } = {}) {
      if (!UUID_PATTERN.test(sessionId)) {
        throw new FlameSourceError("flame_mcp_query_request_invalid");
      }
      const rows = await source.transaction(async (tx) => await runQuery(tx, GET_SESSION_SQL, [
        source.workspaceId,
        sessionId,
        source.expectedEmailDomain,
        PROVIDER_VERSIONS,
      ], signal), { signal });
      if (rows.length !== 1) throw new FlameSourceError("flame_mcp_query_not_found");
      return {
        schemaVersion: MCP_QUERY_SCHEMA_VERSION,
        session: sessionFromRow(rows[0]),
        observedEventCounts: {
          messages: safeCount(rows[0].messages),
          toolCalls: safeCount(rows[0].tool_calls),
          usage: safeCount(rows[0].usage_events),
        },
        coverage: {
          state: "partial",
          basis: "observed_events",
          reasons: ["content_omitted", "collector_presence_not_proven"],
        },
      };
    },

    async fetchCoverage({ start, end, signal, now } = {}) {
      const window = queryWindow({ start, end }, now);
      return await source.transaction(async (tx) => {
        await ensureRosterBound(tx, source, signal);
        const receiptRows = await runQuery(
          tx, FRESHNESS_RECEIPT_SQL, receiptParams(), signal,
        );
        const counts = await runQuery(tx, COVERAGE_SQL, [
          source.workspaceId,
          window.startAt.toISOString(),
          window.endAt.toISOString(),
          source.expectedEmailDomain,
          PROVIDER_VERSIONS,
        ], signal);
        const observedSessions = safeCount(counts[0]?.observed_sessions);
        const observedUsageEvents = safeCount(counts[0]?.observed_usage_events);
        const coverage = coverageReceipt(receiptRows[0], {
          observedUsageEvents,
          streams: 0,
          missingBaselines: 0,
          regressions: 0,
          missingTokenComponents: [],
          arithmeticAssessed: false,
        });
        return {
          schemaVersion: MCP_QUERY_SCHEMA_VERSION,
          window: {
            startInclusive: window.startAt.toISOString(),
            endExclusive: window.endAt.toISOString(),
            readAt: window.readAt.toISOString(),
          },
          observedSessions,
          observedUsageEvents,
          state: coverage.state,
          basis: "observed_usage_events",
          reasons: coverage.reasons,
          pendingNormalizationJobs: coverage.pendingNormalizationJobs,
          rawWatermark: coverage.rawWatermark,
          canonicalWatermark: coverage.canonicalWatermark,
        };
      }, { signal });
    },
  });
}
