import {
  canonicalEvidence,
  diffEvidence,
  type EvidenceState,
  FRAME_SOURCE_EVENTS_SQL,
  PostgresFrameEvidenceProjector,
  revisionInsertBatches,
  type SourceEvent,
} from "./frame-projector.ts";
import { MISSING_NORMALIZATION_BATCHES_SQL } from "../../scripts/backfill-frame-evidence.ts";

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
    normalizer_version: "sherlock.codex-rollout.v2",
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

Deno.test("native human user messages are prompts without a user_message envelope", () => {
  const nativeOnly = sourceEvent({
    event_subtype: "message",
    source_priority: 50,
    native_item_id: "msg_01a01f0a-da00-7000-8000-000000000001",
    source_native_type: "response_item",
    source_native_payload_type: "message",
  });
  const prompts = canonicalEvidence(
    [nativeOnly],
    "2026-08-20T11:59:00.000000Z",
    new Date("2026-08-20T11:00:00Z"),
    new Date("2026-08-20T13:00:00Z"),
  ).filter((row) => row.evidence_kind === "prompt");

  assert(prompts.length === 1);
  assert(prompts[0].source_event_id === nativeOnly.id);
  assert(
    prompts[0].prompt_identity ===
      "native:msg_01a01f0a-da00-7000-8000-000000000001",
  );
  const activity = canonicalEvidence(
    [nativeOnly],
    "2026-08-20T11:59:00.000000Z",
    new Date("2026-08-20T11:00:00Z"),
    new Date("2026-08-20T13:00:00Z"),
  ).find((row) => row.evidence_kind === "activity");
  assert(activity?.is_summary_candidate === true);
});

Deno.test("native machine context is not projected as a prompt", () => {
  const internalContext = sourceEvent({
    event_subtype: "message",
    source_priority: 50,
    native_item_id: "msg_01a01f0a-da00-7000-8000-000000000003",
    source_native_type: "response_item",
    source_native_payload_type: "message",
    message_origin: "runtime_context",
  });
  const prompts = canonicalEvidence(
    [internalContext],
    "2026-08-20T11:59:00.000000Z",
    new Date("2026-08-20T11:00:00Z"),
    new Date("2026-08-20T13:00:00Z"),
  ).filter((row) => row.evidence_kind === "prompt");

  assert(prompts.length === 0);
  const activity = canonicalEvidence(
    [internalContext],
    "2026-08-20T11:59:00.000000Z",
    new Date("2026-08-20T11:00:00Z"),
    new Date("2026-08-20T13:00:00Z"),
  ).find((row) => row.evidence_kind === "activity");
  assert(activity?.is_summary_candidate === false);
});

Deno.test("native parent-agent runtime context does not title worker sessions", () => {
  const workerMessage = sourceEvent({
    event_subtype: "message",
    stored_actor_role: "worker",
    actor_role: "worker",
    message_origin: "parent_agent",
    native_item_id: "msg_01a01f0a-da00-7000-8000-000000000002",
    source_native_type: "response_item",
    source_native_payload_type: "message",
  });
  const activity = canonicalEvidence(
    [workerMessage],
    "2026-08-20T11:59:00.000000Z",
    new Date("2026-08-20T11:00:00Z"),
    new Date("2026-08-20T13:00:00Z"),
  ).find((row) => row.evidence_kind === "activity");

  assert(activity?.is_summary_candidate === false);
});

Deno.test("native and envelope copies remain one canonical prompt", () => {
  const native = sourceEvent({
    id: 10n,
    event_subtype: "message",
    source_priority: 50,
    native_item_id: "msg_01a01f0a-da00-7000-8000-000000000001",
    source_native_type: "response_item",
    source_native_payload_type: "message",
  });
  const submitted = sourceEvent({ id: 11n });
  const prompts = canonicalEvidence(
    [native, submitted],
    "2026-08-20T11:59:00.000000Z",
    new Date("2026-08-20T11:00:00Z"),
    new Date("2026-08-20T13:00:00Z"),
  ).filter((row) => row.evidence_kind === "prompt");

  assert(prompts.length === 1);
  assert(
    prompts[0].prompt_identity ===
      "native:msg_01a01f0a-da00-7000-8000-000000000001",
  );
});

Deno.test("projector reads only bounded source metadata and never copies content", () => {
  assert(FRAME_SOURCE_EVENTS_SQL.includes("e.content_excerpt is not null"));
  assert(!FRAME_SOURCE_EVENTS_SQL.includes("<recommended_plugins>"));
  assert(!FRAME_SOURCE_EVENTS_SQL.includes("<heartbeat>"));
  assert(!FRAME_SOURCE_EVENTS_SQL.includes("e.content_excerpt,"));
  assert(!FRAME_SOURCE_EVENTS_SQL.includes("storage_path"));
  assert(!FRAME_SOURCE_EVENTS_SQL.includes("record_sha256"));
  assert(FRAME_SOURCE_EVENTS_SQL.includes("e.id <= $3"));
  assert(FRAME_SOURCE_EVENTS_SQL.includes("analytics.normalizer_cutovers"));
  assert(
    FRAME_SOURCE_EVENTS_SQL.includes("s.started_at >= cutover.cutover_at"),
  );
  assert(FRAME_SOURCE_EVENTS_SQL.includes("sherlock.codex-rollout.v1"));
  assert(FRAME_SOURCE_EVENTS_SQL.includes("sherlock.codex-rollout.v2"));
});

Deno.test("activation proves only the session-selected normalization version", () => {
  assert(
    MISSING_NORMALIZATION_BATCHES_SQL.includes("telemetry.native_records"),
  );
  assert(MISSING_NORMALIZATION_BATCHES_SQL.includes("telemetry.events"));
  assert(
    MISSING_NORMALIZATION_BATCHES_SQL.includes(
      "session.started_at",
    ),
  );
  assert(
    MISSING_NORMALIZATION_BATCHES_SQL.includes(
      "batch.source_provider = 'claude_code'",
    ),
  );
  assert(
    !MISSING_NORMALIZATION_BATCHES_SQL.includes("processing.telemetry_jobs"),
  );
  assert(
    MISSING_NORMALIZATION_BATCHES_SQL.includes("sherlock.codex-rollout.v1"),
  );
  assert(
    MISSING_NORMALIZATION_BATCHES_SQL.includes("sherlock.codex-rollout.v2"),
  );
  assert(FRAME_SOURCE_EVENTS_SQL.includes("not exists ("));
  assert(FRAME_SOURCE_EVENTS_SQL.includes("telemetry.events legacy"));
});

Deno.test("large revision writes are split below PostgreSQL's parameter limit", () => {
  const batches = revisionInsertBatches(
    Array.from({ length: 3_001 }, (_, i) => i),
  );
  assert(batches.length === 2);
  assert(batches[0].length === 3_000);
  assert(batches[1].length === 1);
});

Deno.test("frame projection rechecks the absolute deadline after pool reserve", async () => {
  let released = false;
  let databaseOperations = 0;
  const connection = {
    unsafe() {
      databaseOperations += 1;
      return Promise.resolve([]);
    },
    release() {
      released = true;
    },
  };
  const deadlineAtMs = performance.now() + 1_000;
  const projector = new PostgresFrameEvidenceProjector({
    reserve: () => Promise.resolve(connection),
  } as never);
  let code = "";
  try {
    await projector.projectSession({
      workspaceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      requestGeneration: 1n,
      statementTimeoutMs: 5_000,
      deadlineAtMs,
      monotonicNow: () => deadlineAtMs + 1,
    });
  } catch (error) {
    code = error instanceof Error && "code" in error ? String(error.code) : "";
  }
  assert(code === "processing_deadline_exceeded");
  assert(databaseOperations === 0, "expired work must not mutate the database");
  assert(released, "the reserved connection must always be released");
});
