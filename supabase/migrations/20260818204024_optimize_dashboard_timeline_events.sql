-- The dashboard filters a rolling 24-hour window by the canonical timestamp:
-- native UUIDv7 time when available, then the source observation timestamps.
-- Match that expression and the activity eligibility predicate exactly so the
-- aggregate starts from the requested workspace/window instead of rescanning
-- the workspace/session uniqueness index once for every session.
-- CI pins Supabase CLI 2.114.0, which runs CONCURRENTLY outside its transaction batch.
create index concurrently events_dashboard_timeline_idx
  on telemetry.events (
    workspace_id,
    normalizer_version,
    (
      coalesce(
        case
          when native_item_id ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then to_timestamp((
            ('x' || replace(
              substring(native_item_id from '[0-9a-f]{8}-[0-9a-f]{4}'),
              '-',
              ''
            ))::bit(48)::bigint
          ) / 1000.0)
          else null
        end,
        coalesce(occurred_at, observed_at, server_received_at)
      )
    )
  ) include (
    id,
    session_id,
    actor_role,
    event_kind,
    event_subtype,
    canonical_scope_key,
    logical_event_key,
    source_priority,
    occurred_at,
    observed_at,
    server_received_at,
    native_item_id
  )
  where not is_replay
    and actor_role <> 'automation'
    and event_kind in (
      'message', 'reasoning', 'tool_call', 'tool_result', 'agent_spawn',
      'agent_message', 'lifecycle', 'error'
    )
    and (
      event_kind <> 'message'
      or native_item_id is not null
      or event_subtype = 'user_message'
    )
    and (
      event_kind <> 'lifecycle'
      or event_subtype in ('task_started', 'task_complete', 'turn_started', 'turn_complete')
    );
