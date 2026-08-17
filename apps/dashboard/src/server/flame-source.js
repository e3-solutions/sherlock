import postgres from "postgres";

export const BUCKET_COUNT = 144;
export const BUCKET_MS = 10 * 60 * 1000;
export const ACTIVITY_VERSION = "sherlock.activity.v1";
export const NORMALIZER_VERSION = "sherlock.codex-rollout.v1";
export const DATABASE_ROLE = "sherlock_normalizer";

export const PEOPLE_SQL = `
select id::text as person_id,
       coalesce(nullif(btrim(display_name), ''), identity_key) as display_name
  from telemetry.people
 where workspace_id = $1
 order by lower(coalesce(nullif(btrim(display_name), ''), identity_key)), id
 limit $2
`;

export const FLAME_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::timestamptz start_at,
         $3::timestamptz end_at, $4::text activity_version,
         $5::text normalizer_version
), roster as materialized (
  select pe.id person_id,
         coalesce(nullif(btrim(pe.display_name), ''), pe.identity_key) display_name
    from telemetry.people pe cross join p
   where pe.workspace_id = p.workspace_id
), buckets as materialized (
  select generate_series(p.start_at, p.end_at - interval '10 minutes',
                         interval '10 minutes') bucket_start
    from p
), candidate_span_keys as materialized (
  select distinct a.span_key
    from analytics.activity_spans a cross join p
   where a.workspace_id = p.workspace_id
     and a.activity_version = p.activity_version
     and not a.is_tombstone
     and a.started_at < p.end_at and a.ended_at > p.start_at
), latest_spans as materialized (
  select latest.*
    from candidate_span_keys candidate cross join p
    cross join lateral (
      select a.session_id, a.person_id, a.span_key, a.started_at, a.ended_at,
             a.actor_role, a.created_at, a.is_tombstone
        from analytics.activity_spans a
       where a.workspace_id = p.workspace_id
         and a.activity_version = p.activity_version
         and a.span_key = candidate.span_key
       order by a.valid_from_event_id desc, a.id desc
       limit 1
    ) latest
), active_spans as materialized (
  select latest.*
    from latest_spans latest cross join p
   where not latest.is_tombstone
     and latest.started_at is not null and latest.ended_at is not null
     and latest.actor_role <> 'automation'
     and latest.started_at < p.end_at and latest.ended_at > p.start_at
), bucket_activity as materialized (
  select a.person_id, b.bucket_start,
         count(distinct a.session_id) filter (where a.actor_role = 'primary')::bigint agent,
         count(distinct a.session_id) filter (where a.actor_role in ('worker', 'guardian'))::bigint subagent,
         count(distinct a.session_id) filter (where a.actor_role = 'unknown')::bigint other
    from buckets b join active_spans a
      on a.started_at < b.bucket_start + interval '10 minutes'
     and a.ended_at > b.bucket_start
   group by a.person_id, b.bucket_start
), day_activity as materialized (
  select r.person_id,
         count(distinct a.session_id) filter (where a.actor_role = 'primary')::bigint day_agent,
         count(distinct a.session_id) filter (where a.actor_role in ('worker', 'guardian'))::bigint day_subagent,
         count(distinct a.session_id) filter (where a.actor_role = 'unknown')::bigint day_other
    from roster r left join active_spans a using (person_id)
   group by r.person_id
), prompt_candidates as materialized (
  select s.person_id, e.id, e.session_id, e.canonical_scope_key,
         e.logical_event_key, e.event_kind,
         coalesce(e.occurred_at, e.observed_at, e.server_received_at) observed_at,
         case when e.canonical_scope_key is null or e.logical_event_key is null then 1
              else row_number() over (
                partition by e.session_id, e.canonical_scope_key,
                             e.logical_event_key, e.event_kind
                order by e.source_priority desc, e.occurred_at asc nulls last, e.id
              ) end canonical_rank
    from telemetry.events e
    join telemetry.sessions s
      on s.workspace_id = e.workspace_id and s.id = e.session_id
    cross join p
   where e.workspace_id = p.workspace_id
     and e.normalizer_version = p.normalizer_version
     and e.event_kind = 'message' and e.message_origin = 'human'
     and not e.is_replay and s.actor_role <> 'automation'
     and coalesce(e.occurred_at, e.observed_at, e.server_received_at) >= p.start_at
     and coalesce(e.occurred_at, e.observed_at, e.server_received_at) < p.end_at
), prompts as materialized (
  select * from prompt_candidates where canonical_rank = 1
), prompt_counts as materialized (
  select prompts.person_id,
         date_bin(interval '10 minutes', prompts.observed_at, p.start_at) bucket_start,
         count(*)::bigint prompts
    from prompts cross join p
   group by prompts.person_id, bucket_start
), latest_observation as materialized (
  select greatest(
           (select max(ended_at) from active_spans),
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

export function buildFlamePayload({ rows, roster, start, read }) {
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
    latest: latest?.toISOString() ?? null,
    coverage: {
      evidence: "aggregate",
      state: "partial",
      reason: "workspace_snapshot_activation_unavailable",
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
                 has_table_privilege(current_role, 'telemetry.events', 'select') as can_read_events,
                 has_table_privilege(current_role, 'analytics.activity_spans', 'select') as can_read_spans
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
      const read = now
        ? asDate(now)
        : asDate((await tx.unsafe("select transaction_timestamp() as now"))[0].now);
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
        ACTIVITY_VERSION,
        NORMALIZER_VERSION,
      ]);
      return buildFlamePayload({ rows, roster, start, read });
    });
  }
}
