import postgres from "postgres";

export const BUCKET_COUNT = 144;
export const BUCKET_MS = 10 * 60 * 1000;
// Keep this immutable reader contract aligned with the worker's frame version.
// The dashboard Docker build context is apps/dashboard, so it cannot import the
// repository-level worker module at runtime.
export const FRAME_VERSION = "frame-evidence-v1";
export const NORMALIZER_VERSION = "sherlock.codex-rollout.v1";
export const CLAUDE_NORMALIZER_VERSION = "sherlock.claude-code-transcript.v1";
export const NORMALIZER_VERSIONS = Object.freeze([
  NORMALIZER_VERSION,
  CLAUDE_NORMALIZER_VERSION,
]);
export const DATABASE_ROLE = "sherlock_reader";
const DEFAULT_STATEMENT_TIMEOUT_MS = 20_000;
const TIMELINE_STATEMENT_TIMEOUT_MS = 30_000;
const LEGACY_SNAPSHOT_TOKEN_VERSION = "v1";
const PROJECTION_SNAPSHOT_TOKEN_VERSION = "v2";
const WORK_CURSOR_VERSION = "v1";
const MAX_SNAPSHOT_TOKEN_LENGTH = 8_192;
const MAX_WORK_CURSOR_LENGTH = 512;
const PG_SNAPSHOT_PATTERN = /^\d+:\d+:(?:\d+(?:,\d+)*)?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const UNKEYED_PROMPT_MATCH_SECONDS = 2;
export const UNKEYED_PROMPT_REPRESENTATION_MILLISECONDS = 100;
export const ASSISTANT_REPRESENTATION_MATCH_SECONDS = 3;
export const ACTIVITY_REPRESENTATION_NEIGHBORHOOD_SECONDS =
  ASSISTANT_REPRESENTATION_MATCH_SECONDS * 2;
export const INTERVAL_WORK_LIMIT = 200;
export const INTERVAL_PROMPT_LIMIT = 200;
export const DEFAULT_WORK_DETAIL_LIMIT = 50;
export const MAX_WORK_DETAIL_LIMIT = 100;
export const MCP_PROMPT_EVIDENCE_LIMIT = 5;
export const PREFERRED_DASHBOARD_EMAIL_DOMAIN = "e3group.ai";
export const REPLACED_DASHBOARD_EMAIL_DOMAIN = "coreedgesolution.com";

function dashboardPersonVisibility(alias) {
  return `
   and not exists (
     select 1
       from telemetry.people preferred
      where preferred.workspace_id = ${alias}.workspace_id
        and preferred.id <> ${alias}.id
        and preferred.github_id = ${alias}.github_id
        and ${alias}.github_id is not null
        and split_part(${alias}.email, '@', 2) = '${REPLACED_DASHBOARD_EMAIL_DOMAIN}'
        and split_part(preferred.email, '@', 2) = '${PREFERRED_DASHBOARD_EMAIL_DOMAIN}'
   )`;
}

function nativeItemTimestamp(column) {
  return `case
    when ${column} ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then to_timestamp((
      ('x' || replace(substring(${column} from '[0-9a-f]{8}-[0-9a-f]{4}'), '-', ''))::bit(48)::bigint
    ) / 1000.0)
    else null
  end`;
}

function activityCte({ joins = "" } = {}) {
  return `
activity_candidates as materialized (
  select s.person_id, e.id, e.session_id,
         s.started_at session_started_at,
         case when e.actor_role = 'unknown' and s.parent_session_id is not null
              then 'worker' else e.actor_role end actor_role,
         e.event_kind, e.event_subtype,
         coalesce(
           ${nativeItemTimestamp("e.native_item_id")},
           coalesce(e.occurred_at, e.observed_at, e.server_received_at)
         ) observed_at,
         case when e.canonical_scope_key is not null and e.logical_event_key is not null
              then row_number() over (
                partition by e.session_id, e.canonical_scope_key,
                             e.normalizer_version, e.logical_event_key, e.event_kind
                order by e.source_priority desc, e.occurred_at asc nulls last, e.id
              )
              else 1 end canonical_rank
    from telemetry.events e
    join telemetry.sessions s
      on s.workspace_id = e.workspace_id and s.id = e.session_id
    ${joins}
    cross join p
   where e.workspace_id = p.workspace_id
     and e.normalizer_version = any(p.normalizer_versions)
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
     ) < p.read_at
), activity_events as materialized (
  select person_id, session_id, actor_role, observed_at
    from activity_candidates
   where canonical_rank = 1
     and observed_at >= date_trunc('milliseconds', session_started_at)
)`;
}

export const PEOPLE_SQL = `
select pe.id::text as person_id,
       coalesce(nullif(btrim(pe.display_name), ''), pe.identity_key) as display_name
  from telemetry.people pe
 where pe.workspace_id = $1
   and pe.github_id is distinct from 'sherlock-smoke'
   ${dashboardPersonVisibility("pe")}
 order by lower(coalesce(nullif(btrim(pe.display_name), ''), pe.identity_key)), pe.id
 limit $2
`;

function promptsCte({
  candidatePredicate = "",
  contentColumns = "",
  visibilityPredicate = "",
} = {}) {
  return `
prompt_candidates as materialized (
  select s.person_id, e.id, e.session_id, e.canonical_scope_key,
         e.logical_event_key, e.turn_id, e.normalizer_version, e.event_kind,
         e.event_subtype, e.source_priority,
         e.native_item_id, e.content_sha256,
         nr.batch_id source_batch_id, nr.record_index source_record_index,
         nr.source_start_offset, nr.source_end_offset,
         nr.native_type source_native_type,
         nr.native_payload_type source_native_payload_type,
         ib.collector_key source_collector_key,
         ib.source_kind, ib.source_stream_key,
         ib.generation_key, ib.generation_seq${contentColumns},
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
    join telemetry.native_records nr
      on nr.workspace_id = e.workspace_id and nr.id = e.source_record_id
    join telemetry.ingest_batches ib
      on ib.workspace_id = nr.workspace_id and ib.id = nr.batch_id
    join telemetry.people pe
      on pe.workspace_id = s.workspace_id and pe.id = s.person_id
    cross join p
   where e.workspace_id = p.workspace_id
     and e.normalizer_version = any(p.normalizer_versions)
     and e.event_kind = 'message'
     and e.message_origin = 'human' and e.message_role = 'user'
     and e.content_sha256 is not null and e.content_byte_size > 0
     and e.error_code is null and not e.is_replay and e.actor_role = 'primary'
     and pe.github_id is distinct from 'sherlock-smoke'
     ${candidatePredicate}
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
         coalesce(
           'native:' || keyed_native_item_id,
           'logical:' || canonical_scope_key || ':' || normalizer_version || ':' ||
             logical_event_key || ':' || event_kind
         ) prompt_identity,
         keyed_submitted has_submitted,
         coalesce(
           ${nativeItemTimestamp("keyed_native_item_id")},
           source_observed_at
         ) observed_at
    from canonical_prompt_candidates
   where canonical_scope_key is not null and logical_event_key is not null
), native_identity_candidates as materialized (
  select prompt_candidates.*,
         source_observed_at native_source_observed_at,
         coalesce(
           ${nativeItemTimestamp("native_item_id")},
           source_observed_at
         ) native_observed_at
    from prompt_candidates
   where event_subtype = 'message'
     and native_item_id is not null
-- PostgreSQL has no row-count statistics for these materialized CTEs and otherwise
-- chooses quadratic nested loops. The materialize-then-filter full joins below keep
-- every original predicate while giving the planner bounded hash/merge paths; each
-- following CTE restores the original inner- or left-join semantics.
), prompt_representation_pairs as materialized (
  select duplicate.id suppressed_id, previous.id previous_id
    from canonical_prompt_candidates duplicate
    full join canonical_prompt_candidates previous
      on previous.session_id = duplicate.session_id
     and previous.event_kind = duplicate.event_kind
     and previous.event_subtype = duplicate.event_subtype
     and previous.content_sha256 = duplicate.content_sha256
     and previous.source_batch_id = duplicate.source_batch_id
     and previous.source_record_index = duplicate.source_record_index - 1
     and previous.source_end_offset = duplicate.source_start_offset
     and previous.canonical_scope_key is not distinct from duplicate.canonical_scope_key
     and duplicate.event_subtype = 'user_message'
     and previous.source_native_type = 'event_msg'
     and previous.source_native_payload_type = 'user_message'
     and duplicate.source_native_type = 'event_msg'
     and duplicate.source_native_payload_type = 'user_message'
     and previous.native_item_id is null
     and duplicate.native_item_id is null
     and previous.logical_event_key is null
     and duplicate.logical_event_key is null
     and previous.turn_id is null
     and duplicate.turn_id is null
     and abs(extract(epoch from (
           duplicate.source_observed_at - previous.source_observed_at
         ))) <= ${UNKEYED_PROMPT_REPRESENTATION_MILLISECONDS} / 1000.0
), prompt_representation_suppressed as materialized (
  select distinct suppressed_id
    from prompt_representation_pairs
   where suppressed_id is not null and previous_id is not null
), unkeyed_submitted_prompts as materialized (
  select canonical_prompt_candidates.*
    from canonical_prompt_candidates
    left join prompt_representation_suppressed
      on prompt_representation_suppressed.suppressed_id = canonical_prompt_candidates.id
   where (canonical_scope_key is null or logical_event_key is null)
     and event_subtype = 'user_message'
     and prompt_representation_suppressed.suppressed_id is null
), unkeyed_prompt_pair_rows as materialized (
  select submitted.id submitted_id, native.id native_event_id,
         native.native_item_id matched_native_item_id,
         native.native_observed_at matched_native_observed_at
    from unkeyed_submitted_prompts submitted
    full join native_identity_candidates native
      on native.session_id = submitted.session_id
     and native.content_sha256 = submitted.content_sha256
     and native.source_collector_key = submitted.source_collector_key
     and native.source_kind = submitted.source_kind
     and native.source_stream_key = submitted.source_stream_key
     and native.generation_key = submitted.generation_key
     and native.generation_seq = submitted.generation_seq
     and submitted.logical_event_key is null
     and submitted.turn_id is null
     and native.logical_event_key is null
     and native.turn_id is null
     and abs(extract(epoch from (
           native.native_source_observed_at - submitted.source_observed_at
         ))) <= ${UNKEYED_PROMPT_MATCH_SECONDS}
), unkeyed_prompt_pair_candidates as materialized (
  select submitted_id, native_event_id, matched_native_item_id,
         matched_native_observed_at
    from unkeyed_prompt_pair_rows
   where submitted_id is not null and native_event_id is not null
), unkeyed_prompt_pair_degrees as materialized (
  select unkeyed_prompt_pair_candidates.*,
         count(*) over (partition by submitted_id) submitted_degree,
         count(*) over (partition by native_event_id) native_degree
    from unkeyed_prompt_pair_candidates
), unkeyed_prompt_pairs as materialized (
  select submitted_id, matched_native_item_id, matched_native_observed_at
    from unkeyed_prompt_pair_degrees
   where submitted_degree = 1 and native_degree = 1
), unkeyed_prompt_source_rows as materialized (
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
    full join unkeyed_prompt_pairs paired on paired.submitted_id = submitted.id
), unkeyed_prompt_sources as materialized (
  select *
    from unkeyed_prompt_source_rows
   where id is not null
), prompt_identities as materialized (
  select * from keyed_prompt_sources
  union all
  select * from unkeyed_prompt_sources
), prompts as materialized (
  select ranked.*
    from (
      select prompt_identities.*,
             row_number() over (
               partition by person_id, prompt_identity
               order by observed_at asc, source_observed_at asc, id
             ) canonical_rank
        from prompt_identities
       where has_submitted
    ) ranked
   where canonical_rank = 1
     and observed_at >= (select start_at from p)
     and observed_at < (select end_at from p)
 )`;
}

function flameSql() {
  return `
with p as materialized (
  select $1::uuid workspace_id, $2::timestamptz start_at,
         $3::timestamptz end_at, $4::text[] normalizer_versions,
         $5::timestamptz read_at
), roster as materialized (
  select pe.id person_id,
         coalesce(nullif(btrim(pe.display_name), ''), pe.identity_key) display_name
   from telemetry.people pe cross join p
   where pe.workspace_id = p.workspace_id
     and pe.github_id is distinct from 'sherlock-smoke'
     ${dashboardPersonVisibility("pe")}
), buckets as materialized (
  select generate_series(p.start_at, p.end_at - interval '10 minutes',
                         interval '10 minutes') bucket_start
    from p
), ${activityCte({ joins: "join roster r on r.person_id = s.person_id" })}, bucket_activity as materialized (
  select a.person_id,
         date_bin(interval '10 minutes', a.observed_at, p.start_at) bucket_start,
         count(distinct a.session_id) filter (where a.actor_role = 'primary')::bigint agent,
         count(distinct a.session_id) filter (where a.actor_role in ('worker', 'guardian'))::bigint subagent,
         count(distinct a.session_id) filter (where a.actor_role = 'unknown')::bigint other
    from activity_events a cross join p
   where a.observed_at < p.end_at
   group by a.person_id, bucket_start
), day_activity as materialized (
  select r.person_id,
         count(distinct a.session_id) filter (
           where a.actor_role = 'primary' and a.observed_at < p.end_at
         )::bigint day_agent,
         count(distinct a.session_id) filter (
           where a.actor_role in ('worker', 'guardian') and a.observed_at < p.end_at
         )::bigint day_subagent,
         count(distinct a.session_id) filter (
           where a.actor_role = 'unknown' and a.observed_at < p.end_at
         )::bigint day_other
    from roster r left join activity_events a using (person_id)
    cross join p
   group by r.person_id
), recent_activity as materialized (
  select r.person_id, max(a.observed_at) latest_activity
    from roster r
    left join activity_events a using (person_id)
   group by r.person_id
), ${promptsCte({
  candidatePredicate: "and s.person_id in (select person_id from roster)",
})}, prompt_counts as materialized (
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
       d.day_agent, d.day_subagent, d.day_other, l.latest,
       ra.latest_activity
  from roster r cross join buckets b
  join day_activity d using (person_id)
  join recent_activity ra using (person_id)
  cross join latest_observation l
  left join bucket_activity ba
    on ba.person_id = r.person_id and ba.bucket_start = b.bucket_start
  left join prompt_counts pc
    on pc.person_id = r.person_id and pc.bucket_start = b.bucket_start
 order by lower(r.display_name), r.person_id, b.bucket_start
`;
}

export const FLAME_SQL = flameSql();

function relevantActivitySessionsCte() {
  return `
relevant_activity_sessions as materialized (
  select distinct e.session_id
    from telemetry.events e
    join telemetry.sessions s
      on s.workspace_id = e.workspace_id and s.id = e.session_id
   where e.workspace_id = $1::uuid
     and e.normalizer_version = any($4::text[])
     and s.person_id = $7::uuid
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
     and pg_visible_in_snapshot(e.xmin::text::xid8, $6::pg_snapshot)
     and (
       e.actor_role <> 'unknown'
       or pg_visible_in_snapshot(s.xmin::text::xid8, $6::pg_snapshot)
     )
     and coalesce(
       ${nativeItemTimestamp("e.native_item_id")},
       coalesce(e.occurred_at, e.observed_at, e.server_received_at)
     ) >= greatest(
       $2::timestamptz,
       $8::timestamptz - interval '${ACTIVITY_REPRESENTATION_NEIGHBORHOOD_SECONDS} seconds'
     )
     and coalesce(
       ${nativeItemTimestamp("e.native_item_id")},
       coalesce(e.occurred_at, e.observed_at, e.server_received_at)
     ) >= date_trunc('milliseconds', s.started_at)
     and coalesce(
       ${nativeItemTimestamp("e.native_item_id")},
       coalesce(e.occurred_at, e.observed_at, e.server_received_at)
     ) < least(
       $5::timestamptz,
       $9::timestamptz + interval '${ACTIVITY_REPRESENTATION_NEIGHBORHOOD_SECONDS} seconds'
     )
)`;
}

// Canonical ranking must see the full snapshot window. Mutual-unique representation
// matching also needs each direct match's alternative partners, so enrichment keeps two
// hops of the largest pairing tolerance around the selected frame. This preserves degree
// semantics without materializing a person's full day of native source metadata.
const DETAIL_EVENT_COLUMNS = `,
         e.id, e.event_kind, e.event_subtype,
         e.actor_role stored_actor_role,
         e.canonical_scope_key, e.logical_event_key, e.turn_id,
         e.message_role, e.message_origin,
         e.native_item_id source_native_item_id,
         e.content_sha256,
         nr.batch_id source_batch_id, nr.record_index source_record_index,
         nr.source_start_offset, nr.source_end_offset,
         nr.native_type source_native_type,
         nr.native_payload_type source_native_payload_type,
         ib.collector_key source_collector_key,
         ib.source_kind, ib.source_stream_key,
         ib.generation_key, ib.generation_seq,
         ib.start_offset source_batch_start_offset,
         ib.end_offset source_batch_end_offset,
         ib.record_count source_batch_record_count,
         e.content_byte_size, e.content_excerpt`;

function detailActivityCte(candidatePredicate = "") {
  return `
activity_candidates as materialized (
  select s.person_id, e.id, e.session_id,
         s.started_at session_started_at,
         case when e.actor_role = 'unknown' and s.parent_session_id is not null
              then 'worker' else e.actor_role end actor_role,
         e.event_kind, e.event_subtype,
         coalesce(
           ${nativeItemTimestamp("e.native_item_id")},
           coalesce(e.occurred_at, e.observed_at, e.server_received_at)
         ) observed_at,
         case when e.canonical_scope_key is not null and e.logical_event_key is not null
              then row_number() over (
                partition by e.session_id, e.canonical_scope_key,
                             e.normalizer_version, e.logical_event_key, e.event_kind
                order by e.source_priority desc, e.occurred_at asc nulls last, e.id
              )
              else 1 end canonical_rank
    from telemetry.events e
    join telemetry.sessions s
      on s.workspace_id = e.workspace_id and s.id = e.session_id
    cross join p
   where e.workspace_id = p.workspace_id
     and e.normalizer_version = any(p.normalizer_versions)
     and not e.is_replay
     and e.actor_role <> 'automation'
     ${candidatePredicate}
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
     and pg_visible_in_snapshot(e.xmin::text::xid8, p.snapshot)
     and (
       e.actor_role <> 'unknown'
       or pg_visible_in_snapshot(s.xmin::text::xid8, p.snapshot)
     )
     and coalesce(
       ${nativeItemTimestamp("e.native_item_id")},
       coalesce(e.occurred_at, e.observed_at, e.server_received_at)
     ) >= p.start_at
     and coalesce(
       ${nativeItemTimestamp("e.native_item_id")},
       coalesce(e.occurred_at, e.observed_at, e.server_received_at)
     ) < p.read_at
), activity_event_ids as materialized (
  select activity_candidates.person_id, activity_candidates.id,
         activity_candidates.session_id, activity_candidates.actor_role,
         activity_candidates.observed_at
    from activity_candidates cross join p
   where canonical_rank = 1
     and observed_at >= date_trunc('milliseconds', session_started_at)
     and observed_at >= p.bucket_start - interval '${ACTIVITY_REPRESENTATION_NEIGHBORHOOD_SECONDS} seconds'
     and observed_at < p.bucket_end + interval '${ACTIVITY_REPRESENTATION_NEIGHBORHOOD_SECONDS} seconds'
), activity_events as materialized (
  select ids.person_id, ids.session_id, ids.actor_role,
         ids.observed_at${DETAIL_EVENT_COLUMNS}
    from activity_event_ids ids
    join telemetry.events e on e.id = ids.id
    join telemetry.native_records nr
      on nr.workspace_id = e.workspace_id and nr.id = e.source_record_id
    join telemetry.ingest_batches ib
      on ib.workspace_id = nr.workspace_id and ib.id = nr.batch_id
)`;
}

function canonicalActivityEvidenceCte() {
  return `
conversation_sources as materialized (
  select *
    from activity_events
   where content_sha256 is not null
     and logical_event_key is null
     and turn_id is null
     and (
       message_role = 'assistant'
       or message_role = 'user'
       and message_origin in ('human', 'parent_agent')
     )
     and (
       event_kind = 'agent_message'
       and event_subtype = 'agent_message'
       and message_role = 'assistant'
       and source_native_type = 'event_msg'
       and source_native_payload_type = 'agent_message'
       or event_kind = 'message'
       and event_subtype in ('message', 'user_message')
       and message_role in ('assistant', 'user')
       and source_native_type in ('event_msg', 'response_item')
       and source_native_payload_type in ('message', 'user_message')
       or event_kind = 'message'
       and event_subtype in ('message', 'user_message')
       and message_role in ('assistant', 'user')
       and source_kind = 'transcript'
       and source_native_type in ('assistant', 'user')
       and source_native_payload_type is null
     )
), cross_format_pair_candidates as materialized (
  select legacy.id legacy_id, structured.id structured_id,
         legacy.id suppressed_id
    from conversation_sources legacy
    join conversation_sources structured
      on structured.person_id = legacy.person_id
     and structured.session_id = legacy.session_id
     and structured.actor_role = legacy.actor_role
     and structured.stored_actor_role = legacy.stored_actor_role
     and structured.content_sha256 = legacy.content_sha256
     and structured.canonical_scope_key is not distinct from legacy.canonical_scope_key
     and structured.source_collector_key = legacy.source_collector_key
     and structured.source_kind = legacy.source_kind
     and structured.source_stream_key = legacy.source_stream_key
     and structured.generation_key = legacy.generation_key
     and structured.generation_seq = legacy.generation_seq
   where legacy.event_kind = 'agent_message'
     and legacy.event_subtype = 'agent_message'
     and legacy.message_role = 'assistant'
     and legacy.source_native_type = 'event_msg'
     and legacy.source_native_payload_type = 'agent_message'
     and legacy.source_native_item_id is null
     and structured.event_kind = 'message'
     and structured.event_subtype = 'message'
     and structured.message_role = 'assistant'
     and structured.source_native_type = 'response_item'
     and structured.source_native_payload_type = 'message'
     and abs(extract(epoch from (structured.observed_at - legacy.observed_at)))
       <= ${ASSISTANT_REPRESENTATION_MATCH_SECONDS}
  union all
  select submitted.id legacy_id, structured.id structured_id,
         structured.id suppressed_id
    from conversation_sources submitted
    join conversation_sources structured
      on structured.person_id = submitted.person_id
     and structured.session_id = submitted.session_id
     and structured.actor_role = submitted.actor_role
     and structured.stored_actor_role = submitted.stored_actor_role
     and structured.content_sha256 = submitted.content_sha256
     and structured.canonical_scope_key is not distinct from submitted.canonical_scope_key
     and structured.source_collector_key = submitted.source_collector_key
     and structured.source_kind = submitted.source_kind
     and structured.source_stream_key = submitted.source_stream_key
     and structured.generation_key = submitted.generation_key
     and structured.generation_seq = submitted.generation_seq
   where submitted.event_kind = 'message'
     and submitted.event_subtype = 'user_message'
     and submitted.message_role = 'user'
     and submitted.source_native_type = 'event_msg'
     and submitted.source_native_payload_type = 'user_message'
     and submitted.source_native_item_id is null
     and structured.event_kind = 'message'
     and structured.event_subtype = 'message'
     and structured.message_role = 'user'
     and structured.source_native_type = 'response_item'
     and structured.source_native_payload_type = 'message'
     and abs(extract(epoch from (structured.observed_at - submitted.observed_at)))
       <= ${UNKEYED_PROMPT_MATCH_SECONDS}
), cross_format_pair_degrees as materialized (
  select cross_format_pair_candidates.*,
         count(*) over (partition by legacy_id) legacy_degree,
         count(*) over (partition by structured_id) structured_degree
    from cross_format_pair_candidates
), repeated_user_suppressed as materialized (
  select distinct later.id suppressed_id
    from conversation_sources earlier
    join conversation_sources later
      on later.person_id = earlier.person_id
     and later.session_id = earlier.session_id
     and later.actor_role = earlier.actor_role
     and later.stored_actor_role = earlier.stored_actor_role
     and later.content_sha256 = earlier.content_sha256
     and later.canonical_scope_key is not distinct from earlier.canonical_scope_key
     and later.source_batch_id = earlier.source_batch_id
     and later.source_record_index = earlier.source_record_index + 1
     and later.source_start_offset = earlier.source_end_offset
   where earlier.event_kind = 'message'
     and earlier.event_subtype = 'user_message'
     and earlier.message_role = 'user'
     and earlier.source_native_type = 'event_msg'
     and earlier.source_native_payload_type = 'user_message'
     and earlier.source_native_item_id is null
     and later.event_kind = 'message'
     and later.event_subtype = 'user_message'
     and later.message_role = 'user'
     and later.source_native_type = 'event_msg'
     and later.source_native_payload_type = 'user_message'
     and later.source_native_item_id is null
     and abs(extract(epoch from (later.observed_at - earlier.observed_at)))
       <= ${UNKEYED_PROMPT_REPRESENTATION_MILLISECONDS} / 1000.0
), representation_suppressed as materialized (
  select suppressed_id
    from cross_format_pair_degrees
   where legacy_degree = 1 and structured_degree = 1
  union
  select suppressed_id from repeated_user_suppressed
), canonical_activity_events as materialized (
  select activity_events.*
    from activity_events
    left join representation_suppressed
      on representation_suppressed.suppressed_id = activity_events.id
   where representation_suppressed.suppressed_id is null
)`;
}

export const INTERVAL_WORK_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::timestamptz start_at,
         $3::timestamptz end_at, $4::text[] normalizer_versions,
         $5::timestamptz read_at, $6::pg_snapshot snapshot,
         $7::uuid person_id, $8::timestamptz bucket_start,
         $9::timestamptz bucket_end
), ${relevantActivitySessionsCte()}, ${detailActivityCte(`and s.person_id = p.person_id
     and e.session_id in (select session_id from relevant_activity_sessions)`)}, ${canonicalActivityEvidenceCte()}, bucket_events as materialized (
  select candidate.*,
         case when actor_role = 'primary' then 'agent'
              when actor_role in ('worker', 'guardian') then 'subagent'
              else 'unclassified' end semantic_role
    from canonical_activity_events candidate cross join p
   where candidate.person_id = p.person_id
     and candidate.observed_at >= p.bucket_start
     and candidate.observed_at < p.bucket_end
), grouped as (
  select session_id, semantic_role,
         min(observed_at) first_at, max(observed_at) last_at,
         count(*)::bigint event_count,
         (array_agg(content_excerpt order by observed_at, id) filter (
           where event_subtype = 'user_message'
             and message_role = 'user'
             and message_origin in ('human', 'parent_agent')
             and content_excerpt is not null
         ))[1] summary
    from bucket_events
   group by session_id, semantic_role
)
select session_id::text session_id, semantic_role, first_at, last_at,
       event_count, summary
  from grouped
 order by first_at, session_id, semantic_role
 limit $10
`;

export const INTERVAL_PROMPTS_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::timestamptz start_at,
         $3::timestamptz end_at, $4::text[] normalizer_versions,
         $5::timestamptz read_at, $6::pg_snapshot snapshot,
         $7::uuid person_id, $8::timestamptz bucket_start,
         $9::timestamptz bucket_end
), ${promptsCte({
  candidatePredicate: "and s.person_id = p.person_id",
  contentColumns: ", e.content_byte_size, e.content_excerpt",
  visibilityPredicate: "and pg_visible_in_snapshot(e.xmin::text::xid8, p.snapshot)",
})}
select prompt_identity, session_id::text session_id, observed_at,
       content_byte_size, content_excerpt,
       count(*) over ()::bigint eligible_prompt_count
  from prompts cross join p
 where prompts.person_id = p.person_id
   and prompts.observed_at >= p.bucket_start
   and prompts.observed_at < p.bucket_end
 order by prompts.observed_at, prompt_identity
 limit $10
`;

export const WORK_DETAIL_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::timestamptz start_at,
         $3::timestamptz end_at, $4::text[] normalizer_versions,
         $5::timestamptz read_at, $6::pg_snapshot snapshot,
         $7::uuid person_id, $8::timestamptz bucket_start,
         $9::timestamptz bucket_end, $10::uuid session_id,
         $11::text semantic_role, $12::bigint cursor_at_microseconds,
         $13::bigint cursor_id
), ${detailActivityCte(`and s.person_id = p.person_id
     and e.session_id = p.session_id`)}, ${canonicalActivityEvidenceCte()}, bucket_events as materialized (
  select candidate.*,
         case when actor_role = 'primary' then 'agent'
              when actor_role in ('worker', 'guardian') then 'subagent'
              else 'unclassified' end semantic_role
    from canonical_activity_events candidate cross join p
   where candidate.person_id = p.person_id
     and candidate.session_id = p.session_id
     and candidate.observed_at >= p.bucket_start
     and candidate.observed_at < p.bucket_end
), header as (
  select bucket_events.session_id, bucket_events.semantic_role,
         min(bucket_events.observed_at) first_at, max(bucket_events.observed_at) last_at,
         count(*)::bigint event_count,
         (array_agg(bucket_events.content_excerpt order by bucket_events.observed_at, bucket_events.id) filter (
           where bucket_events.event_subtype = 'user_message'
             and bucket_events.message_role = 'user'
             and bucket_events.message_origin in ('human', 'parent_agent')
             and bucket_events.content_excerpt is not null
         ))[1] summary
    from bucket_events cross join p
   where bucket_events.semantic_role = p.semantic_role
   group by bucket_events.session_id, bucket_events.semantic_role
), selected as (
  select bucket_events.*,
         (extract(epoch from bucket_events.observed_at) * 1000000)::bigint observed_at_microseconds
   from bucket_events cross join p
   where bucket_events.semantic_role = p.semantic_role
     and bucket_events.event_kind in ('message', 'agent_message')
     and (
       bucket_events.message_role = 'assistant'
       or bucket_events.message_role = 'user'
       and bucket_events.message_origin in ('human', 'parent_agent')
     )
     and (
       (extract(epoch from bucket_events.observed_at) * 1000000)::bigint,
       bucket_events.id
     ) > (p.cursor_at_microseconds, p.cursor_id)
   order by bucket_events.observed_at, bucket_events.id
   limit $14
)
select header.session_id::text session_id, header.semantic_role,
       header.first_at, header.last_at, header.event_count, header.summary,
       selected.id::text id, selected.observed_at,
       selected.observed_at_microseconds, selected.message_role,
       selected.content_byte_size, selected.content_excerpt
  from header left join selected on true
 order by selected.observed_at nulls first, selected.id nulls first
`;

function projectedEvidenceCte({
  snapshotVisible = false,
  personScoped = false,
  activityThroughReadAt = false,
} = {}) {
  const visibility = snapshotVisible
    ? "and pg_visible_in_snapshot(revision.xmin::text::xid8, p.snapshot)"
    : "";
  const activityEnd = activityThroughReadAt ? "p.read_at" : "p.end_at";
  return `
ranked_frame_revisions as materialized (
  select revision.*,
         row_number() over (
           partition by revision.evidence_kind, revision.source_event_id
           order by revision.id desc
         ) latest_rank
    from analytics.frame_evidence_revisions revision
    cross join p
   where revision.workspace_id = p.workspace_id
     and revision.frame_version = p.frame_version
     ${personScoped ? "and revision.person_id = p.person_id" : ""}
     and (
       revision.evidence_kind = 'activity'
       and revision.observed_at >= p.start_at - interval '${ACTIVITY_REPRESENTATION_NEIGHBORHOOD_SECONDS} seconds'
       and revision.observed_at < ${activityEnd} + interval '${ACTIVITY_REPRESENTATION_NEIGHBORHOOD_SECONDS} seconds'
       or revision.evidence_kind = 'prompt'
       and (
         revision.anchor_observed_at >= p.start_at - interval '${UNKEYED_PROMPT_MATCH_SECONDS} seconds'
         and revision.anchor_observed_at < p.end_at + interval '${UNKEYED_PROMPT_MATCH_SECONDS} seconds'
         or revision.observed_at >= p.start_at - interval '${UNKEYED_PROMPT_MATCH_SECONDS} seconds'
         and revision.observed_at < p.end_at + interval '${UNKEYED_PROMPT_MATCH_SECONDS} seconds'
       )
     )
     ${visibility}
), latest_frame_evidence as materialized (
  select *
    from ranked_frame_revisions
   where latest_rank = 1 and not is_tombstone
), projected_activity as materialized (
  select latest_frame_evidence.*
   from latest_frame_evidence cross join p
   where evidence_kind = 'activity'
     and observed_at >= p.start_at and observed_at < ${activityEnd}
), projected_prompt_candidates as materialized (
  select latest_frame_evidence.*,
         row_number() over (
           partition by latest_frame_evidence.person_id,
                        latest_frame_evidence.prompt_identity
           order by latest_frame_evidence.observed_at,
                    latest_frame_evidence.anchor_observed_at,
                    latest_frame_evidence.source_event_id
         ) prompt_rank
    from latest_frame_evidence cross join p
   where evidence_kind = 'prompt'
     and prompt_identity is not null
     and observed_at >= p.start_at and observed_at < p.end_at
), projected_prompts as materialized (
  select * from projected_prompt_candidates where prompt_rank = 1
)`;
}

export const PROJECTION_FLAME_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::timestamptz start_at,
         $3::timestamptz end_at, $4::text frame_version,
         $5::timestamptz read_at, null::uuid person_id,
         null::pg_snapshot snapshot
), roster as materialized (
  select pe.id person_id,
         coalesce(nullif(btrim(pe.display_name), ''), pe.identity_key) display_name
    from telemetry.people pe cross join p
   where pe.workspace_id = p.workspace_id
     and pe.github_id is distinct from 'sherlock-smoke'
     ${dashboardPersonVisibility("pe")}
), buckets as materialized (
  select generate_series(p.start_at, p.end_at - interval '10 minutes',
                         interval '10 minutes') bucket_start
    from p
), ${projectedEvidenceCte({ activityThroughReadAt: true })}, bucket_activity as materialized (
  select evidence.person_id,
         date_bin(interval '10 minutes', evidence.observed_at, p.start_at) bucket_start,
         count(distinct evidence.session_id) filter (where evidence.actor_role = 'primary')::bigint agent,
         count(distinct evidence.session_id) filter (where evidence.actor_role in ('worker', 'guardian'))::bigint subagent,
         count(distinct evidence.session_id) filter (where evidence.actor_role = 'unknown')::bigint other
    from projected_activity evidence cross join p
   where evidence.observed_at < p.end_at
   group by evidence.person_id, bucket_start
), day_activity as materialized (
  select r.person_id,
         count(distinct evidence.session_id) filter (
           where evidence.actor_role = 'primary' and evidence.observed_at < p.end_at
         )::bigint day_agent,
         count(distinct evidence.session_id) filter (
           where evidence.actor_role in ('worker', 'guardian')
             and evidence.observed_at < p.end_at
         )::bigint day_subagent,
         count(distinct evidence.session_id) filter (
           where evidence.actor_role = 'unknown' and evidence.observed_at < p.end_at
         )::bigint day_other
    from roster r left join projected_activity evidence using (person_id)
    cross join p
   group by r.person_id
), recent_activity as materialized (
  select r.person_id, max(evidence.observed_at) latest_activity
    from roster r left join projected_activity evidence using (person_id)
   group by r.person_id
), prompt_counts as materialized (
  select prompts.person_id,
         date_bin(interval '10 minutes', prompts.observed_at, p.start_at) bucket_start,
         count(*)::bigint prompts
    from projected_prompts prompts cross join p
   group by prompts.person_id, bucket_start
), latest_observation as materialized (
  select greatest(
           (select max(observed_at) from projected_activity),
           (select max(observed_at) from projected_prompts)
         ) latest
)
select r.person_id::text person_id, r.display_name, b.bucket_start,
       coalesce(ba.agent, 0)::bigint agent,
       coalesce(ba.subagent, 0)::bigint subagent,
       coalesce(ba.other, 0)::bigint other,
       coalesce(pc.prompts, 0)::bigint prompts,
       d.day_agent, d.day_subagent, d.day_other, l.latest,
       ra.latest_activity
  from roster r cross join buckets b
  join day_activity d using (person_id)
  join recent_activity ra using (person_id)
  cross join latest_observation l
  left join bucket_activity ba
    on ba.person_id = r.person_id and ba.bucket_start = b.bucket_start
  left join prompt_counts pc
    on pc.person_id = r.person_id and pc.bucket_start = b.bucket_start
 order by lower(r.display_name), r.person_id, b.bucket_start
`;

export const PROJECTION_INTERVAL_WORK_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::text frame_version,
         $3::pg_snapshot snapshot, $4::uuid person_id,
         $5::timestamptz start_at, $6::timestamptz end_at
), ${projectedEvidenceCte({
  snapshotVisible: true,
  personScoped: true,
})}, bucket_events as materialized (
  select evidence.*,
         case when actor_role = 'primary' then 'agent'
              when actor_role in ('worker', 'guardian') then 'subagent'
              else 'unclassified' end semantic_role
    from projected_activity evidence
), grouped as materialized (
  select session_id, semantic_role,
         min(observed_at) first_at, max(observed_at) last_at,
         count(*)::bigint event_count,
         (array_agg(source_event_id order by observed_at, source_event_id)
           filter (where is_summary_candidate))[1] summary_event_id
    from bucket_events
   group by session_id, semantic_role
   order by first_at, session_id, semantic_role
   limit $7
)
select grouped.session_id::text session_id, grouped.semantic_role,
       grouped.first_at, grouped.last_at, grouped.event_count,
       summary.content_excerpt summary
  from grouped
  left join telemetry.events summary
    on summary.workspace_id = $1 and summary.id = grouped.summary_event_id
 order by grouped.first_at, grouped.session_id, grouped.semantic_role
`;

export const PROJECTION_INTERVAL_PROMPTS_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::text frame_version,
         $3::pg_snapshot snapshot, $4::uuid person_id,
         $5::timestamptz start_at, $6::timestamptz end_at,
         $7::timestamptz bucket_start, $8::timestamptz bucket_end
), ${projectedEvidenceCte({
  snapshotVisible: true,
  personScoped: true,
})}, selected as materialized (
  select projected_prompts.*,
         count(*) over ()::bigint eligible_prompt_count
    from projected_prompts cross join p
   where projected_prompts.observed_at >= p.bucket_start
     and projected_prompts.observed_at < p.bucket_end
   order by observed_at, prompt_identity
   limit $9
)
select selected.prompt_identity, selected.session_id::text session_id,
       selected.observed_at, source.content_byte_size, source.content_excerpt,
       selected.eligible_prompt_count
  from selected
  join telemetry.events source
    on source.workspace_id = $1 and source.id = selected.source_event_id
 order by selected.observed_at, selected.prompt_identity
`;

export const PROJECTION_WORK_DETAIL_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::text frame_version,
         $3::pg_snapshot snapshot, $4::uuid person_id,
         $5::timestamptz start_at, $6::timestamptz end_at,
         $7::uuid session_id, $8::text semantic_role,
         $9::bigint cursor_at_microseconds, $10::bigint cursor_id
), ${projectedEvidenceCte({
  snapshotVisible: true,
  personScoped: true,
})}, bucket_events as materialized (
  select evidence.*,
         case when actor_role = 'primary' then 'agent'
              when actor_role in ('worker', 'guardian') then 'subagent'
              else 'unclassified' end semantic_role
    from projected_activity evidence
), header as materialized (
  select bucket_events.session_id, bucket_events.semantic_role,
         min(bucket_events.observed_at) first_at,
         max(bucket_events.observed_at) last_at,
         count(*)::bigint event_count,
         (array_agg(bucket_events.source_event_id order by bucket_events.observed_at,
                    bucket_events.source_event_id)
           filter (where bucket_events.is_summary_candidate))[1] summary_event_id
    from bucket_events cross join p
   where bucket_events.session_id = p.session_id
     and bucket_events.semantic_role = p.semantic_role
   group by bucket_events.session_id, bucket_events.semantic_role
), selected as materialized (
  select bucket_events.*,
         (extract(epoch from bucket_events.observed_at) * 1000000)::bigint
           observed_at_microseconds
    from bucket_events cross join p
   where bucket_events.session_id = p.session_id
     and bucket_events.semantic_role = p.semantic_role
     and bucket_events.event_kind in ('message', 'agent_message')
     and (
       bucket_events.message_role = 'assistant'
       or bucket_events.message_role = 'user'
          and bucket_events.message_origin in ('human', 'parent_agent')
     )
     and (
       (extract(epoch from bucket_events.observed_at) * 1000000)::bigint,
       bucket_events.source_event_id
     ) > (p.cursor_at_microseconds, p.cursor_id)
   order by bucket_events.observed_at, bucket_events.source_event_id
   limit $11
)
select header.session_id::text session_id, header.semantic_role,
       header.first_at, header.last_at, header.event_count,
       summary.content_excerpt summary,
       selected.source_event_id::text id, selected.observed_at,
       selected.observed_at_microseconds, selected.message_role,
       source.content_byte_size, source.content_excerpt
  from header
  left join telemetry.events summary
    on summary.workspace_id = $1 and summary.id = header.summary_event_id
  left join selected on true
  left join telemetry.events source
    on source.workspace_id = $1 and source.id = selected.source_event_id
 order by selected.observed_at nulls first, selected.source_event_id nulls first
`;

export class FlameSourceError extends Error {
  constructor(code, options) {
    super(code, options);
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

function encodeVersionedSnapshotToken(version, values) {
  const body = Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
  const token = `${version}.${body}`;
  if (token.length > MAX_SNAPSHOT_TOKEN_LENGTH) {
    throw new FlameSourceError("flame_snapshot_too_large");
  }
  return token;
}

export function encodeSnapshotToken({ snapshot, read }) {
  const readAt = asDate(read).toISOString();
  const pgSnapshot = parsePgSnapshot(snapshot);
  return encodeVersionedSnapshotToken(
    LEGACY_SNAPSHOT_TOKEN_VERSION,
    [pgSnapshot, readAt],
  );
}

export function encodeProjectionSnapshotToken({ snapshot, read, frameVersion }) {
  if (frameVersion !== FRAME_VERSION) {
    throw new FlameSourceError("flame_snapshot_invalid");
  }
  const readAt = asDate(read).toISOString();
  const pgSnapshot = parsePgSnapshot(snapshot);
  return encodeVersionedSnapshotToken(
    PROJECTION_SNAPSHOT_TOKEN_VERSION,
    [pgSnapshot, readAt, frameVersion],
  );
}

export function decodeSnapshotToken(token) {
  if (typeof token !== "string" || token.length > MAX_SNAPSHOT_TOKEN_LENGTH) {
    throw new FlameSourceError("flame_prompt_request_invalid");
  }
  const [version, body, extra] = token.split(".");
  if (![LEGACY_SNAPSHOT_TOKEN_VERSION, PROJECTION_SNAPSHOT_TOKEN_VERSION].includes(version) ||
      !body || extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/.test(body)) {
    throw new FlameSourceError("flame_prompt_request_invalid");
  }
  try {
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== body) {
      throw new Error("noncanonical_token");
    }
    const value = JSON.parse(decoded);
    const expectedLength = version === LEGACY_SNAPSHOT_TOKEN_VERSION ? 2 : 3;
    if (!Array.isArray(value) || value.length !== expectedLength) {
      throw new Error("invalid_payload");
    }
    const [snapshot, rawRead, frameVersion] = value;
    const read = asDate(rawRead);
    if (read.toISOString() !== rawRead) throw new Error("noncanonical_read");
    const receipt = { snapshot: parsePgSnapshot(snapshot), read };
    if (version === PROJECTION_SNAPSHOT_TOKEN_VERSION) {
      if (frameVersion !== FRAME_VERSION) throw new Error("unsupported_frame_version");
      receipt.frameVersion = frameVersion;
    }
    return receipt;
  } catch {
    throw new FlameSourceError("flame_prompt_request_invalid");
  }
}

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

function cursorInteger(value, { positive = false } = {}) {
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new FlameSourceError("flame_work_cursor_invalid");
  const parsed = BigInt(text);
  if ((positive && parsed < 1n) || parsed < -MAX_SIGNED_BIGINT - 1n ||
      parsed > MAX_SIGNED_BIGINT) {
    throw new FlameSourceError("flame_work_cursor_invalid");
  }
  return parsed.toString();
}

export function encodeWorkCursor({ atMicroseconds, id }) {
  const timestamp = cursorInteger(atMicroseconds);
  const eventId = cursorInteger(id, { positive: true });
  const body = Buffer.from(JSON.stringify([timestamp, eventId]), "utf8").toString("base64url");
  const cursor = `${WORK_CURSOR_VERSION}.${body}`;
  if (cursor.length > MAX_WORK_CURSOR_LENGTH) {
    throw new FlameSourceError("flame_work_cursor_invalid");
  }
  return cursor;
}

export function decodeWorkCursor(cursor) {
  if (cursor === null || cursor === undefined || cursor === "") return null;
  if (typeof cursor !== "string" || cursor.length > MAX_WORK_CURSOR_LENGTH) {
    throw new FlameSourceError("flame_work_cursor_invalid");
  }
  const [version, body, extra] = cursor.split(".");
  if (version !== WORK_CURSOR_VERSION || !body || extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/.test(body)) {
    throw new FlameSourceError("flame_work_cursor_invalid");
  }
  try {
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== body) {
      throw new Error("noncanonical_cursor");
    }
    const value = JSON.parse(decoded);
    if (!Array.isArray(value) || value.length !== 2) {
      throw new Error("invalid_cursor");
    }
    return {
      atMicroseconds: cursorInteger(value[0]),
      id: cursorInteger(value[1], { positive: true }),
    };
  } catch {
    throw new FlameSourceError("flame_work_cursor_invalid");
  }
}

function parseWorkLimit(value) {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_WORK_DETAIL_LIMIT;
  }
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new FlameSourceError("flame_work_request_invalid");
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_WORK_DETAIL_LIMIT) {
    throw new FlameSourceError("flame_work_request_invalid");
  }
  return parsed;
}

function validateIntervalIdentity(personId, startAt, prefix) {
  if (!UUID_PATTERN.test(personId) || startAt.getTime() % BUCKET_MS !== 0) {
    throw new FlameSourceError(`flame_${prefix}_request_invalid`);
  }
}

function requestStart(value, prefix) {
  try {
    return asDate(value);
  } catch {
    throw new FlameSourceError(`flame_${prefix}_request_invalid`);
  }
}

function requestSnapshot(value, prefix) {
  try {
    return decodeSnapshotToken(value);
  } catch {
    throw new FlameSourceError(`flame_${prefix}_request_invalid`);
  }
}

function snapshotBounds(snapshotReceipt, startAt, read, prefix) {
  const oldest = read.getTime() - 25 * 60 * 60 * 1000;
  const snapshotEndMs = Math.floor(snapshotReceipt.read.getTime() / BUCKET_MS) * BUCKET_MS;
  const snapshotStartMs = snapshotEndMs - 24 * 60 * 60 * 1000;
  if (snapshotReceipt.read.getTime() < oldest) {
    throw new FlameSourceError(`flame_${prefix}_snapshot_expired`);
  }
  if (startAt.getTime() < snapshotStartMs || startAt.getTime() >= snapshotEndMs) {
    throw new FlameSourceError(`flame_${prefix}_request_out_of_range`);
  }
  return {
    bucketEnd: new Date(startAt.getTime() + BUCKET_MS),
    snapshotStart: new Date(snapshotStartMs),
    snapshotEnd: new Date(snapshotEndMs),
  };
}

function workFromRow(row) {
  const role = String(row.semantic_role);
  const sessionId = String(row.session_id);
  const summary = row.summary === null || row.summary === undefined
    ? null
    : String(row.summary);
  return {
    id: `${sessionId}:${role}`,
    sessionId,
    role,
    firstAt: asDate(row.first_at).toISOString(),
    lastAt: asDate(row.last_at).toISOString(),
    eventCount: count(row.event_count),
    summary,
  };
}

function detailItemFromRow(row) {
  const content = row.content_excerpt === null || row.content_excerpt === undefined
    ? ""
    : String(row.content_excerpt);
  const contentBytes = row.content_byte_size === null || row.content_byte_size === undefined
    ? 0
    : count(row.content_byte_size);
  return {
    id: String(row.id),
    at: asDate(row.observed_at).toISOString(),
    role: String(row.message_role),
    content,
    truncated: contentBytes > Buffer.byteLength(content, "utf8"),
  };
}

function promptFromRow(row) {
  const content = row.content_excerpt === null || row.content_excerpt === undefined
    ? ""
    : String(row.content_excerpt);
  const contentBytes = row.content_byte_size === null || row.content_byte_size === undefined
    ? 0
    : count(row.content_byte_size);
  return {
    id: String(row.prompt_identity),
    sessionId: String(row.session_id),
    at: asDate(row.observed_at).toISOString(),
    content,
    truncated: contentBytes > Buffer.byteLength(content, "utf8"),
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

function promptEvidenceFromRow(row) {
  const excerpt = row.content_excerpt === null || row.content_excerpt === undefined
    ? ""
    : String(row.content_excerpt);
  const contentBytes = count(row.content_byte_size ?? 0);
  return {
    excerpt,
    excerptTruncated: contentBytes > Buffer.byteLength(excerpt, "utf8"),
  };
}

export function buildFlamePayload({
  rows, roster, start, read, snapshot, frameVersion = null,
}) {
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
    const activeSeconds = buckets.reduce(
      (seconds, bucket) => seconds + (
        bucket.slice(0, 3).some((value) => value > 0) ? BUCKET_MS / 1000 : 0
      ),
      0,
    );
    if (first.latest !== null && first.latest !== undefined) {
      const observed = asDate(first.latest);
      latest = latest === null || observed > latest ? observed : latest;
    }
    return {
      id: String(person.person_id),
      name: String(person.display_name).slice(0, 160),
      lastActivity: first.latest_activity === null || first.latest_activity === undefined
        ? null
        : asDate(first.latest_activity).toISOString(),
      activeSeconds,
      total,
      buckets,
    };
  });

  return {
    start: asDate(start).toISOString(),
    read: asDate(read).toISOString(),
    snapshot: frameVersion === null
      ? encodeSnapshotToken({ snapshot, read })
      : encodeProjectionSnapshotToken({ snapshot, read, frameVersion }),
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
  constructor({ databaseUrl, workspaceId, maxPeople = 500, projectionEnabled = true }) {
    this.workspaceId = workspaceId;
    this.maxPeople = maxPeople;
    this.projectionEnabled = projectionEnabled;
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

  async transaction(callback, {
    signal,
    statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS,
  } = {}) {
    try {
      return await this.sql.begin(async (tx) => {
        await runQuery(tx, "set transaction isolation level repeatable read, read only", undefined, signal);
        await runQuery(
          tx,
          "select set_config('statement_timeout', $1, true)",
          [String(statementTimeoutMs)],
          signal,
        );
        await runQuery(tx, `set local role ${DATABASE_ROLE}`, undefined, signal);
        return await callback(tx);
      });
    } catch (error) {
      if (error instanceof FlameSourceError) throw error;
      if (signal?.aborted) throw new FlameSourceError("flame_request_aborted");
      if (error?.code === "57014") {
        throw new FlameSourceError("flame_database_timeout", { cause: error });
      }
      throw new FlameSourceError("flame_database_unavailable", { cause: error });
    }
  }

  async readiness({ signal } = {}) {
    try {
      return await this.transaction(async (tx) => {
        const rows = await tx.unsafe(`
          select current_role = '${DATABASE_ROLE}' as backend_role,
                 current_setting('transaction_read_only') = 'on' as read_only,
                 has_table_privilege(current_role, 'telemetry.people', 'select') as can_read_people,
                 has_table_privilege(current_role, 'telemetry.events', 'select') as can_read_events
            from pg_roles where rolname = current_role
        `);
        if (!rows[0] || Object.values(rows[0]).some((value) => value !== true)) {
          throw new FlameSourceError("flame_database_reader_unsafe");
        }
        return { status: "ok", mode: "sherlock_backend_aggregate" };
      }, { signal });
    } catch (error) {
      const code = error instanceof FlameSourceError
        ? error.code
        : "flame_database_unavailable";
      return { status: "unavailable", reason: code };
    }
  }

  async fetchDay({ now, signal } = {}) {
    return await this.transaction(async (tx) => {
      const projectionEnabled = this.projectionEnabled !== false;
      const receipt = (await runQuery(tx,
        projectionEnabled
          ? `select transaction_timestamp() as now,
                pg_current_snapshot()::text as snapshot,
                exists (
                  select 1
                    from analytics.frame_projection_activations activation
                   where activation.workspace_id = $1
                     and activation.frame_version = $2
                ) frame_projection_active`
          : `select transaction_timestamp() as now,
                    pg_current_snapshot()::text as snapshot,
                    false as frame_projection_active`,
        projectionEnabled ? [this.workspaceId, FRAME_VERSION] : undefined,
        signal,
      ))[0];
      const read = now ? asDate(now) : asDate(receipt.now);
      const endMs = Math.floor(read.getTime() / BUCKET_MS) * BUCKET_MS;
      const start = new Date(endMs - 24 * 60 * 60 * 1000);
      const end = new Date(endMs);
      const roster = await runQuery(tx,
        PEOPLE_SQL,
        [this.workspaceId, this.maxPeople + 1],
        signal,
      );
      if (roster.length > this.maxPeople) {
        throw new FlameSourceError("flame_database_roster_too_large");
      }
      const frameVersion = receipt.frame_projection_active === true
        ? FRAME_VERSION
        : null;
      const rows = frameVersion === null
        ? await runQuery(tx, FLAME_SQL, [
          this.workspaceId,
          start.toISOString(),
          end.toISOString(),
          tx.array(NORMALIZER_VERSIONS),
          read.toISOString(),
        ], signal)
        : await runQuery(tx, PROJECTION_FLAME_SQL, [
          this.workspaceId,
          start.toISOString(),
          end.toISOString(),
          frameVersion,
          read.toISOString(),
        ], signal);
      return buildFlamePayload({
        rows,
        roster,
        start,
        read,
        snapshot: receipt.snapshot,
        frameVersion,
      });
    }, { signal, statementTimeoutMs: TIMELINE_STATEMENT_TIMEOUT_MS });
  }

  async fetchInterval({ personId, start, snapshot, signal, now }) {
    const startAt = requestStart(start, "interval");
    const snapshotReceipt = requestSnapshot(snapshot, "interval");
    validateIntervalIdentity(personId, startAt, "interval");

    return await this.transaction(async (tx) => {
      const databaseRead = asDate((await runQuery(
        tx, "select transaction_timestamp() as now", undefined, signal,
      ))[0].now);
      const read = now ? asDate(now) : databaseRead;
      const bounds = snapshotBounds(snapshotReceipt, startAt, read, "interval");
      const projected = snapshotReceipt.frameVersion === FRAME_VERSION;
      const workLimit = INTERVAL_WORK_LIMIT + 1;
      const work = projected
        ? await runQuery(tx, PROJECTION_INTERVAL_WORK_SQL, [
          this.workspaceId,
          snapshotReceipt.frameVersion,
          snapshotReceipt.snapshot,
          personId,
          startAt.toISOString(),
          bounds.bucketEnd.toISOString(),
          workLimit,
        ], signal)
        : await runQuery(tx, INTERVAL_WORK_SQL, [
          this.workspaceId,
          bounds.snapshotStart.toISOString(),
          bounds.snapshotEnd.toISOString(),
          tx.array(NORMALIZER_VERSIONS),
          snapshotReceipt.read.toISOString(),
          snapshotReceipt.snapshot,
          personId,
          startAt.toISOString(),
          bounds.bucketEnd.toISOString(),
          workLimit,
        ], signal);
      if (work.length === workLimit) {
        throw new FlameSourceError("flame_interval_work_result_too_large");
      }
      const promptLimit = INTERVAL_PROMPT_LIMIT + 1;
      const prompts = projected
        ? await runQuery(tx, PROJECTION_INTERVAL_PROMPTS_SQL, [
          this.workspaceId,
          snapshotReceipt.frameVersion,
          snapshotReceipt.snapshot,
          personId,
          bounds.snapshotStart.toISOString(),
          bounds.snapshotEnd.toISOString(),
          startAt.toISOString(),
          bounds.bucketEnd.toISOString(),
          promptLimit,
        ], signal)
        : await runQuery(tx, INTERVAL_PROMPTS_SQL, [
          this.workspaceId,
          bounds.snapshotStart.toISOString(),
          bounds.snapshotEnd.toISOString(),
          tx.array(NORMALIZER_VERSIONS),
          snapshotReceipt.read.toISOString(),
          snapshotReceipt.snapshot,
          personId,
          startAt.toISOString(),
          bounds.bucketEnd.toISOString(),
          promptLimit,
        ], signal);
      if (prompts.length === promptLimit) {
        throw new FlameSourceError("flame_interval_prompt_result_too_large");
      }
      return {
        personId,
        start: startAt.toISOString(),
        snapshot,
        work: work.map(workFromRow),
        prompts: prompts.map(promptFromRow),
      };
    }, { signal });
  }

  async fetchWork({
    personId, start, sessionId, role, snapshot, cursor, limit, signal, now,
  }) {
    const startAt = requestStart(start, "work");
    const snapshotReceipt = requestSnapshot(snapshot, "work");
    validateIntervalIdentity(personId, startAt, "work");
    if (!UUID_PATTERN.test(sessionId) ||
        !["agent", "subagent", "unclassified"].includes(role)) {
      throw new FlameSourceError("flame_work_request_invalid");
    }
    const decodedCursor = decodeWorkCursor(cursor);
    const pageSize = parseWorkLimit(limit);

    return await this.transaction(async (tx) => {
      const databaseRead = asDate((await runQuery(
        tx, "select transaction_timestamp() as now", undefined, signal,
      ))[0].now);
      const read = now ? asDate(now) : databaseRead;
      const bounds = snapshotBounds(snapshotReceipt, startAt, read, "work");
      const projected = snapshotReceipt.frameVersion === FRAME_VERSION;
      const bucketStartMicroseconds = BigInt(startAt.getTime()) * 1000n;
      const bucketEndMicroseconds = BigInt(bounds.bucketEnd.getTime()) * 1000n;
      if (decodedCursor) {
        const cursorMicroseconds = BigInt(decodedCursor.atMicroseconds);
        if (cursorMicroseconds < bucketStartMicroseconds ||
            cursorMicroseconds >= bucketEndMicroseconds) {
          throw new FlameSourceError("flame_work_cursor_invalid");
        }
      }
      const workLimit = INTERVAL_WORK_LIMIT + 1;
      const workRows = projected
        ? await runQuery(tx, PROJECTION_INTERVAL_WORK_SQL, [
          this.workspaceId,
          snapshotReceipt.frameVersion,
          snapshotReceipt.snapshot,
          personId,
          startAt.toISOString(),
          bounds.bucketEnd.toISOString(),
          workLimit,
        ], signal)
        : await runQuery(tx, INTERVAL_WORK_SQL, [
          this.workspaceId,
          bounds.snapshotStart.toISOString(),
          bounds.snapshotEnd.toISOString(),
          tx.array(NORMALIZER_VERSIONS),
          snapshotReceipt.read.toISOString(),
          snapshotReceipt.snapshot,
          personId,
          startAt.toISOString(),
          bounds.bucketEnd.toISOString(),
          workLimit,
        ], signal);
      if (workRows.length === workLimit) {
        throw new FlameSourceError("flame_work_result_too_large");
      }
      const headerRow = workRows.find((row) =>
        String(row.session_id) === sessionId && String(row.semantic_role) === role
      );
      if (!headerRow) throw new FlameSourceError("flame_work_request_not_found");
      const header = workFromRow(headerRow);
      const cursorAtMicroseconds = decodedCursor?.atMicroseconds ??
        bucketStartMicroseconds.toString();
      const cursorId = decodedCursor?.id ?? "0";
      const resultRows = projected
        ? await runQuery(tx, PROJECTION_WORK_DETAIL_SQL, [
          this.workspaceId,
          snapshotReceipt.frameVersion,
          snapshotReceipt.snapshot,
          personId,
          startAt.toISOString(),
          bounds.bucketEnd.toISOString(),
          sessionId,
          role,
          cursorAtMicroseconds,
          cursorId,
          pageSize + 1,
        ], signal)
        : await runQuery(tx, WORK_DETAIL_SQL, [
          this.workspaceId,
          bounds.snapshotStart.toISOString(),
          bounds.snapshotEnd.toISOString(),
          tx.array(NORMALIZER_VERSIONS),
          snapshotReceipt.read.toISOString(),
          snapshotReceipt.snapshot,
          personId,
          startAt.toISOString(),
          bounds.bucketEnd.toISOString(),
          sessionId,
          role,
          cursorAtMicroseconds,
          cursorId,
          pageSize + 1,
        ], signal);
      if (resultRows.length === 0) throw new FlameSourceError("flame_work_request_not_found");
      const itemRows = resultRows.filter((row) => row.id !== null && row.id !== undefined);
      const hasMore = itemRows.length > pageSize;
      const pageRows = hasMore ? itemRows.slice(0, pageSize) : itemRows;
      const nextCursor = hasMore
        ? encodeWorkCursor({
          atMicroseconds: pageRows.at(-1).observed_at_microseconds,
          id: pageRows.at(-1).id,
        })
        : null;
      return {
        personId,
        start: startAt.toISOString(),
        snapshot,
        workId: header.id,
        sessionId,
        role,
        firstAt: header.firstAt,
        lastAt: header.lastAt,
        eventCount: header.eventCount,
        items: pageRows.map(detailItemFromRow),
        nextCursor,
      };
    }, { signal });
  }

  async fetchPromptEvidence({ personId, start, snapshot, signal, now }) {
    const startAt = requestStart(start, "prompt");
    const snapshotReceipt = requestSnapshot(snapshot, "prompt");
    validateIntervalIdentity(personId, startAt, "prompt");

    return await this.transaction(async (tx) => {
      const databaseRead = asDate((await runQuery(
        tx, "select transaction_timestamp() as now", undefined, signal,
      ))[0].now);
      const read = now ? asDate(now) : databaseRead;
      const bounds = snapshotBounds(snapshotReceipt, startAt, read, "prompt");
      const projected = snapshotReceipt.frameVersion === FRAME_VERSION;
      const rows = projected
        ? await runQuery(tx, PROJECTION_INTERVAL_PROMPTS_SQL, [
          this.workspaceId,
          snapshotReceipt.frameVersion,
          snapshotReceipt.snapshot,
          personId,
          bounds.snapshotStart.toISOString(),
          bounds.snapshotEnd.toISOString(),
          startAt.toISOString(),
          bounds.bucketEnd.toISOString(),
          MCP_PROMPT_EVIDENCE_LIMIT,
        ], signal)
        : await runQuery(tx, INTERVAL_PROMPTS_SQL, [
          this.workspaceId,
          bounds.snapshotStart.toISOString(),
          bounds.snapshotEnd.toISOString(),
          tx.array(NORMALIZER_VERSIONS),
          snapshotReceipt.read.toISOString(),
          snapshotReceipt.snapshot,
          personId,
          startAt.toISOString(),
          bounds.bucketEnd.toISOString(),
          MCP_PROMPT_EVIDENCE_LIMIT,
        ], signal);
      const eligiblePromptCount = rows.length === 0
        ? 0
        : count(rows[0].eligible_prompt_count);
      return {
        personId,
        start: startAt.toISOString(),
        snapshot,
        eligiblePromptCount,
        prompts: rows.map(promptEvidenceFromRow),
      };
    }, { signal });
  }
}
