-- Dashboard active-time reads discard spans ending before the rolling window.
-- Lead with ended_at so PostgreSQL can skip historical revisions efficiently;
-- include span_key for candidate discovery before latest-revision selection.
create index activity_spans_ended_window_idx
  on analytics.activity_spans (
    workspace_id, activity_version, ended_at, started_at
  ) include (span_key)
  where not is_tombstone;
