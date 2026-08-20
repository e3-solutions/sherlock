import {
  canonicalEvidence,
  diffEvidence,
  type EvidenceState,
  fingerprintEvidence,
  FRAME_ADVISORY_LOCK_SQL,
  FRAME_BEGIN_SQL,
  FRAME_LOCK_TIMEOUT_SQL,
  FRAME_RESET_TIMEOUT_SQL,
  FRAME_SOURCE_COORDINATES_SQL,
  FRAME_SOURCE_EVENTS_SQL,
  frameTimestampForWrite,
  PostgresFrameEvidenceProjector,
  type SourceEvent,
} from "./frame-projector.ts";
import {
  FRAME_ACTIVATION_PROOF_SQL,
  FRAME_BLOCKING_JOBS_SQL,
} from "../../scripts/backfill-frame-evidence.ts";

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

Deno.test("frame fingerprints are deterministic and cover canonical state", async () => {
  const activity = evidence();
  const prompt = evidence({
    evidence_kind: "prompt",
    source_event_id: 2n,
    prompt_identity: "native:msg_2",
    is_summary_candidate: false,
  });
  const forward = await fingerprintEvidence([activity, prompt]);
  const reverse = await fingerprintEvidence([prompt, activity]);
  assert(forward === reverse && /^[0-9a-f]{64}$/.test(forward));
  assert(
    await fingerprintEvidence([activity, {
      ...prompt,
      observed_at: "2026-08-20T12:00:01.000Z",
    }]) !==
      forward,
    "canonical timestamp correction must change the fingerprint",
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

Deno.test("revision writes preserve timestamp text until PostgreSQL casts it", () => {
  const timestampWrite = frameTimestampForWrite.toString();
  assert(timestampWrite.includes("::text::timestamptz"));
  const projector = PostgresFrameEvidenceProjector.prototype.projectSession
    .toString();
  assert(projector.includes("change.anchor_observed_at"));
  assert(projector.includes("change.observed_at"));
  assert(
    projector.match(/frameTimestampForWrite/g)?.length === 2,
    "both revision timestamps must bypass the client timestamptz serializer",
  );
});

Deno.test("projector reads only bounded source metadata and never copies content", () => {
  assert(FRAME_SOURCE_EVENTS_SQL.includes("e.content_excerpt is not null"));
  assert(!FRAME_SOURCE_EVENTS_SQL.includes("e.content_excerpt,"));
  assert(!FRAME_SOURCE_EVENTS_SQL.includes("storage_path"));
  assert(!FRAME_SOURCE_EVENTS_SQL.includes("record_sha256"));
  assert(FRAME_SOURCE_EVENTS_SQL.includes("e.id <= $4"));
});

Deno.test("projector bounds advisory-lock waits before taking its snapshot", () => {
  assert(FRAME_LOCK_TIMEOUT_SQL.includes("statement_timeout"));
  assert(FRAME_LOCK_TIMEOUT_SQL.includes("false"));
  assert(FRAME_ADVISORY_LOCK_SQL.includes("pg_advisory_lock"));
  assert(FRAME_RESET_TIMEOUT_SQL === "reset statement_timeout");
  const implementation = PostgresFrameEvidenceProjector.prototype.projectSession
    .toString();
  assert(
    implementation.indexOf("FRAME_LOCK_TIMEOUT_SQL") <
      implementation.indexOf("FRAME_ADVISORY_LOCK_SQL"),
  );
  assert(
    implementation.indexOf("FRAME_ADVISORY_LOCK_SQL") <
      implementation.indexOf("FRAME_BEGIN_SQL"),
    "the session lock must be held before repeatable read takes a snapshot",
  );
  assert(
    !implementation.includes("connection.begin"),
    "a reserved connection must not request a nested pool transaction",
  );
  assert(FRAME_BEGIN_SQL === "begin isolation level repeatable read");
});

Deno.test("projector and activation prove the complete session source state", () => {
  assert(FRAME_SOURCE_COORDINATES_SQL.includes("max(id)"));
  assert(FRAME_SOURCE_COORDINATES_SQL.includes("count(*)"));
  assert(FRAME_SOURCE_COORDINATES_SQL.includes("not is_replay"));
  assert(FRAME_ACTIVATION_PROOF_SQL.includes("source_event_count"));
  assert(FRAME_ACTIVATION_PROOF_SQL.includes("session_updated_at"));
  assert(FRAME_ACTIVATION_PROOF_SQL.includes("is distinct from"));
  assert(
    FRAME_BLOCKING_JOBS_SQL.includes("'queued', 'leased', 'failed'"),
  );
  assert(
    FRAME_BLOCKING_JOBS_SQL.includes("job_kind = 'normalize'"),
    "activation must wait for durable normalization backlog",
  );
  assert(FRAME_BLOCKING_JOBS_SQL.includes("job_kind = 'reduce'"));
  assert(
    FRAME_BLOCKING_JOBS_SQL.includes("workspace_id = $1"),
    "unrelated workspaces must not block activation",
  );
});
