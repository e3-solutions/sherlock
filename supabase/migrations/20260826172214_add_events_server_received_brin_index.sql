-- Events are append-ordered by server receipt time. Build this small rolling-
-- window index without blocking writes to the existing telemetry stream.
create index concurrently events_server_received_brin_idx
  on telemetry.events using brin (server_received_at);
