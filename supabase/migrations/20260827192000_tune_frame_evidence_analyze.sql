-- COR-3872: keep planner statistics current as append-only frame evidence grows.
alter table analytics.frame_evidence_revisions set (
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 5000
);

analyze analytics.frame_evidence_revisions (
  workspace_id,
  frame_version,
  person_id,
  evidence_kind,
  observed_at,
  anchor_observed_at
);
