export const ACTIVITY_VERSION = "sherlock.activity.v1";
export const POINT_DURATION_MICROS = 1_000_000n;

export type ActorRole =
  | "primary"
  | "worker"
  | "guardian"
  | "automation"
  | "unknown";

export interface ActivityEvent {
  id: bigint;
  workspace_id: string;
  session_id: string;
  normalizer_version: string;
  canonical_scope_key: string | null;
  logical_event_key: string | null;
  source_priority: number;
  is_replay: boolean;
  event_kind: string;
  event_subtype: string | null;
  phase: string | null;
  actor_role: ActorRole | null;
  occurred_at: string | null;
  observed_at: string | null;
  server_received_at: string;
  turn_id: string | null;
  tool_call_id: string | null;
  tool_status: string | null;
  message_origin: string | null;
  project_key: string | null;
}

export interface ActivitySpan {
  span_key: string;
  started_at: string;
  ended_at: string;
  span_state: "active" | "detected_open";
  activity_kind: "turn" | "tool" | "point";
  timing_basis: "lifecycle" | "paired_events" | "point" | "provisional";
  confidence: "exact" | "inferred";
  estimated_start: boolean;
  estimated_end: boolean;
  actor_role: ActorRole;
  project_key: string | null;
  start_event_id: bigint;
  end_event_id: bigint | null;
}

interface TimedEvent {
  event: ActivityEvent;
  micros: bigint;
  estimated: boolean;
}

/**
 * Canonical selection is intentionally narrow. Keyed events select one winner
 * per scope/logical-key/kind; unkeyed facts remain independent source facts.
 */
export function canonicalizeEvents(
  events: readonly ActivityEvent[],
): ActivityEvent[] {
  const winners = new Map<string, ActivityEvent>();
  const unkeyed: ActivityEvent[] = [];
  for (const event of events) {
    if (event.is_replay) continue;
    if (!event.canonical_scope_key || !event.logical_event_key) {
      unkeyed.push(event);
      continue;
    }
    const key = JSON.stringify([
      event.session_id,
      event.canonical_scope_key,
      event.normalizer_version,
      event.logical_event_key,
      event.event_kind,
    ]);
    const current = winners.get(key);
    if (!current || compareCanonical(event, current) < 0) {
      winners.set(key, event);
    }
  }
  return [...unkeyed, ...winners.values()].sort(compareEvidence);
}

export function reduceActivity(
  sessionId: string,
  events: readonly ActivityEvent[],
): ActivitySpan[] {
  const canonical = canonicalizeEvents(events);
  const spans = [
    ...reduceTurns(sessionId, canonical),
    ...reduceUnkeyedTasks(sessionId, canonical),
    ...reduceTools(sessionId, canonical),
  ];
  return spans.sort((left, right) =>
    left.span_key.localeCompare(right.span_key) ||
    left.started_at.localeCompare(right.started_at)
  );
}

function reduceTurns(
  sessionId: string,
  events: readonly ActivityEvent[],
): ActivitySpan[] {
  const turns = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    if (!event.turn_id || !isTurnEvidence(event)) continue;
    const current = turns.get(event.turn_id) ?? [];
    current.push(event);
    turns.set(event.turn_id, current);
  }
  return [...turns.entries()].flatMap(([turnId, evidence]) => {
    const timed = timedEvents(evidence);
    if (timed.length === 0) return [];
    const lifecycleStart = timed.find(({ event }) =>
      event.event_kind === "lifecycle" &&
      (event.event_subtype === "turn_started" ||
        event.event_subtype === "task_started")
    );
    const humanStart = timed.find(({ event }) =>
      event.event_kind === "message" && event.message_origin === "human"
    );
    const start = lifecycleStart ?? humanStart ?? timed[0];
    const terminals = timed.filter(({ event }) =>
      event.event_kind === "lifecycle" &&
        (event.event_subtype === "turn_complete" ||
          event.event_subtype === "task_complete") ||
      event.message_origin !== "human" && event.phase === "final_answer"
    );
    const end = terminals.at(-1) ?? null;
    return [turnSpan(sessionId, `turn:${keyPart(turnId)}`, start, end)];
  });
}

function reduceUnkeyedTasks(
  sessionId: string,
  events: readonly ActivityEvent[],
): ActivitySpan[] {
  const lifecycle = timedEvents(
    events.filter((event) =>
      !event.turn_id && event.event_kind === "lifecycle" &&
      (event.event_subtype === "task_started" ||
        event.event_subtype === "task_complete")
    ),
  );
  const starts = lifecycle.filter(({ event }) =>
    event.event_subtype === "task_started"
  );
  const completions = lifecycle.filter(({ event }) =>
    event.event_subtype === "task_complete"
  );
  const used = new Set<bigint>();
  const pairedOrOpen = starts.map((start) => {
    const end = completions.find((candidate) =>
      !used.has(candidate.event.id) &&
      (candidate.micros > start.micros ||
        candidate.micros === start.micros &&
          candidate.event.id > start.event.id)
    ) ?? null;
    if (end) {
      used.add(end.event.id);
    }
    return turnSpan(
      sessionId,
      `task:${start.event.id.toString()}`,
      start,
      end,
    );
  });
  const unmatchedCompletions = completions
    .filter((completion) => !used.has(completion.event.id))
    .map((completion) =>
      pointSpan(
        spanIdentity(
          sessionId,
          `task-complete:${completion.event.id.toString()}`,
        ),
        completion,
        "active",
        "point",
      )
    );
  return [...pairedOrOpen, ...unmatchedCompletions];
}

function reduceTools(
  sessionId: string,
  events: readonly ActivityEvent[],
): ActivitySpan[] {
  const groups = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    if (
      event.event_kind !== "tool_call" && event.event_kind !== "tool_result"
    ) {
      continue;
    }
    const identity = event.tool_call_id
      ? `call:${keyPart(event.tool_call_id)}`
      : `event:${event.id.toString()}`;
    const current = groups.get(identity) ?? [];
    current.push(event);
    groups.set(identity, current);
  }
  return [...groups.entries()].flatMap(([identity, evidence]) => {
    const timed = timedEvents(evidence);
    if (timed.length === 0) return [];
    const call = timed.find(({ event }) => event.event_kind === "tool_call") ??
      null;
    const result = call
      ? timed.find(({ event, micros }) =>
        event.event_kind === "tool_result" && micros > call.micros
      ) ?? timed.find(({ event }) => event.event_kind === "tool_result") ?? null
      : timed.find(({ event }) => event.event_kind === "tool_result") ?? null;
    const anchor = call ?? result;
    if (!anchor) return [];
    const spanKey = spanIdentity(sessionId, `tool:${identity}`);
    if (call && result && result.micros > call.micros) {
      return [
        {
          span_key: spanKey,
          started_at: formatMicros(call.micros),
          ended_at: formatMicros(result.micros),
          span_state: "active",
          activity_kind: "tool",
          timing_basis: "paired_events",
          confidence: "inferred",
          estimated_start: call.estimated,
          estimated_end: result.estimated,
          actor_role: roleFrom(call.event),
          project_key: call.event.project_key ?? result.event.project_key,
          start_event_id: call.event.id,
          end_event_id: result.event.id,
        } satisfies ActivitySpan,
      ];
    }
    const detectedOpen = call !== null && result === null &&
      call.event.tool_status !== "completed";
    return [pointSpan(
      spanKey,
      anchor,
      detectedOpen ? "detected_open" : "active",
      detectedOpen ? "tool" : "point",
      call && result ? result.event.id : null,
    )];
  });
}

function turnSpan(
  sessionId: string,
  identity: string,
  start: TimedEvent,
  end: TimedEvent | null,
): ActivitySpan {
  const spanKey = spanIdentity(sessionId, identity);
  if (!end) {
    return pointSpan(spanKey, start, "detected_open", "turn");
  }
  if (end.micros <= start.micros) {
    return pointSpan(spanKey, start, "active", "point", end.event.id);
  }
  const exactLifecycle = start.event.event_kind === "lifecycle" &&
    end.event.event_kind === "lifecycle" &&
    !start.estimated && !end.estimated;
  return {
    span_key: spanKey,
    started_at: formatMicros(start.micros),
    ended_at: formatMicros(end.micros),
    span_state: "active",
    activity_kind: "turn",
    timing_basis: exactLifecycle ? "lifecycle" : "paired_events",
    confidence: "inferred",
    estimated_start: start.estimated || !exactLifecycle,
    estimated_end: end.estimated || !exactLifecycle,
    actor_role: roleFrom(start.event),
    project_key: start.event.project_key ?? end.event.project_key,
    start_event_id: start.event.id,
    end_event_id: end.event.id,
  };
}

function pointSpan(
  spanKey: string,
  anchor: TimedEvent,
  state: "active" | "detected_open",
  kind: "turn" | "tool" | "point",
  endEventId: bigint | null = null,
): ActivitySpan {
  return {
    span_key: spanKey,
    started_at: formatMicros(anchor.micros),
    ended_at: formatMicros(anchor.micros + POINT_DURATION_MICROS),
    span_state: state,
    activity_kind: kind,
    timing_basis: state === "detected_open" ? "provisional" : "point",
    confidence: "inferred",
    estimated_start: anchor.estimated,
    estimated_end: true,
    actor_role: roleFrom(anchor.event),
    project_key: anchor.event.project_key,
    start_event_id: anchor.event.id,
    end_event_id: endEventId,
  };
}

function isTurnEvidence(event: ActivityEvent): boolean {
  return event.event_kind === "message" ||
    event.event_kind === "agent_message" ||
    event.event_kind === "reasoning" ||
    event.event_kind === "tool_call" ||
    event.event_kind === "tool_result" ||
    event.event_kind === "lifecycle" ||
    event.event_kind === "error";
}

function timedEvents(events: readonly ActivityEvent[]): TimedEvent[] {
  return events.flatMap((event) => {
    const source = event.occurred_at ?? event.observed_at ??
      event.server_received_at;
    const micros = parseMicros(source);
    return micros === null ? [] : [{
      event,
      micros,
      estimated: event.occurred_at === null,
    }];
  }).sort((left, right) =>
    compareBigInt(left.micros, right.micros) ||
    compareBigInt(left.event.id, right.event.id)
  );
}

function compareCanonical(left: ActivityEvent, right: ActivityEvent): number {
  if (left.source_priority !== right.source_priority) {
    return right.source_priority - left.source_priority;
  }
  const leftTime = left.occurred_at === null
    ? null
    : parseMicros(left.occurred_at);
  const rightTime = right.occurred_at === null
    ? null
    : parseMicros(right.occurred_at);
  if (leftTime === null && rightTime !== null) return 1;
  if (leftTime !== null && rightTime === null) return -1;
  if (leftTime !== null && rightTime !== null) {
    const timeOrder = compareBigInt(leftTime, rightTime);
    if (timeOrder !== 0) return timeOrder;
  }
  return compareBigInt(left.id, right.id);
}

function compareEvidence(left: ActivityEvent, right: ActivityEvent): number {
  const leftTime = parseMicros(
    left.occurred_at ?? left.observed_at ?? left.server_received_at,
  );
  const rightTime = parseMicros(
    right.occurred_at ?? right.observed_at ?? right.server_received_at,
  );
  if (leftTime !== null && rightTime !== null) {
    const timeOrder = compareBigInt(leftTime, rightTime);
    if (timeOrder !== 0) return timeOrder;
  }
  return compareBigInt(left.id, right.id);
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function roleFrom(event: ActivityEvent): ActorRole {
  return event.actor_role ?? "unknown";
}

function spanIdentity(sessionId: string, identity: string): string {
  return `session:${sessionId}:${identity}`;
}

function keyPart(value: string): string {
  return encodeURIComponent(value);
}

export function parseMicros(value: string): bigint | null {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/,
  );
  if (!match) return null;
  const milliseconds = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return BigInt(milliseconds) * 1_000n + BigInt(fraction || "0");
}

export function formatMicros(value: bigint): string {
  const milliseconds = value / 1_000n;
  const micros = (value % 1_000_000n).toString().padStart(6, "0");
  return new Date(Number(milliseconds)).toISOString().replace(
    /\.\d{3}Z$/,
    `.${micros}Z`,
  );
}
