import postgres from "postgres";

export const BUCKET_COUNT = 144;
export const BUCKET_MS = 10 * 60 * 1000;
export const NORMALIZER_VERSION = "sherlock.codex-rollout.v1";
export const DATABASE_ROLE = "sherlock_normalizer";
const SNAPSHOT_TOKEN_VERSION = "v1";
const MAX_SNAPSHOT_TOKEN_LENGTH = 8_192;
const PG_SNAPSHOT_PATTERN = /^\d+:\d+:(?:\d+(?:,\d+)*)?$/;
export const UNKEYED_PROMPT_MATCH_SECONDS = 2;

function nativeItemTimestamp(column) {
  return `case
    when ${column} ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then to_timestamp((
      ('x' || replace(substring(${column} from '[0-9a-f]{8}-[0-9a-f]{4}'), '-', ''))::bit(48)::bigint
    ) / 1000.0)
    else null
  end`;
}

export const PEOPLE_SQL = `
select id::text as person_id,
       coalesce(nullif(btrim(display_name), ''), identity_key) as display_name
  from telemetry.people
 where workspace_id = $1
   and github_id is distinct from 'sherlock-smoke'
 order by lower(coalesce(nullif(btrim(display_name), ''), identity_key)), id
 limit $2
`;

function promptsCte(contentColumns = "", visibilityPredicate = "") {
  return `
prompt_candidates as materialized (
  select s.person_id, e.id, e.session_id, e.canonical_scope_key,
         e.logical_event_key, e.normalizer_version, e.event_kind,
         e.event_subtype, e.source_priority,
         e.native_item_id, e.content_sha256${contentColumns},
         e.occurred_at source_occurred_at,
         coalesce(e.occurred_at, e.observed_at, e.server_received_at) source_observed_at,
         case when e.canonical_scope_key is not null and e.logical_event_key is not null
              then max(e.native_item_id) filter (
                where e.event_subtype = 'message' and e.native_item_id is not null
              ) over (
                partition by e.session_id, e.canonical_scope_key,
                             e.normalizer_version, e.logical_event_key, e.event_kind
              )
              else null end keyed_native_item_id,
         case when e.canonical_scope_key is not null and e.logical_event_key is not null
              then bool_or(e.event_subtype = 'user_message') over (
                partition by e.session_id, e.canonical_scope_key,
                             e.normalizer_version, e.logical_event_key, e.event_kind
              )
              else null end keyed_submitted
    from telemetry.events e
    join telemetry.sessions s
      on s.workspace_id = e.workspace_id and s.id = e.session_id
    join telemetry.people pe
      on pe.workspace_id = s.workspace_id and pe.id = s.person_id
    cross join p
   where e.workspace_id = p.workspace_id
     and e.normalizer_version = p.normalizer_version
     and e.event_kind = 'message'
     and e.message_origin = 'human' and e.message_role = 'user'
     and e.content_sha256 is not null and e.content_byte_size > 0
     and e.error_code is null and not e.is_replay and e.actor_role = 'primary'
     and pe.github_id is distinct from 'sherlock-smoke'
     ${visibilityPredicate}
     and (
       coalesce(e.occurred_at, e.observed_at, e.server_received_at)
         >= p.start_at - interval '${UNKEYED_PROMPT_MATCH_SECONDS} seconds'
       and coalesce(e.occurred_at, e.observed_at, e.server_received_at)
         < p.end_at + interval '${UNKEYED_PROMPT_MATCH_SECONDS} seconds'
       or ${nativeItemTimestamp("e.native_item_id")}
         >= p.start_at - interval '${UNKEYED_PROMPT_MATCH_SECONDS} seconds'
       and ${nativeItemTimestamp("e.native_item_id")}
         < p.end_at + interval '${UNKEYED_PROMPT_MATCH_SECONDS} seconds'
     )
), canonical_prompt_candidates as materialized (
  select ranked.*
    from (
      select prompt_candidates.*,
             case when canonical_scope_key is not null and logical_event_key is not null
                  then row_number() over (
                    partition by session_id, canonical_scope_key,
                                 normalizer_version, logical_event_key, event_kind
                    order by source_priority desc, source_occurred_at asc nulls last, id
                  )
                  else 1 end semantic_rank
        from prompt_candidates
    ) ranked
   where semantic_rank = 1
), keyed_prompt_sources as materialized (
  select canonical_prompt_candidates.*,
         'logical:' || canonical_scope_key || ':' || normalizer_version || ':' ||
           logical_event_key || ':' || event_kind prompt_identity,
         keyed_submitted has_submitted,
         coalesce(
           ${nativeItemTimestamp("keyed_native_item_id")},
           source_observed_at
         ) observed_at
    from canonical_prompt_candidates
   where canonical_scope_key is not null and logical_event_key is not null
), unkeyed_native_candidates as materialized (
  select ranked.*
    from (
      select canonical_prompt_candidates.*,
             coalesce(
               ${nativeItemTimestamp("native_item_id")},
               source_observed_at
             ) native_observed_at,
             row_number() over (
               partition by session_id, native_item_id
               order by source_priority desc, source_observed_at asc nulls last, id
             ) native_rank
        from canonical_prompt_candidates
       where (canonical_scope_key is null or logical_event_key is null)
         and event_subtype = 'message'
         and native_item_id is not null
    ) ranked
   where native_rank = 1
), unkeyed_submitted_prompts as materialized (
  select canonical_prompt_candidates.*
    from canonical_prompt_candidates
   where (canonical_scope_key is null or logical_event_key is null)
     and event_subtype = 'user_message'
), unkeyed_prompt_pairs as materialized (
  select submitted.id submitted_id,
         native.native_item_id matched_native_item_id,
         native.native_observed_at matched_native_observed_at
    from unkeyed_submitted_prompts submitted
    cross join lateral (
      select candidate.native_item_id, candidate.native_observed_at
        from unkeyed_native_candidates candidate
       where candidate.session_id = submitted.session_id
         and candidate.content_sha256 = submitted.content_sha256
         and candidate.native_observed_at
           >= submitted.source_observed_at - interval '${UNKEYED_PROMPT_MATCH_SECONDS} seconds'
         and candidate.native_observed_at
           <= submitted.source_observed_at + interval '${UNKEYED_PROMPT_MATCH_SECONDS} seconds'
       order by abs(extract(epoch from (
                  candidate.native_observed_at - submitted.source_observed_at
                ))),
                case when candidate.native_observed_at >= submitted.source_observed_at
                     then 0 else 1 end,
                candidate.native_observed_at, candidate.native_item_id, candidate.id
       limit 1
    ) native
), unkeyed_prompt_sources as materialized (
  select submitted.*,
         coalesce(
           'native:' || submitted.native_item_id,
           'native:' || paired.matched_native_item_id,
           'event:' || submitted.id::text
         ) prompt_identity,
         true has_submitted,
         coalesce(
           ${nativeItemTimestamp("submitted.native_item_id")},
           paired.matched_native_observed_at,
           submitted.source_observed_at
         ) observed_at
    from unkeyed_submitted_prompts submitted
    left join unkeyed_prompt_pairs paired on paired.submitted_id = submitted.id
), prompt_identities as materialized (
  select * from keyed_prompt_sources
  union all
  select * from unkeyed_prompt_sources
), prompts as materialized (
  select ranked.*
    from (
      select prompt_identities.*,
             row_number() over (
               partition by session_id, prompt_identity
               order by observed_at asc, source_observed_at asc, id
             ) canonical_rank
        from prompt_identities
    ) ranked
   where canonical_rank = 1
     and has_submitted
     and observed_at >= (select start_at from p)
     and observed_at < (select end_at from p)
 )`;
}

export const FLAME_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::timestamptz start_at,
         $3::timestamptz end_at, $4::text normalizer_version
), roster as materialized (
  select pe.id person_id,
         coalesce(nullif(btrim(pe.display_name), ''), pe.identity_key) display_name
   from telemetry.people pe cross join p
   where pe.workspace_id = p.workspace_id
     and pe.github_id is distinct from 'sherlock-smoke'
), buckets as materialized (
  select generate_series(p.start_at, p.end_at - interval '10 minutes',
                         interval '10 minutes') bucket_start
    from p
), activity_candidates as materialized (
  select s.person_id, e.id, e.session_id, e.actor_role, e.event_kind, e.event_subtype,
         coalesce(
           ${nativeItemTimestamp("e.native_item_id")},
           coalesce(e.occurred_at, e.observed_at, e.server_received_at)
         ) observed_at,
         case when e.canonical_scope_key is not null and e.logical_event_key is not null
              then row_number() over (
                partition by e.session_id, e.canonical_scope_key,
                             e.logical_event_key, e.event_kind
                order by e.source_priority desc, e.occurred_at asc nulls last, e.id
              )
              else 1 end canonical_rank
    from telemetry.events e
    join telemetry.sessions s
      on s.workspace_id = e.workspace_id and s.id = e.session_id
    join roster r on r.person_id = s.person_id
    cross join p
   where e.workspace_id = p.workspace_id
     and e.normalizer_version = p.normalizer_version
     and not e.is_replay
     and e.actor_role <> 'automation'
     and e.event_kind in (
       'message', 'reasoning', 'tool_call', 'tool_result', 'agent_spawn',
       'agent_message', 'lifecycle', 'error'
     )
     and (
       e.event_kind <> 'message'
       or e.native_item_id is not null
       or e.event_subtype = 'user_message'
     )
     and (
       e.event_kind <> 'lifecycle'
       or e.event_subtype in ('task_started', 'task_complete', 'turn_started', 'turn_complete')
     )
     and coalesce(
       ${nativeItemTimestamp("e.native_item_id")},
       coalesce(e.occurred_at, e.observed_at, e.server_received_at)
     ) >= p.start_at
     and coalesce(
       ${nativeItemTimestamp("e.native_item_id")},
       coalesce(e.occurred_at, e.observed_at, e.server_received_at)
     ) < p.end_at
), activity_events as materialized (
  select person_id, session_id, actor_role, observed_at
    from activity_candidates
   where canonical_rank = 1
), bucket_activity as materialized (
  select a.person_id,
         date_bin(interval '10 minutes', a.observed_at, p.start_at) bucket_start,
         count(distinct a.session_id) filter (where a.actor_role = 'primary')::bigint agent,
         count(distinct a.session_id) filter (where a.actor_role in ('worker', 'guardian'))::bigint subagent,
         count(distinct a.session_id) filter (where a.actor_role = 'unknown')::bigint other
    from activity_events a cross join p
   group by a.person_id, bucket_start
), day_activity as materialized (
  select r.person_id,
         count(distinct a.session_id) filter (where a.actor_role = 'primary')::bigint day_agent,
         count(distinct a.session_id) filter (where a.actor_role in ('worker', 'guardian'))::bigint day_subagent,
         count(distinct a.session_id) filter (where a.actor_role = 'unknown')::bigint day_other
    from roster r left join activity_events a using (person_id)
   group by r.person_id
), ${promptsCte()}, prompt_counts as materialized (
  select prompts.person_id,
         date_bin(interval '10 minutes', prompts.observed_at, p.start_at) bucket_start,
         count(*)::bigint prompts
    from prompts cross join p
   group by prompts.person_id, bucket_start
), latest_observation as materialized (
  select greatest(
           (select max(observed_at) from activity_events),
           (select max(observed_at) from prompts)
         ) latest
)
select r.person_id::text person_id, r.display_name, b.bucket_start,
       coalesce(ba.agent, 0)::bigint agent,
       coalesce(ba.subagent, 0)::bigint subagent,
       coalesce(ba.other, 0)::bigint other,
       coalesce(pc.prompts, 0)::bigint prompts,
       d.day_agent, d.day_subagent, d.day_other, l.latest
  from roster r cross join buckets b
  join day_activity d using (person_id)
  cross join latest_observation l
  left join bucket_activity ba
    on ba.person_id = r.person_id and ba.bucket_start = b.bucket_start
  left join prompt_counts pc
    on pc.person_id = r.person_id and pc.bucket_start = b.bucket_start
 order by lower(r.display_name), r.person_id, b.bucket_start
`;

export const PROMPT_DETAIL_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::timestamptz start_at,
         $3::timestamptz end_at, $4::text normalizer_version,
         $5::pg_snapshot snapshot
), ${promptsCte(
  ", e.content_byte_size, e.content_excerpt",
  // Recreate the aggregate's event visibility without keeping its transaction open.
  // telemetry.events is append-only, so filtering each row's creator is sufficient.
  "and pg_visible_in_snapshot(e.xmin::text::xid8, p.snapshot)",
)}
select id::text id, observed_at,
       coalesce(content_excerpt, '') content,
       coalesce(content_byte_size, 0)::bigint content_byte_size,
       octet_length(coalesce(content_excerpt, ''))::bigint excerpt_byte_size
  from prompts
 where person_id = $6::uuid
 order by observed_at, id
 limit $7
`;

export class FlameSourceError extends Error {
  constructor(code) {
    super(code);
    this.name = "FlameSourceError";
    this.code = code;
  }
}

function asDate(value) {
  const result = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(result.getTime())) {
    throw new FlameSourceError("flame_database_result_invalid");
  }
  return result;
}

function count(value) {
  if (typeof value === "boolean") {
    throw new FlameSourceError("flame_database_result_invalid");
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new FlameSourceError("flame_database_result_invalid");
  }
  return result;
}

function parsePgSnapshot(value) {
  if (typeof value !== "string" || value.length > MAX_SNAPSHOT_TOKEN_LENGTH ||
      !PG_SNAPSHOT_PATTERN.test(value)) {
    throw new FlameSourceError("flame_snapshot_invalid");
  }
  const [xminValue, xmaxValue, xipValue] = value.split(":");
  const xmin = BigInt(xminValue);
  const xmax = BigInt(xmaxValue);
  const xips = xipValue ? xipValue.split(",").map((item) => BigInt(item)) : [];
  if (xmin > xmax || xips.some((xid) => xid < xmin || xid >= xmax)) {
    throw new FlameSourceError("flame_snapshot_invalid");
  }
  return value;
}

export function encodeSnapshotToken({ snapshot, read }) {
  const readAt = asDate(read).toISOString();
  const pgSnapshot = parsePgSnapshot(snapshot);
  const body = Buffer.from(JSON.stringify([pgSnapshot, readAt]), "utf8").toString("base64url");
  const token = `${SNAPSHOT_TOKEN_VERSION}.${body}`;
  if (token.length > MAX_SNAPSHOT_TOKEN_LENGTH) {
    throw new FlameSourceError("flame_snapshot_too_large");
  }
  return token;
}

export function decodeSnapshotToken(token) {
  if (typeof token !== "string" || token.length > MAX_SNAPSHOT_TOKEN_LENGTH) {
    throw new FlameSourceError("flame_prompt_request_invalid");
  }
  const [version, body, extra] = token.split(".");
  if (version !== SNAPSHOT_TOKEN_VERSION || !body || extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/.test(body)) {
    throw new FlameSourceError("flame_prompt_request_invalid");
  }
  try {
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== body) {
      throw new Error("noncanonical_token");
    }
    const value = JSON.parse(decoded);
    if (!Array.isArray(value) || value.length !== 2) throw new Error("invalid_payload");
    const [snapshot, rawRead] = value;
    const read = asDate(rawRead);
    if (read.toISOString() !== rawRead) throw new Error("noncanonical_read");
    return { snapshot: parsePgSnapshot(snapshot), read };
  } catch {
    throw new FlameSourceError("flame_prompt_request_invalid");
  }
}

export function buildFlamePayload({ rows, roster, start, read, snapshot }) {
  if (roster.length === 0) throw new FlameSourceError("flame_database_roster_empty");
  if (rows.length !== roster.length * BUCKET_COUNT) {
    throw new FlameSourceError("flame_database_result_incomplete");
  }

  const startMs = asDate(start).getTime();
  const byPerson = new Map(roster.map((person) => [String(person.person_id), []]));
  for (const row of rows) {
    const personRows = byPerson.get(String(row.person_id));
    if (!personRows) throw new FlameSourceError("flame_database_result_invalid");
    personRows.push(row);
  }

  let latest = null;
  const people = roster.map((person) => {
    const personRows = byPerson.get(String(person.person_id));
    personRows.sort((left, right) => asDate(left.bucket_start) - asDate(right.bucket_start));
    for (let index = 0; index < BUCKET_COUNT; index += 1) {
      if (asDate(personRows[index].bucket_start).getTime() !== startMs + index * BUCKET_MS) {
        throw new FlameSourceError("flame_database_result_incomplete");
      }
    }
    const first = personRows[0];
    const total = [count(first.day_agent), count(first.day_subagent), count(first.day_other)];
    const buckets = personRows.map((row) => [
      count(row.agent), count(row.subagent), count(row.other), count(row.prompts),
    ]);
    if (buckets.some((bucket) =>
      bucket.slice(0, 3).some((value, index) => value > total[index])
    )) {
      throw new FlameSourceError("flame_database_result_invalid");
    }
    if (first.latest !== null && first.latest !== undefined) {
      const observed = asDate(first.latest);
      latest = latest === null || observed > latest ? observed : latest;
    }
    return {
      id: String(person.person_id),
      name: String(person.display_name).slice(0, 160),
      total,
      buckets,
    };
  });

  return {
    start: asDate(start).toISOString(),
    read: asDate(read).toISOString(),
    snapshot: encodeSnapshotToken({ snapshot, read }),
    latest: latest?.toISOString() ?? null,
    coverage: {
      evidence: "observed_events",
      state: "partial",
      reason: "event_presence_not_continuous_attention",
    },
    people,
  };
}

export class DirectFlameSource {
  constructor({ databaseUrl, workspaceId, maxPeople = 500 }) {
    this.workspaceId = workspaceId;
    this.maxPeople = maxPeople;
    this.sql = postgres(databaseUrl, {
      prepare: false,
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  async close() {
    await this.sql.end({ timeout: 5 });
  }

  async transaction(callback) {
    try {
      return await this.sql.begin(async (tx) => {
        await tx.unsafe("set transaction isolation level repeatable read, read only");
        await tx.unsafe("select set_config('statement_timeout', '20000', true)");
        await tx.unsafe(`set local role ${DATABASE_ROLE}`);
        return await callback(tx);
      });
    } catch (error) {
      if (error instanceof FlameSourceError) throw error;
      throw new FlameSourceError("flame_database_unavailable");
    }
  }

  async readiness() {
    try {
      return await this.transaction(async (tx) => {
        const rows = await tx.unsafe(`
          select current_role = 'sherlock_normalizer' as backend_role,
                 current_setting('transaction_read_only') = 'on' as read_only,
                 has_table_privilege(current_role, 'telemetry.people', 'select') as can_read_people,
                 has_table_privilege(current_role, 'telemetry.events', 'select') as can_read_events
            from pg_roles where rolname = current_role
        `);
        if (!rows[0] || Object.values(rows[0]).some((value) => value !== true)) {
          throw new FlameSourceError("flame_database_reader_unsafe");
        }
        return { status: "ok", mode: "sherlock_backend_aggregate" };
      });
    } catch (error) {
      const code = error instanceof FlameSourceError
        ? error.code
        : "flame_database_unavailable";
      return { status: "unavailable", reason: code };
    }
  }

  async fetchDay({ now } = {}) {
    return await this.transaction(async (tx) => {
      const receipt = (await tx.unsafe(
        "select transaction_timestamp() as now, pg_current_snapshot()::text as snapshot",
      ))[0];
      const read = now ? asDate(now) : asDate(receipt.now);
      const endMs = Math.floor(read.getTime() / BUCKET_MS) * BUCKET_MS;
      const start = new Date(endMs - 24 * 60 * 60 * 1000);
      const end = new Date(endMs);
      const roster = await tx.unsafe(
        PEOPLE_SQL,
        [this.workspaceId, this.maxPeople + 1],
      );
      if (roster.length > this.maxPeople) {
        throw new FlameSourceError("flame_database_roster_too_large");
      }
      const rows = await tx.unsafe(FLAME_SQL, [
        this.workspaceId,
        start.toISOString(),
        end.toISOString(),
        NORMALIZER_VERSION,
      ]);
      return buildFlamePayload({ rows, roster, start, read, snapshot: receipt.snapshot });
    });
  }

  async fetchPrompts({ personId, start, snapshot }) {
    const startAt = asDate(start);
    const snapshotReceipt = decodeSnapshotToken(snapshot);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(personId)) {
      throw new FlameSourceError("flame_prompt_request_invalid");
    }
    if (startAt.getTime() % BUCKET_MS !== 0) {
      throw new FlameSourceError("flame_prompt_request_invalid");
    }

    return await this.transaction(async (tx) => {
      const read = asDate((await tx.unsafe("select transaction_timestamp() as now"))[0].now);
      const oldest = read.getTime() - 25 * 60 * 60 * 1000;
      const snapshotEndMs = Math.floor(snapshotReceipt.read.getTime() / BUCKET_MS) * BUCKET_MS;
      const snapshotStartMs = snapshotEndMs - 24 * 60 * 60 * 1000;
      if (snapshotReceipt.read.getTime() < oldest ||
          startAt.getTime() < snapshotStartMs || startAt.getTime() >= snapshotEndMs) {
        throw new FlameSourceError("flame_prompt_request_out_of_range");
      }
      const endAt = new Date(startAt.getTime() + BUCKET_MS);
      const limit = 501;
      const rows = await tx.unsafe(PROMPT_DETAIL_SQL, [
        this.workspaceId,
        startAt.toISOString(),
        endAt.toISOString(),
        NORMALIZER_VERSION,
        snapshotReceipt.snapshot,
        personId,
        limit,
      ]);
      if (rows.length === limit) {
        throw new FlameSourceError("flame_prompt_result_too_large");
      }
      return {
        personId,
        start: startAt.toISOString(),
        snapshot,
        prompts: rows.map((row) => ({
          id: String(row.id),
          at: asDate(row.observed_at).toISOString(),
          content: String(row.content),
          truncated: count(row.content_byte_size) > count(row.excerpt_byte_size),
        })),
      };
    });
  }
}
