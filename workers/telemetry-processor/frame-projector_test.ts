import {
  canonicalEvidence,
  diffEvidence,
  type EvidenceState,
  FRAME_SOURCE_EVENTS_SQL,
  revisionInsertBatches,
  type SourceEvent,
} from "./frame-projector.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function evidence(overrides: Partial<EvidenceState> = {}): EvidenceState {
  return {
    evidence_kind: "activity",
    source_event_id: 1n,
    anchor_observed_at: "2026-08-20T12:00:00.000Z",
    observed_at: "2026-08-20T12:00:00.000Z",
    actor_role: "primary",
    event_kind: "message",
    event_subtype: "user_message",
    message_role: "user",
    message_origin: "human",
    prompt_identity: null,
    is_summary_candidate: true,
    is_tombstone: false,
    ...overrides,
  };
}

function sourceEvent(overrides: Partial<SourceEvent> = {}): SourceEvent {
  return {
    id: 1n,
    person_id: "person-1",
    session_id: "session-1",
    normalizer_version: "sherlock.codex-rollout.v1",
    canonical_scope_key: null,
    logical_event_key: null,
    source_priority: 100,
    event_kind: "message",
    event_subtype: "user_message",
    stored_actor_role: "primary",
    actor_role: "primary",
    occurred_at: "2026-08-20T12:00:00.000000Z",
    source_observed_at: "2026-08-20T12:00:00.000000Z",
    activity_observed_at: "2026-08-20T12:00:00.000000Z",
    native_item_id: null,
    turn_id: null,
    message_role: "user",
    message_origin: "human",
    content_sha256: "a".repeat(64),
    content_byte_size: 12,
    has_content_excerpt: true,
    error_code: null,
    source_batch_id: "batch-1",
    source_record_index: 0,
    source_start_offset: 0n,
    source_end_offset: 10n,
    source_native_type: "event_msg",
    source_native_payload_type: "user_message",
    source_collector_key: "collector-1",
    source_kind: "rollout",
    source_stream_key: "stream-1",
    generation_key: "generation-1",
    generation_seq: 0n,
    ...overrides,
  };
}

Deno.test("frame evidence diff is append-only, idempotent, and tombstones removals", () => {
  const first = evidence();
  assert(diffEvidence([first], []).length === 1);
  assert(
    diffEvidence([first], [first]).length === 0,
    "exact rerun must be a no-op",
  );

  const corrected = evidence({ actor_role: "worker" });
  const correction = diffEvidence([corrected], [first]);
  assert(correction.length === 1 && correction[0].actor_role === "worker");
  assert(
    !correction[0].is_tombstone,
    "same-key correction must append a live revision",
  );

  const removal = diffEvidence([], [corrected]);
  assert(removal.length === 1 && removal[0].is_tombstone);
  assert(removal[0].source_event_id === corrected.source_event_id);
  assert(
    diffEvidence([], removal).length === 0,
    "an already tombstoned source must not create repeated tombstones",
  );
});

Deno.test("adjacent event_msg user copies are suppressed from activity", () => {
  const earlier = sourceEvent();
  const duplicate = sourceEvent({
    id: 2n,
    source_record_index: 1,
    source_start_offset: 10n,
    source_end_offset: 20n,
    occurred_at: "2026-08-20T12:00:00.050000Z",
    source_observed_at: "2026-08-20T12:00:00.050000Z",
    activity_observed_at: "2026-08-20T12:00:00.050000Z",
  });
  const activity = canonicalEvidence(
    [earlier, duplicate],
    "2026-08-20T11:59:00.000000Z",
    new Date("2026-08-20T11:00:00Z"),
    new Date("2026-08-20T13:00:00Z"),
  ).filter((row) => row.evidence_kind === "activity");
  assert(activity.length === 1);
  assert(activity[0].source_event_id === earlier.id);
});

Deno.test("canonical rank preserves PostgreSQL timestamp microseconds", () => {
  const later = sourceEvent({
    id: 1n,
    canonical_scope_key: "scope",
    logical_event_key: "logical",
    occurred_at: "2026-08-20T12:00:00.000900Z",
    source_observed_at: "2026-08-20T12:00:00.000900Z",
    activity_observed_at: "2026-08-20T12:00:00.000900Z",
  });
  const earlier = sourceEvent({
    id: 2n,
    canonical_scope_key: "scope",
    logical_event_key: "logical",
    occurred_at: "2026-08-20T12:00:00.000100Z",
    source_observed_at: "2026-08-20T12:00:00.000100Z",
    activity_observed_at: "2026-08-20T12:00:00.000100Z",
  });
  const activity = canonicalEvidence(
    [later, earlier],
    "2026-08-20T11:59:00.000000Z",
    new Date("2026-08-20T11:00:00Z"),
    new Date("2026-08-20T13:00:00Z"),
  ).filter((row) => row.evidence_kind === "activity");
  assert(activity.length === 1);
  assert(activity[0].source_event_id === earlier.id);
  assert(activity[0].observed_at.endsWith(".000100Z"));
});

Deno.test("projector reads only bounded source metadata and never copies content", () => {
  assert(FRAME_SOURCE_EVENTS_SQL.includes("e.content_excerpt is not null"));
  assert(!FRAME_SOURCE_EVENTS_SQL.includes("e.content_excerpt,"));
  assert(!FRAME_SOURCE_EVENTS_SQL.includes("storage_path"));
  assert(!FRAME_SOURCE_EVENTS_SQL.includes("record_sha256"));
  assert(FRAME_SOURCE_EVENTS_SQL.includes("e.id <= $4"));
});

Deno.test("large revision writes are split below PostgreSQL's parameter limit", () => {
  const batches = revisionInsertBatches(
    Array.from({ length: 3_001 }, (_, i) => i),
  );
  assert(batches.length === 2);
  assert(batches[0].length === 3_000);
  assert(batches[1].length === 1);
});
