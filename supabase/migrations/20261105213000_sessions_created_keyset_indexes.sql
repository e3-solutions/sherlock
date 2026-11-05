-- list_sessions pages sessions newest-created first. With no created_at index
-- the planner read every candidate session of the person (11,906 for one
-- person), evaluated the in-window activity probe for each, then top-N sorted
-- to keep the page: p95 6.7 s on Cosmos (Nov 5), 9,568 cold block reads for
-- a 1-day window. These keyset indexes let it walk sessions in page order and
-- stop once the page is full.
--
-- telemetry.sessions has ~76k rows, so each build takes well under a second.

set lock_timeout = '1s';
set statement_timeout = '60s';

create index if not exists sessions_person_created_idx
  on telemetry.sessions (workspace_id, person_id, created_at, id);
create index if not exists sessions_created_idx
  on telemetry.sessions (workspace_id, created_at, id);
