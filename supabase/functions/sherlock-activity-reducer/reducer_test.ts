import {
  type ActivityEvent,
  canonicalizeEvents,
  reduceActivity,
} from "./reducer.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const normalized = (value: unknown) =>
    JSON.stringify(
      value,
      (_key, item) => typeof item === "bigint" ? item.toString() : item,
    );
  if (normalized(actual) !== normalized(expected)) {
    throw new Error(
      `expected ${normalized(expected)}, received ${normalized(actual)}`,
    );
  }
}

const SESSION = "00000000-0000-0000-0000-000000000010";

function event(
  id: number,
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
  const timestamp = `2026-08-15T00:00:${String(id).padStart(2, "0")}.000000Z`;
  return {
    id: BigInt(id),
    workspace_id: "00000000-0000-0000-0000-000000000001",
    session_id: SESSION,
    normalizer_version: "sherlock.codex-rollout.v1",
    canonical_scope_key: `session:${SESSION}`,
    logical_event_key: null,
    source_priority: 100,
    is_replay: false,
    event_kind: "unknown",
    event_subtype: null,
    phase: null,
    actor_role: "primary",
    occurred_at: timestamp,
    observed_at: timestamp,
    server_received_at: "2026-08-15T01:00:00.000000Z",
    turn_id: null,
    tool_call_id: null,
    tool_status: null,
    message_origin: null,
    project_key: "sherlock",
    ...overrides,
  };
}

Deno.test("canonical selection suppresses only keyed duplicates and replays", () => {
  const keyed = [
    event(1, {
      logical_event_key: "message:user:turn-1",
      event_kind: "message",
      source_priority: 50,
    }),
    event(2, {
      logical_event_key: "message:user:turn-1",
      event_kind: "message",
      source_priority: 100,
    }),
    event(3, {
      logical_event_key: "message:user:turn-1",
      event_kind: "message",
      source_priority: 200,
      is_replay: true,
    }),
  ];
  const unkeyed = [event(4), event(5)];
  const selected = canonicalizeEvents([
    unkeyed[1],
    keyed[2],
    keyed[0],
    unkeyed[0],
    keyed[1],
  ]);

  assertEquals(selected.map((item) => item.id), [2n, 4n, 5n]);
});

Deno.test("canonical ties use source time nulls last and then event id", () => {
  const candidates = [
    event(9, {
      logical_event_key: "tie",
      event_kind: "message",
      occurred_at: null,
    }),
    event(8, {
      logical_event_key: "tie",
      event_kind: "message",
      occurred_at: "2026-08-15T00:00:08.000000Z",
    }),
    event(7, {
      logical_event_key: "tie",
      event_kind: "message",
      occurred_at: "2026-08-15T00:00:08.000000Z",
    }),
  ];

  assertEquals(canonicalizeEvents(candidates).map((item) => item.id), [7n]);
  assertEquals(
    canonicalizeEvents([...candidates].reverse()).map((item) => item.id),
    [7n],
  );
});

Deno.test("completed turn and paired tool retain deterministic evidence", () => {
  const events = [
    event(1, {
      event_kind: "lifecycle",
      event_subtype: "turn_started",
      turn_id: "turn-1",
    }),
    event(2, {
      event_kind: "message",
      message_origin: "human",
      turn_id: "turn-1",
      logical_event_key: "message:user:turn-1",
      source_priority: 50,
    }),
    event(3, {
      event_kind: "message",
      message_origin: "human",
      turn_id: "turn-1",
      logical_event_key: "message:user:turn-1",
      source_priority: 100,
    }),
    event(4, {
      event_kind: "tool_call",
      turn_id: "turn-1",
      tool_call_id: "call-1",
      tool_status: "in_progress",
    }),
    event(6, {
      event_kind: "tool_result",
      turn_id: "turn-1",
      tool_call_id: "call-1",
    }),
    event(7, {
      event_kind: "lifecycle",
      event_subtype: "turn_complete",
      turn_id: "turn-1",
    }),
  ];

  const spans = reduceActivity(SESSION, [...events].reverse());
  const turn = spans.find((span) => span.activity_kind === "turn");
  const tool = spans.find((span) => span.activity_kind === "tool");
  assert(turn);
  assertEquals({
    start: turn.start_event_id,
    end: turn.end_event_id,
    basis: turn.timing_basis,
    confidence: turn.confidence,
  }, { start: 1n, end: 7n, basis: "lifecycle", confidence: "inferred" });
  assert(tool);
  assertEquals({
    start: tool.start_event_id,
    end: tool.end_event_id,
    basis: tool.timing_basis,
  }, { start: 4n, end: 6n, basis: "paired_events" });
  assert(tool.span_key.includes("call-1"));
});

Deno.test("Claude prompt identity reduces reasoning and tools into one turn", () => {
  const turnId = "claude:prompt:prompt-1";
  const events = [
    event(1, {
      normalizer_version: "sherlock.claude-code-transcript.v1",
      event_kind: "message",
      event_subtype: "user_message",
      message_origin: "human",
      turn_id: turnId,
      logical_event_key: "claude:message:user-1",
    }),
    event(2, {
      normalizer_version: "sherlock.claude-code-transcript.v1",
      event_kind: "reasoning",
      event_subtype: "thinking",
      turn_id: turnId,
      logical_event_key: "claude:reasoning:thinking-record-1:block:0",
    }),
    event(3, {
      normalizer_version: "sherlock.claude-code-transcript.v1",
      event_kind: "tool_call",
      event_subtype: "tool_use",
      turn_id: turnId,
      tool_call_id: "tool-1",
    }),
    event(4, {
      normalizer_version: "sherlock.claude-code-transcript.v1",
      event_kind: "tool_result",
      event_subtype: "tool_result",
      turn_id: turnId,
      tool_call_id: "tool-1",
    }),
    event(5, {
      normalizer_version: "sherlock.claude-code-transcript.v1",
      event_kind: "message",
      event_subtype: "message",
      message_origin: "unknown",
      turn_id: turnId,
      logical_event_key: "claude:message:answer-1",
    }),
    event(6, {
      normalizer_version: "sherlock.claude-code-transcript.v1",
      event_kind: "lifecycle",
      event_subtype: "turn_complete",
      turn_id: turnId,
    }),
  ];

  const spans = reduceActivity(SESSION, events);
  const turn = spans.find((span) => span.activity_kind === "turn");
  const tool = spans.find((span) => span.activity_kind === "tool");
  assert(turn);
  assertEquals({
    start: turn.start_event_id,
    end: turn.end_event_id,
    basis: turn.timing_basis,
    estimatedStart: turn.estimated_start,
    estimatedEnd: turn.estimated_end,
  }, {
    start: 1n,
    end: 6n,
    basis: "paired_events",
    estimatedStart: true,
    estimatedEnd: true,
  });
  assert(tool);
  assertEquals(
    [tool.start_event_id, tool.end_event_id],
    [3n, 4n],
  );
});

Deno.test("a response-only Claude request remains a conservative open turn", () => {
  const turnId = "claude:request:request-later-batch";
  const spans = reduceActivity(SESSION, [
    event(1, {
      normalizer_version: "sherlock.claude-code-transcript.v1",
      event_kind: "reasoning",
      event_subtype: "thinking",
      turn_id: turnId,
      logical_event_key: "claude:reasoning:thinking-later-batch:block:0",
    }),
    event(2, {
      normalizer_version: "sherlock.claude-code-transcript.v1",
      event_kind: "message",
      event_subtype: "message",
      message_origin: "unknown",
      turn_id: turnId,
      logical_event_key: "claude:message:answer-later-batch",
    }),
  ]);

  assertEquals(spans.length, 1);
  assertEquals({
    kind: spans[0].activity_kind,
    state: spans[0].span_state,
    basis: spans[0].timing_basis,
    start: spans[0].start_event_id,
    end: spans[0].end_event_id,
  }, {
    kind: "turn",
    state: "detected_open",
    basis: "provisional",
    start: 1n,
    end: null,
  });
});

Deno.test("open, unpaired, missing, and out-of-order evidence stays conservative", () => {
  const spans = reduceActivity(SESSION, [
    event(1, {
      event_kind: "lifecycle",
      event_subtype: "turn_started",
      turn_id: "open-turn",
      occurred_at: null,
      observed_at: null,
      actor_role: "worker",
    }),
    event(2, {
      event_kind: "tool_call",
      tool_call_id: "open-call",
      tool_status: "in_progress",
      actor_role: "guardian",
    }),
    event(3, {
      event_kind: "tool_call",
      tool_call_id: "completed-call",
      tool_status: "completed",
      actor_role: "automation",
    }),
    event(4, {
      event_kind: "lifecycle",
      event_subtype: "turn_started",
      turn_id: "bad-order",
      occurred_at: "2026-08-15T00:01:00.000000Z",
    }),
    event(5, {
      event_kind: "lifecycle",
      event_subtype: "turn_complete",
      turn_id: "bad-order",
      occurred_at: "2026-08-15T00:00:30.000000Z",
    }),
  ]);

  const openTurn = spans.find((span) => span.span_key.includes("open-turn"));
  assert(openTurn);
  assertEquals({
    state: openTurn.span_state,
    basis: openTurn.timing_basis,
    role: openTurn.actor_role,
    estimatedStart: openTurn.estimated_start,
    estimatedEnd: openTurn.estimated_end,
  }, {
    state: "detected_open",
    basis: "provisional",
    role: "worker",
    estimatedStart: true,
    estimatedEnd: true,
  });
  const openTool = spans.find((span) => span.span_key.includes("open-call"));
  assertEquals(openTool?.span_state, "detected_open");
  assertEquals(openTool?.actor_role, "guardian");
  const completedTool = spans.find((span) =>
    span.span_key.includes("completed-call")
  );
  assertEquals(completedTool?.activity_kind, "point");
  assertEquals(completedTool?.actor_role, "automation");
  const badOrder = spans.find((span) => span.span_key.includes("bad-order"));
  assertEquals(badOrder?.activity_kind, "point");
  assertEquals(badOrder?.confidence, "inferred");
});

Deno.test("an unmatched task completion becomes an inferred point", () => {
  const spans = reduceActivity(SESSION, [event(1, {
    event_kind: "lifecycle",
    event_subtype: "task_complete",
    turn_id: null,
  })]);

  assertEquals(spans.length, 1);
  assertEquals({
    kind: spans[0].activity_kind,
    state: spans[0].span_state,
    basis: spans[0].timing_basis,
    start: spans[0].start_event_id,
    end: spans[0].end_event_id,
  }, {
    kind: "point",
    state: "active",
    basis: "point",
    start: 1n,
    end: null,
  });
});

Deno.test("equal-time task and tool pairs collapse once and retain evidence", () => {
  const timestamp = "2026-08-15T00:00:01.000000Z";
  const spans = reduceActivity(SESSION, [
    event(1, {
      event_kind: "lifecycle",
      event_subtype: "task_started",
      occurred_at: timestamp,
    }),
    event(2, {
      event_kind: "lifecycle",
      event_subtype: "task_complete",
      occurred_at: timestamp,
    }),
    event(3, {
      event_kind: "tool_call",
      tool_call_id: "equal-call",
      occurred_at: timestamp,
    }),
    event(4, {
      event_kind: "tool_result",
      tool_call_id: "equal-call",
      occurred_at: timestamp,
    }),
  ]);

  assertEquals(spans.length, 2);
  for (const span of spans) {
    assertEquals(span.activity_kind, "point");
    assertEquals(span.span_state, "active");
    assert(span.end_event_id !== null, "paired point must retain end evidence");
  }
  assertEquals(
    spans.map((span) => [span.start_event_id, span.end_event_id]),
    [[1n, 2n], [3n, 4n]],
  );
});

Deno.test("primary, worker, guardian, and automation sessions remain separate", () => {
  const roles = ["primary", "worker", "guardian", "automation"] as const;
  const spans = roles.map((role, index) => {
    const session = `00000000-0000-0000-0000-00000000001${index}`;
    return reduceActivity(session, [event(index + 1, {
      session_id: session,
      event_kind: "tool_call",
      tool_call_id: `call-${role}`,
      tool_status: "completed",
      actor_role: role,
    })])[0];
  });

  assertEquals(spans.map((span) => span.actor_role), roles);
  assert(new Set(spans.map((span) => span.span_key)).size === roles.length);
});
