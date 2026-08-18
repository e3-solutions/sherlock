import postgres from "postgres";

export const BUCKET_COUNT = 144;
export const BUCKET_MS = 10 * 60 * 1000;
export const NORMALIZER_VERSION = "sherlock.codex-rollout.v1";
export const DATABASE_ROLE = "sherlock_normalizer";
const SNAPSHOT_TOKEN_VERSION = "v1";
const WORK_CURSOR_VERSION = "v1";
const MAX_SNAPSHOT_TOKEN_LENGTH = 8_192;
const MAX_WORK_CURSOR_LENGTH = 512;
const PG_SNAPSHOT_PATTERN = /^\d+:\d+:(?:\d+(?:,\d+)*)?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const UNKEYED_PROMPT_MATCH_SECONDS = 2;
export const UNKEYED_PROMPT_REPRESENTATION_MILLISECONDS = 100;
export const ASSISTANT_REPRESENTATION_MATCH_SECONDS = 3;
export const INTERVAL_WORK_LIMIT = 200;
export const DEFAULT_WORK_DETAIL_LIMIT = 50;
export const MAX_WORK_DETAIL_LIMIT = 100;
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

function activityCte({
  candidateColumns = "",
  candidatePredicate = "",
  eventColumns = "",
  joins = "",
  visibilityPredicate = "",
} = {}) {
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
              else 1 end canonical_rank${candidateColumns}
    from telemetry.events e
    join telemetry.sessions s
      on s.workspace_id = e.workspace_id and s.id = e.session_id
    ${joins}
    cross join p
   where e.workspace_id = p.workspace_id
     and e.normalizer_version = p.normalizer_version
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
     ${visibilityPredicate}
     and coalesce(
       ${nativeItemTimestamp("e.native_item_id")},
       coalesce(e.occurred_at, e.observed_at, e.server_received_at)
     ) >= p.start_at
     and coalesce(
       ${nativeItemTimestamp("e.native_item_id")},
       coalesce(e.occurred_at, e.observed_at, e.server_received_at)
     ) < p.read_at
), activity_events as materialized (
  select person_id, session_id, actor_role, observed_at${eventColumns}
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

function promptsCte(contentColumns = "", visibilityPredicate = "") {
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
), prompt_representation_suppressed as materialized (
  select distinct duplicate.id suppressed_id
    from canonical_prompt_candidates duplicate
    join canonical_prompt_candidates previous
      on previous.session_id = duplicate.session_id
     and previous.event_kind = duplicate.event_kind
     and previous.event_subtype = duplicate.event_subtype
     and previous.content_sha256 = duplicate.content_sha256
     and previous.source_batch_id = duplicate.source_batch_id
     and previous.source_record_index = duplicate.source_record_index - 1
     and previous.source_end_offset = duplicate.source_start_offset
     and previous.canonical_scope_key is not distinct from duplicate.canonical_scope_key
   where duplicate.event_subtype = 'user_message'
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
), unkeyed_submitted_prompts as materialized (
  select canonical_prompt_candidates.*
    from canonical_prompt_candidates
    left join prompt_representation_suppressed
      on prompt_representation_suppressed.suppressed_id = canonical_prompt_candidates.id
   where (canonical_scope_key is null or logical_event_key is null)
     and event_subtype = 'user_message'
     and prompt_representation_suppressed.suppressed_id is null
), unkeyed_prompt_pair_candidates as materialized (
  select submitted.id submitted_id, native.id native_event_id,
         native.native_item_id matched_native_item_id,
         native.native_observed_at matched_native_observed_at
    from unkeyed_submitted_prompts submitted
    join native_identity_candidates native
      on native.session_id = submitted.session_id
     and native.content_sha256 = submitted.content_sha256
     and native.source_collector_key = submitted.source_collector_key
     and native.source_kind = submitted.source_kind
     and native.source_stream_key = submitted.source_stream_key
     and native.generation_key = submitted.generation_key
     and native.generation_seq = submitted.generation_seq
   where submitted.logical_event_key is null
     and submitted.turn_id is null
     and native.logical_event_key is null
     and native.turn_id is null
     and abs(extract(epoch from (
           native.native_source_observed_at - submitted.source_observed_at
         ))) <= ${UNKEYED_PROMPT_MATCH_SECONDS}
), unkeyed_prompt_pair_degrees as materialized (
  select unkeyed_prompt_pair_candidates.*,
         count(*) over (partition by submitted_id) submitted_degree,
         count(*) over (partition by native_event_id) native_degree
    from unkeyed_prompt_pair_candidates
), unkeyed_prompt_pairs as materialized (
  select submitted_id, matched_native_item_id, matched_native_observed_at
    from unkeyed_prompt_pair_degrees
   where submitted_degree = 1 and native_degree = 1
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

export const FLAME_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::timestamptz start_at,
         $3::timestamptz end_at, $4::text normalizer_version,
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

const DETAIL_ACTIVITY_COLUMNS = `,
         e.actor_role stored_actor_role,
         e.canonical_scope_key, e.logical_event_key, e.turn_id,
         e.message_role,
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

const DETAIL_EVENT_COLUMNS = `, id, event_kind, event_subtype,
         stored_actor_role, canonical_scope_key, logical_event_key, turn_id,
         message_role,
         source_native_item_id,
         content_sha256, source_batch_id, source_record_index,
         source_start_offset, source_end_offset,
         source_native_type, source_native_payload_type,
         source_collector_key, source_kind, source_stream_key,
         generation_key, generation_seq,
         source_batch_start_offset, source_batch_end_offset,
         source_batch_record_count,
         content_byte_size, content_excerpt`;

function canonicalActivityEvidenceCte() {
  return `
conversation_sources as materialized (
  select *
    from activity_events
   where content_sha256 is not null
     and logical_event_key is null
     and turn_id is null
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
         $3::timestamptz end_at, $4::text normalizer_version,
         $5::timestamptz read_at, $6::pg_snapshot snapshot,
         $7::uuid person_id, $8::timestamptz bucket_start,
         $9::timestamptz bucket_end
), ${activityCte({
  candidateColumns: DETAIL_ACTIVITY_COLUMNS,
  candidatePredicate: "and s.person_id = p.person_id",
  eventColumns: DETAIL_EVENT_COLUMNS,
  joins: `join telemetry.native_records nr
      on nr.workspace_id = e.workspace_id and nr.id = e.source_record_id
    join telemetry.ingest_batches ib
      on ib.workspace_id = nr.workspace_id and ib.id = nr.batch_id`,
  visibilityPredicate: `and pg_visible_in_snapshot(e.xmin::text::xid8, p.snapshot)
     and (
       e.actor_role <> 'unknown'
       or pg_visible_in_snapshot(s.xmin::text::xid8, p.snapshot)
     )`,
})}, ${canonicalActivityEvidenceCte()}, bucket_events as materialized (
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
             and message_role = 'user' and content_excerpt is not null
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

export const WORK_DETAIL_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::timestamptz start_at,
         $3::timestamptz end_at, $4::text normalizer_version,
         $5::timestamptz read_at, $6::pg_snapshot snapshot,
         $7::uuid person_id, $8::timestamptz bucket_start,
         $9::timestamptz bucket_end, $10::uuid session_id,
         $11::text semantic_role, $12::bigint cursor_at_microseconds,
         $13::bigint cursor_id
), ${activityCte({
  candidateColumns: DETAIL_ACTIVITY_COLUMNS,
  candidatePredicate: `and s.person_id = p.person_id
     and e.session_id = p.session_id`,
  eventColumns: DETAIL_EVENT_COLUMNS,
  joins: `join telemetry.native_records nr
      on nr.workspace_id = e.workspace_id and nr.id = e.source_record_id
    join telemetry.ingest_batches ib
      on ib.workspace_id = nr.workspace_id and ib.id = nr.batch_id`,
  visibilityPredicate: `and pg_visible_in_snapshot(e.xmin::text::xid8, p.snapshot)
     and (
       e.actor_role <> 'unknown'
       or pg_visible_in_snapshot(s.xmin::text::xid8, p.snapshot)
     )`,
})}, ${canonicalActivityEvidenceCte()}, bucket_events as materialized (
  select candidate.*,
         case when actor_role = 'primary' then 'agent'
              when actor_role in ('worker', 'guardian') then 'subagent'
              else 'unclassified' end semantic_role
    from canonical_activity_events candidate cross join p
   where candidate.person_id = p.person_id
     and candidate.session_id = p.session_id
     and candidate.observed_at >= p.bucket_start
     and candidate.observed_at < p.bucket_end
), selected as (
  select bucket_events.*,
         (extract(epoch from bucket_events.observed_at) * 1000000)::bigint observed_at_microseconds
   from bucket_events cross join p
   where bucket_events.semantic_role = p.semantic_role
     and bucket_events.event_kind in ('message', 'agent_message')
     and bucket_events.message_role in ('user', 'assistant')
     and (
       (extract(epoch from bucket_events.observed_at) * 1000000)::bigint,
       bucket_events.id
     ) > (p.cursor_at_microseconds, p.cursor_id)
   order by bucket_events.observed_at, bucket_events.id
   limit $14
)
select selected.id::text id, selected.observed_at,
       selected.observed_at_microseconds, message_role,
       content_byte_size, content_excerpt
  from selected
 order by selected.observed_at, selected.id
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
  if (snapshotReceipt.read.getTime() < oldest ||
      startAt.getTime() < snapshotStartMs || startAt.getTime() >= snapshotEndMs) {
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
        read.toISOString(),
      ]);
      return buildFlamePayload({ rows, roster, start, read, snapshot: receipt.snapshot });
    });
  }

  async fetchInterval({ personId, start, snapshot }) {
    const startAt = requestStart(start, "interval");
    const snapshotReceipt = requestSnapshot(snapshot, "interval");
    validateIntervalIdentity(personId, startAt, "interval");

    return await this.transaction(async (tx) => {
      const read = asDate((await tx.unsafe("select transaction_timestamp() as now"))[0].now);
      const bounds = snapshotBounds(snapshotReceipt, startAt, read, "interval");
      const workLimit = INTERVAL_WORK_LIMIT + 1;
      const work = await tx.unsafe(INTERVAL_WORK_SQL, [
        this.workspaceId,
        bounds.snapshotStart.toISOString(),
        bounds.snapshotEnd.toISOString(),
        NORMALIZER_VERSION,
        snapshotReceipt.read.toISOString(),
        snapshotReceipt.snapshot,
        personId,
        startAt.toISOString(),
        bounds.bucketEnd.toISOString(),
        workLimit,
      ]);
      if (work.length === workLimit) {
        throw new FlameSourceError("flame_interval_work_result_too_large");
      }
      return {
        personId,
        start: startAt.toISOString(),
        snapshot,
        work: work.map(workFromRow),
      };
    });
  }

  async fetchWork({ personId, start, sessionId, role, snapshot, cursor, limit }) {
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
      const read = asDate((await tx.unsafe("select transaction_timestamp() as now"))[0].now);
      const bounds = snapshotBounds(snapshotReceipt, startAt, read, "work");
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
      const workRows = await tx.unsafe(INTERVAL_WORK_SQL, [
        this.workspaceId,
        bounds.snapshotStart.toISOString(),
        bounds.snapshotEnd.toISOString(),
        NORMALIZER_VERSION,
        snapshotReceipt.read.toISOString(),
        snapshotReceipt.snapshot,
        personId,
        startAt.toISOString(),
        bounds.bucketEnd.toISOString(),
        workLimit,
      ]);
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
      const itemRows = await tx.unsafe(WORK_DETAIL_SQL, [
        this.workspaceId,
        bounds.snapshotStart.toISOString(),
        bounds.snapshotEnd.toISOString(),
        NORMALIZER_VERSION,
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
      ]);
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
    });
  }
}
