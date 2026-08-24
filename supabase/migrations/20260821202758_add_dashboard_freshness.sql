-- Expose only bounded, aggregate freshness facts to the dashboard reader. The
-- definer is required solely to inspect the private processing queue; callers
-- never receive job ids, errors, leases, raw payloads, or source locations.
create or replace function analytics.read_dashboard_freshness(
  p_workspace_id uuid,
  p_expected_email_domain text,
  p_normalizer_versions text[],
  p_max_people integer
)
returns table (
  read_at timestamptz,
  raw_watermark timestamptz,
  canonical_watermark timestamptz,
  oldest_pending_normalize timestamptz,
  pending_normalize_count bigint,
  person_id uuid,
  latest_canonical_activity timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with p as materialized (
    select p_workspace_id workspace_id,
           transaction_timestamp() read_at,
           transaction_timestamp() - interval '30 minutes' start_at,
           p_expected_email_domain expected_email_domain,
           p_normalizer_versions normalizer_versions
     where p_workspace_id is not null
       and p_expected_email_domain in ('e3group.ai', 'sixtyfour.ai')
       and cardinality(p_normalizer_versions) between 1 and 16
       and p_max_people between 1 and 1000
  ), roster as materialized (
    select pe.id person_id
      from telemetry.people pe
      cross join p
     where pe.workspace_id = p.workspace_id
       and pe.github_id is distinct from 'sherlock-smoke'
       and split_part(pe.email, '@', 2) = p.expected_email_domain
       and split_part(pe.email, '@', 3) = ''
     order by lower(coalesce(nullif(btrim(pe.display_name), ''), pe.identity_key)), pe.id
     limit p_max_people + 1
  ), activity_candidates as materialized (
    select s.person_id, e.id, e.session_id, s.started_at session_started_at,
           e.server_received_at,
           coalesce(
             case
               when e.native_item_id ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
               then to_timestamp((
                 ('x' || replace(substring(e.native_item_id from '[0-9a-f]{8}-[0-9a-f]{4}'), '-', ''))::bit(48)::bigint
               ) / 1000.0)
               else null
             end,
             coalesce(e.occurred_at, e.observed_at, e.server_received_at)
           ) observed_at,
           case when e.canonical_scope_key is not null and e.logical_event_key is not null
                then row_number() over (
                  partition by e.session_id, e.canonical_scope_key,
                               e.normalizer_version, e.logical_event_key, e.event_kind
                  order by e.source_priority desc, e.occurred_at asc nulls last, e.id
                ) else 1 end canonical_rank
      from telemetry.events e
      join telemetry.sessions s
        on s.workspace_id = e.workspace_id and s.id = e.session_id
      join roster r on r.person_id = s.person_id
      cross join p
     where e.workspace_id = p.workspace_id
       and e.normalizer_version = any(p.normalizer_versions)
       and not e.is_replay
       and e.actor_role <> 'automation'
       and e.event_kind in (
         'message', 'reasoning', 'tool_call', 'tool_result', 'agent_spawn',
         'agent_message', 'lifecycle', 'error'
       )
       and (e.event_kind <> 'message' or e.native_item_id is not null or e.event_subtype = 'user_message')
       and (e.event_kind <> 'lifecycle' or e.event_subtype in ('task_started', 'task_complete', 'turn_started', 'turn_complete'))
       and coalesce(
         case
           when e.native_item_id ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           then to_timestamp((
             ('x' || replace(substring(e.native_item_id from '[0-9a-f]{8}-[0-9a-f]{4}'), '-', ''))::bit(48)::bigint
           ) / 1000.0)
           else null
         end,
         coalesce(e.occurred_at, e.observed_at, e.server_received_at)
       ) >= p.start_at
       and coalesce(
         case
           when e.native_item_id ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           then to_timestamp((
             ('x' || replace(substring(e.native_item_id from '[0-9a-f]{8}-[0-9a-f]{4}'), '-', ''))::bit(48)::bigint
           ) / 1000.0)
           else null
         end,
         coalesce(e.occurred_at, e.observed_at, e.server_received_at)
       ) < p.read_at
  ), latest_activity as materialized (
    select r.person_id, max(a.observed_at) latest_canonical_activity
      from roster r
      left join activity_candidates a
        on a.person_id = r.person_id
       and a.canonical_rank = 1
       and a.observed_at >= date_trunc('milliseconds', a.session_started_at)
     group by r.person_id
  ), pending_freshness as materialized (
    select min(b.committed_at) oldest_pending_normalize,
           count(*) pending_normalize_count
      from processing.telemetry_jobs j
      join telemetry.ingest_batches b
        on b.workspace_id = j.workspace_id and b.id = j.batch_id
      join roster r on r.person_id = b.person_id
      cross join p
     where j.workspace_id = p.workspace_id
       and j.job_kind = 'normalize'
       and j.workload_class = 'live'
       and j.status in ('queued', 'leased')
  ), global_freshness as materialized (
    select p.read_at,
           (
             select max(latest.committed_at)
               from roster r
               cross join lateral (
                 select b.committed_at
                   from telemetry.ingest_batches b
                  where b.workspace_id = p.workspace_id
                    and b.person_id = r.person_id
                  order by b.committed_at desc, b.id desc
                  limit 1
               ) latest
           ) raw_watermark,
           (
             select max(a.server_received_at)
               from activity_candidates a
              where a.canonical_rank = 1
           ) canonical_watermark,
           pending.oldest_pending_normalize,
           pending.pending_normalize_count
      from p
      cross join pending_freshness pending
  )
  select g.read_at, g.raw_watermark, g.canonical_watermark,
         g.oldest_pending_normalize, g.pending_normalize_count,
         a.person_id, a.latest_canonical_activity
    from global_freshness g
    left join latest_activity a on true
   order by a.person_id;
$$;

comment on function analytics.read_dashboard_freshness(uuid, text, text[], integer) is
  'Bounded dashboard freshness receipt. SECURITY DEFINER protects the private processing queue and returns no source or job detail.';

revoke all on function analytics.read_dashboard_freshness(uuid, text, text[], integer)
  from public, anon, authenticated, service_role,
       sherlock_ingest, sherlock_normalizer, sherlock_reducer, sherlock_processor;
grant execute on function analytics.read_dashboard_freshness(uuid, text, text[], integer)
  to sherlock_reader;

-- Support the narrow live pending-normalize scan. Raw per-person watermarks use
-- the existing ingest_batches_person_committed_idx.
create index if not exists telemetry_jobs_dashboard_pending_normalize_idx
  on processing.telemetry_jobs (workspace_id, id)
  include (batch_id)
  where job_kind = 'normalize'
    and workload_class = 'live'
    and status in ('queued', 'leased');
