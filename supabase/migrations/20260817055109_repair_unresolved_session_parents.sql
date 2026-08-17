update telemetry.sessions as child
set parent_session_id = parent.id,
    updated_at = now()
from telemetry.sessions as parent
where child.parent_session_id is null
  and child.parent_native_session_id is not null
  and child.workspace_id = parent.workspace_id
  and child.collector_key = parent.collector_key
  and child.person_id = parent.person_id
  and child.parent_native_session_id = parent.native_session_id
  and child.id <> parent.id;

create index sessions_unresolved_parent_native_idx
  on telemetry.sessions (
    workspace_id,
    collector_key,
    person_id,
    parent_native_session_id
  )
  where parent_session_id is null
    and parent_native_session_id is not null;
