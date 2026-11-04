
with p as not materialized (
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
  select s.id session_id, s.person_id, r.display_name, s.started_at
    from telemetry.sessions s join roster r on r.person_id = s.person_id cross join p
   where s.workspace_id = p.workspace_id and s.started_at < p.end_at
     and exists (
       select 1 from telemetry.events w
        where w.workspace_id = p.workspace_id and w.session_id = s.id
          and w.event_kind = 'usage' and not w.is_replay
          and w.occurred_at >= p.start_at and w.occurred_at < p.end_at
     )
), candidates as materialized (
  select e.id, e.session_id, s.person_id, s.display_name, s.started_at,
         e.normalizer_version, e.event_kind, e.event_subtype, e.projection_index,
         e.canonical_scope_key, e.logical_event_key, e.usage_stream_key, e.usage_is_cumulative,
         e.model recorded_model, e.source_priority,
         case when ib.source_provider = 'claude_code' then 'claude' else 'codex' end provider,
         e.input_tokens, e.cached_input_tokens, e.output_tokens,
         e.reasoning_tokens, e.total_tokens, e.occurred_at usage_at,
         coalesce(nr.native_record_start_offset, nr.source_start_offset) native_start,
         coalesce(nr.native_record_end_offset, nr.source_end_offset) native_end,
         coalesce(nr.native_record_sha256, nr.record_sha256) native_hash,
         (e.occurred_at >= p.start_at and e.occurred_at < p.end_at) in_window
    from eligible_sessions s
    join telemetry.events e on e.session_id = s.session_id
    join telemetry.native_records nr
      on nr.workspace_id = e.workspace_id and nr.id = e.source_record_id
    join telemetry.ingest_batches ib
      on ib.workspace_id = nr.workspace_id and ib.id = nr.batch_id
    left join analytics.normalizer_cutovers c
      on c.workspace_id = e.workspace_id and c.source_provider = ib.source_provider
     and c.to_normalizer_version = 'sherlock.codex-rollout.v2'
    cross join p
   where e.workspace_id = p.workspace_id and not e.is_replay
     and (e.event_kind = 'usage' or
          e.event_kind = 'lifecycle' and e.event_subtype = 'turn_context')
     and (
    ib.source_provider = 'claude_code'
    and e.normalizer_version = 'sherlock.claude-code-transcript.v1'
    or ib.source_provider = 'codex'
    and (
      e.normalizer_version = 'sherlock.codex-rollout.v3'
      or not exists (
        select 1 from telemetry.events corrected
         where corrected.workspace_id = e.workspace_id
           and corrected.source_record_id = e.source_record_id
           and corrected.normalizer_version = 'sherlock.codex-rollout.v3'
           and not corrected.is_replay
      ) and (
      (c.cutover_at is null
       or s.started_at >= c.cutover_at)
      and e.normalizer_version = 'sherlock.codex-rollout.v2'
      or s.started_at < c.cutover_at
      and (
        e.normalizer_version = 'sherlock.codex-rollout.v1'
        or e.normalizer_version = 'sherlock.codex-rollout.v2'
        and not exists (
          select 1 from telemetry.events legacy
           where legacy.workspace_id = e.workspace_id
             and legacy.source_record_id = e.source_record_id
             and legacy.normalizer_version = 'sherlock.codex-rollout.v1'
             and not legacy.is_replay
        )
      )
      )
    )
  )
), canonical_ranked as materialized (
  select *, row_number() over (
    partition by session_id, normalizer_version, canonical_scope_key, logical_event_key, event_kind
    order by source_priority desc, usage_at, id
  ) canonical_rank
  from candidates
), canonical_events as materialized (
  select * from canonical_ranked
   where canonical_rank = 1 or canonical_scope_key is null or logical_event_key is null
), native_positions as materialized (
  select session_id, provider, canonical_scope_key, native_start, native_end,
         min(native_hash) <> max(native_hash) hash_conflict
    from canonical_events
   group by session_id, provider, canonical_scope_key, native_start, native_end
), position_conflicts as materialized (
  select *, hash_conflict
    or coalesce(max(native_end) over (
      partition by session_id, provider, canonical_scope_key
      order by native_start, native_end rows between unbounded preceding and 1 preceding
    ) > native_start, false)
    or coalesce(lead(native_start) over (
      partition by session_id, provider, canonical_scope_key
      order by native_start, native_end
    ) < native_end, false) source_conflict
  from native_positions
), ranked as materialized (
  select ce.*, pc.source_conflict,
         row_number() over (
           partition by ce.session_id, ce.provider, ce.canonical_scope_key,
             ce.native_start, ce.native_end, native_hash, event_kind, projection_index
           order by source_priority desc, id
         ) source_rank
    from canonical_events ce
    join position_conflicts pc on pc.session_id = ce.session_id and pc.provider = ce.provider
      and pc.canonical_scope_key is not distinct from ce.canonical_scope_key
      and pc.native_start = ce.native_start and pc.native_end = ce.native_end
), native_events as materialized (
  select * from ranked where source_rank = 1
), contextualized as materialized (
  select *,
         count(*) filter (where event_subtype = 'turn_context') over source_order context_number,
         bool_or(source_conflict) over source_order source_uncertain
    from native_events
  window source_order as (
    partition by session_id, provider, canonical_scope_key
    order by native_start, native_end, id rows unbounded preceding
  )
), attributed as materialized (
  select *, case when provider = 'claude'
                then coalesce(nullif(btrim(recorded_model), ''), 'unknown')
                when source_uncertain then 'unknown'
                else coalesce(max(nullif(btrim(recorded_model), '')) filter (
                  where event_subtype = 'turn_context'
                ) over (partition by session_id, provider, canonical_scope_key, context_number), 'unknown')
           end model
    from contextualized
), ordered as materialized (
  select *,
         lag(input_tokens) over stream_order previous_input,
         lag(cached_input_tokens) over stream_order previous_cached,
         lag(output_tokens) over stream_order previous_output,
         lag(reasoning_tokens) over stream_order previous_reasoning,
         lag(total_tokens) over stream_order previous_total,
         lag(id) over stream_order previous_id
    from attributed where event_kind = 'usage'
  window stream_order as (
    partition by session_id, provider, usage_stream_key, usage_is_cumulative
    order by native_start, native_end, id
  )
), assessed as materialized (
  select *, bool_or(
    usage_is_cumulative and previous_id is not null and (
      input_tokens < previous_input or cached_input_tokens < previous_cached
      or output_tokens < previous_output or reasoning_tokens < previous_reasoning
      or total_tokens < previous_total
    )
  ) over (
    partition by session_id, provider, usage_stream_key, usage_is_cumulative
    order by native_start, native_end, id rows unbounded preceding
  ) stream_regressed,
    (usage_is_cumulative and previous_id is null
      and started_at < (select start_at from p)) missing_baseline
  from ordered
), contributions as materialized (
  select *,
    case when stream_regressed or source_uncertain then 0
         when not usage_is_cumulative then coalesce(input_tokens, 0)
         when previous_id is not null and previous_input is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(input_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(input_tokens, previous_input, 0) - coalesce(previous_input, 0), 0)
    end input_delta,
    case when stream_regressed or source_uncertain then 0
         when not usage_is_cumulative then coalesce(cached_input_tokens, 0)
         when previous_id is not null and previous_cached is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(cached_input_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(cached_input_tokens, previous_cached, 0) - coalesce(previous_cached, 0), 0)
    end cached_delta,
    case when stream_regressed or source_uncertain then 0
         when not usage_is_cumulative then coalesce(output_tokens, 0)
         when previous_id is not null and previous_output is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(output_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(output_tokens, previous_output, 0) - coalesce(previous_output, 0), 0)
    end output_delta,
    case when stream_regressed or source_uncertain then 0
         when not usage_is_cumulative then coalesce(reasoning_tokens, 0)
         when previous_id is not null and previous_reasoning is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(reasoning_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(reasoning_tokens, previous_reasoning, 0) - coalesce(previous_reasoning, 0), 0)
    end reasoning_delta,
    case when stream_regressed or source_uncertain then 0
         when not usage_is_cumulative then coalesce(total_tokens, 0)
         when previous_id is not null and previous_total is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(total_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(total_tokens, previous_total, 0) - coalesce(previous_total, 0), 0)
    end total_delta,
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
       array_agg(distinct session_id::text || ':' || usage_stream_key || ':' || usage_is_cumulative::text) stream_ids,
       count(*) filter (where missing_baseline)::bigint missing_baseline_count,
       array_agg(distinct session_id::text || ':' || usage_stream_key || ':' || usage_is_cumulative::text)
         filter (where regression) regressed_stream_ids,
       count(*) filter (where regression or missing_baseline or source_uncertain
         or input_tokens is null or cached_input_tokens is null or output_tokens is null
         or reasoning_tokens is null or total_tokens is null
         or usage_is_cumulative and previous_id is not null and (
           previous_input is null or previous_cached is null or previous_output is null
           or previous_reasoning is null or previous_total is null
         ))::bigint excluded_usage_events,
       count(*) filter (where source_uncertain)::bigint conflicting_source_events,
       count(*) filter (where model = 'unknown')::bigint missing_model_observations,
       array_remove(array[
         case when bool_or(input_tokens is null or
           usage_is_cumulative and previous_id is not null and previous_input is null) then 'input' end,
         case when bool_or(cached_input_tokens is null or
           usage_is_cumulative and previous_id is not null and previous_cached is null) then 'cachedInput' end,
         case when bool_or(output_tokens is null or
           usage_is_cumulative and previous_id is not null and previous_output is null) then 'output' end,
         case when bool_or(reasoning_tokens is null or
           usage_is_cumulative and previous_id is not null and previous_reasoning is null) then 'reasoning' end,
         case when bool_or(total_tokens is null or
           usage_is_cumulative and previous_id is not null and previous_total is null) then 'total' end
       ], null) missing_token_components
 from contributions
 group by person_id, display_name, provider, model
 order by lower(display_name), person_id, provider, model
 limit 201
