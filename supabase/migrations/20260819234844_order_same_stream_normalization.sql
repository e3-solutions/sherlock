-- The queue may inspect only immutable batch identity/range columns needed to
-- serialize normalization within one source generation. Raw hashes, storage
-- paths, attribution hints, and payload records remain inaccessible.
-- Queue claim logic blocks on queued/leased predecessors; a terminal failure
-- remains auditable in processing.telemetry_jobs but releases later evidence.
grant usage on schema telemetry to sherlock_processor;
grant select (
  id,
  workspace_id,
  collector_key,
  source_kind,
  source_stream_key,
  generation_key,
  generation_seq,
  start_offset
) on telemetry.ingest_batches to sherlock_processor;

comment on column telemetry.ingest_batches.start_offset is
  'Immutable byte offset; queue eligibility uses it to serialize normalization within a source generation.';
