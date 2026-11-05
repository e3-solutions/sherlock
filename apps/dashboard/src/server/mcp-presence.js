import { FlameSourceError } from "./flame-source.js";
import { USAGE_CONTRIBUTION_STATE_SQL, runQuery } from "./mcp-query-source.js";

export const PRESENCE_SCHEMA_VERSION = "sherlock.presence.v1";
export const PRESENCE_ACTIVE_MINUTES = 15;
export const PRESENCE_MAX_HOURS = 720;
const PRESENCE_PERSON_DEFAULT_HOURS = PRESENCE_MAX_HOURS;
const PRESENCE_STATEMENT_TIMEOUT_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// COR-5178: who is coding, from model activity (usage events) on top-level
// sessions: no parent, not a reviewer (guardian) or automation run. Runs as
// sherlock_reader, so row security hides restricted people and owner-excluded
// sessions exactly as it does for every other tool. Ids, names, agents and
// times only.
const PRESENCE_GROUPS_SQL = `, top_level as materialized (
  select a.session_id, a.last_activity_at, a.agent, s.person_id
    from activity a
    join telemetry.sessions s on s.workspace_id = $1 and s.id = a.session_id
   where s.parent_session_id is null and s.parent_native_session_id is null
     and s.actor_role not in ('guardian', 'automation')
     and ($5::uuid is null or s.person_id = $5::uuid)
)
select t.person_id::text person_id,
       coalesce(nullif(btrim(pe.display_name), ''), 'Unknown') display_name,
       count(*)::bigint sessions,
       (count(*) filter (where t.last_activity_at >= $6::timestamptz))::bigint active_sessions,
       max(t.last_activity_at) last_activity_at,
       array_remove(array_agg(distinct t.agent), null) agents
  from top_level t
  join telemetry.people pe on pe.workspace_id = $1 and pe.id = t.person_id
 where pe.github_id is distinct from 'sherlock-smoke'
   and split_part(pe.email, '@', 2) = $4 and split_part(pe.email, '@', 3) = ''
 group by t.person_id, pe.display_name
 order by max(t.last_activity_at) desc, t.person_id
 limit 200
`;

// Exact and fresh; used for "now" (a 15-minute window) and as the fallback.
export const PRESENCE_EVENTS_SQL = `
with activity as materialized (
  select e.session_id, max(e.occurred_at) last_activity_at,
         max(case
               when e.normalizer_version like 'sherlock.claude-code-transcript.%' then 'claude'
               when e.normalizer_version like 'sherlock.codex-rollout.%' then 'codex'
             end) agent
    from telemetry.events e
   where e.workspace_id = $1 and e.event_kind = 'usage' and not e.is_replay
     and e.occurred_at >= $2::timestamptz and e.occurred_at <= $3::timestamptz
   group by e.session_id
)${PRESENCE_GROUPS_SQL}`;

// Hours-long windows read the precomputed per-event usage table (COR-5162),
// current to within about 3 minutes, instead of every raw usage event.
export const PRESENCE_CONTRIBUTIONS_SQL = `
with activity as materialized (
  select u.session_id, max(u.usage_at) last_activity_at, min(u.provider) agent
    from analytics.usage_contributions u
   where u.workspace_id = $1
     and u.usage_at >= $2::timestamptz and u.usage_at <= $3::timestamptz
   group by u.session_id
)${PRESENCE_GROUPS_SQL}`;

function iso(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function count(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function createPresenceSource(source, { resolvePerson } = {}) {
  if (typeof source?.transaction !== "function" || typeof source.workspaceId !== "string") {
    throw new TypeError("A direct Sherlock source is required");
  }

  async function personId(person, signal) {
    if (UUID_PATTERN.test(person)) return { personId: person.toLowerCase() };
    if (typeof resolvePerson !== "function") throw new FlameSourceError("flame_mcp_query_request_invalid");
    const resolved = await resolvePerson({ name: person, limit: 5, signal });
    if (resolved.matches.length === 1 && !resolved.ambiguous) return { personId: resolved.matches[0].personId };
    return { unresolved: { matches: resolved.matches, ambiguous: resolved.ambiguous === true } };
  }

  return Object.freeze({
    async fetchPresence({ person, hours, signal, now } = {}) {
      const readAt = new Date(now ?? Date.now());
      if (hours !== undefined && (!Number.isInteger(hours) || hours < 1 || hours > PRESENCE_MAX_HOURS)) {
        throw new FlameSourceError("flame_mcp_query_request_invalid");
      }
      const activeSince = new Date(readAt.getTime() - PRESENCE_ACTIVE_MINUTES * 60_000);
      const target = person === undefined ? null : await personId(person, signal);
      if (target?.unresolved) {
        return {
          schemaVersion: PRESENCE_SCHEMA_VERSION, readAt: readAt.toISOString(),
          mode: "person", found: false, ambiguous: target.unresolved.ambiguous,
          matches: target.unresolved.matches.map(({ personId: id, displayName }) => ({
            personId: id, displayName,
          })),
          people: [],
        };
      }
      const windowHours = hours ?? (target ? PRESENCE_PERSON_DEFAULT_HOURS : null);
      const since = windowHours === null
        ? activeSince
        : new Date(readAt.getTime() - windowHours * 3_600_000);
      const params = [
        source.workspaceId, since.toISOString(), readAt.toISOString(), source.expectedEmailDomain,
        target?.personId ?? null, activeSince.toISOString(),
      ];
      const rows = await source.transaction(async (tx) => {
        const precomputed = windowHours !== null && (await runQuery(tx, USAGE_CONTRIBUTION_STATE_SQL, [
          source.workspaceId, since.toISOString(),
        ], signal)).length > 0;
        return await runQuery(tx, precomputed ? PRESENCE_CONTRIBUTIONS_SQL : PRESENCE_EVENTS_SQL, params, signal);
      }, { signal, statementTimeoutMs: PRESENCE_STATEMENT_TIMEOUT_MS });
      const people = rows.map((row) => ({
        personId: String(row.person_id),
        displayName: String(row.display_name).slice(0, 160),
        active: count(row.active_sessions) > 0,
        activeSessions: count(row.active_sessions),
        sessions: count(row.sessions),
        lastActivityAt: iso(row.last_activity_at),
        agents: (row.agents ?? []).map(String).filter((agent) => agent === "codex" || agent === "claude").sort(),
      }));
      return {
        schemaVersion: PRESENCE_SCHEMA_VERSION,
        readAt: readAt.toISOString(),
        mode: target ? "person" : windowHours === null ? "now" : "history",
        window: { startInclusive: since.toISOString(), endInclusive: readAt.toISOString() },
        activeWithinMinutes: PRESENCE_ACTIVE_MINUTES,
        ...(target ? { found: people.length > 0, personId: target.personId } : {}),
        people,
      };
    },
  });
}
