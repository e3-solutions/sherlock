
with roster as materialized (
  select pe.id person_id
    from telemetry.people pe
   where pe.workspace_id = $1 and pe.github_id is distinct from 'sherlock-smoke'
     and split_part(pe.email, '@', 2) = $4 and split_part(pe.email, '@', 3) = ''
), candidates as materialized (
  select e.id, e.session_id,
         row_number() over (
           partition by e.session_id, ib.source_provider, e.canonical_scope_key,
             coalesce(nr.native_record_start_offset, nr.source_start_offset),
             coalesce(nr.native_record_end_offset, nr.source_end_offset),
             coalesce(nr.native_record_sha256, nr.record_sha256), e.event_kind, e.projection_index
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
     and c.to_normalizer_version = 'sherlock.codex-rollout.v2'
   where s.workspace_id = $1 and e.event_kind = 'usage' and not e.is_replay
     and e.occurred_at >= $2 and e.occurred_at < $3
     and e.normalizer_version = any($5::text[])
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
     and not exists (
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
     and winner_cutover.to_normalizer_version = 'sherlock.codex-rollout.v2'
    where winner.workspace_id = e.workspace_id
      and winner.session_id = e.session_id
      and case when winner.event_kind = 'message'
    and winner.normalizer_version like 'sherlock.codex-rollout.%'
    then 'codex' else winner.normalizer_version end = case when e.event_kind = 'message'
    and e.normalizer_version like 'sherlock.codex-rollout.%'
    then 'codex' else e.normalizer_version end
      and winner.canonical_scope_key = e.canonical_scope_key
      and winner.logical_event_key = e.logical_event_key
      and winner.event_kind = e.event_kind and not winner.is_replay
      and (winner.source_priority > e.source_priority
        or winner.source_priority = e.source_priority
          and (winner.occurred_at, winner.id) < (e.occurred_at, e.id))
      and (
    winner_batch.source_provider = 'claude_code'
    and winner.normalizer_version = 'sherlock.claude-code-transcript.v1'
    or winner_batch.source_provider = 'codex'
    and (
      winner.normalizer_version = 'sherlock.codex-rollout.v3'
      or not exists (
        select 1 from telemetry.events corrected
         where corrected.workspace_id = winner.workspace_id
           and corrected.source_record_id = winner.source_record_id
           and corrected.normalizer_version = 'sherlock.codex-rollout.v3'
           and not corrected.is_replay
      ) and (
      (winner_cutover.cutover_at is null
       or s.started_at >= winner_cutover.cutover_at)
      and winner.normalizer_version = 'sherlock.codex-rollout.v2'
      or s.started_at < winner_cutover.cutover_at
      and (
        winner.normalizer_version = 'sherlock.codex-rollout.v1'
        or winner.normalizer_version = 'sherlock.codex-rollout.v2'
        and not exists (
          select 1 from telemetry.events legacy
           where legacy.workspace_id = winner.workspace_id
             and legacy.source_record_id = winner.source_record_id
             and legacy.normalizer_version = 'sherlock.codex-rollout.v1'
             and not legacy.is_replay
        )
      )
      )
    )
  )
  )
)
select count(distinct session_id)::bigint observed_sessions,
       count(*)::bigint observed_usage_events
  from candidates where canonical_rank = 1
