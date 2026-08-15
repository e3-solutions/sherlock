alter table telemetry.events
  add column message_search tsvector generated always as (
    to_tsvector('simple', coalesce(content_excerpt, ''))
  ) stored;

create index events_message_search_idx
  on telemetry.events using gin (message_search)
  where event_kind in ('message', 'agent_message');

comment on column telemetry.events.message_search is
  'Search index over the bounded message excerpt; full content remains in immutable raw Storage.';
