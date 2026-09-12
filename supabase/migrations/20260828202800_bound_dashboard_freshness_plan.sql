-- The aggregate freshness function is SECURITY DEFINER, so PostgreSQL plans its
-- parameterized body without the literal workspace and roster cardinality that
-- make the indexed activity scan cheap. The generic estimate can choose nested
-- loops that rescan the large events index once per visible person. Scope the
-- proven hash-capable plan setting to this product view only; raw telemetry and
-- every other database workload keep their existing planner configuration.
alter function analytics.read_dashboard_freshness(uuid, text, text[], integer)
  set enable_nestloop = off;

alter function analytics.read_dashboard_freshness(uuid, text, text[], integer)
  set enable_seqscan = off;
