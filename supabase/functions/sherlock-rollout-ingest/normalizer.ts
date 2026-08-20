import {
  type BatchManifest,
  type RecordLocator,
  sha256Hex,
} from "./contract.ts";

export const NORMALIZER_VERSION = "sherlock.codex-rollout.v1";
export const ROLE_VERSION = "sherlock.codex-role.v1";

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = Record<string, JsonValue>;
export type ActorRole =
  | "primary"
  | "worker"
  | "guardian"
  | "automation"
  | "unknown";

export interface SessionProjection {
  native_session_id: string;
  native_thread_id: string | null;
  parent_native_session_id: string | null;
  actor_role: ActorRole;
  role_version: typeof ROLE_VERSION;
  title: string | null;
  project_key: string | null;
  repo_remote: string | null;
  branch: string | null;
  cwd: string | null;
  model: string | null;
  started_at: string | null;
}

export interface EventProjection {
  record_index: number;
  projection_index: number;
  canonical_scope_key: string | null;
  logical_event_key: string | null;
  source_priority: number;
  event_kind: string;
  event_subtype: string | null;
  phase: string | null;
  actor_role: ActorRole;
  occurred_at: string | null;
  observed_at: string | null;
  native_item_id: string | null;
  turn_id: string | null;
  tool_call_id: string | null;
  message_role: string | null;
  message_origin: string | null;
  tool_name: string | null;
  tool_status: string | null;
  model: string | null;
  project_key: string | null;
  repo_remote: string | null;
  branch: string | null;
  cwd: string | null;
  usage_stream_key: string | null;
  usage_scope: string | null;
  usage_is_cumulative: boolean | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  error_code: string | null;
  content_sha256: string | null;
  content_byte_size: number | null;
  content_excerpt: string | null;
  attributes: JsonObject | null;
}

export interface BatchProjection {
  session: SessionProjection | null;
  events: EventProjection[];
}

interface ParsedRecord {
  locator: RecordLocator;
  envelope: JsonObject | null;
}

export async function projectBatch(
  manifest: BatchManifest,
  source: Uint8Array,
): Promise<BatchProjection> {
  const records = manifest.records.map((locator) => ({
    locator,
    // A transport fragment is deliberately not a JSON record. Preserve an
    // observable bounded projection without parsing partial native content.
    envelope: locator.parse_status === "fragment"
      ? null
      : parseEnvelope(recordBytes(manifest, source, locator)),
  }));
  const metaRecord = records.find((record) =>
    record.envelope?.type === "session_meta" &&
    objectValue(record.envelope.payload) !== null
  );
  const meta = objectValue(metaRecord?.envelope?.payload);
  const nativeSessionId = stringValue(meta?.id) ??
    manifest.observed_native_session_id;
  const declaredSessionId = stringValue(meta?.session_id);
  const parentNativeSessionId = stringValue(meta?.parent_thread_id) ??
    (declaredSessionId && declaredSessionId !== nativeSessionId
      ? declaredSessionId
      : null);
  const actorRole = meta ? actorRoleFromSource(meta.source) : "unknown";
  const turnContext = [...records].reverse().find((record) =>
    record.envelope?.type === "turn_context" &&
    objectValue(record.envelope.payload) !== null
  );
  const context = objectValue(turnContext?.envelope?.payload);
  const git = objectValue(meta?.git) ?? objectValue(context?.git);
  const session = nativeSessionId
    ? {
      native_session_id: nativeSessionId,
      native_thread_id: stringValue(meta?.thread_id),
      parent_native_session_id: parentNativeSessionId,
      actor_role: actorRole,
      role_version: ROLE_VERSION,
      title: stringValue(meta?.title),
      project_key: stringValue(context?.project_key) ??
        stringValue(meta?.project_key),
      repo_remote: stringValue(git?.repository_url) ??
        stringValue(context?.repo_remote),
      branch: stringValue(git?.branch) ?? stringValue(context?.branch),
      cwd: stringValue(context?.cwd) ?? stringValue(meta?.cwd),
      model: stringValue(context?.model) ?? stringValue(meta?.model),
      started_at: metaRecord?.locator.occurred_at ??
        manifest.first_occurred_at,
    } satisfies SessionProjection
    : null;

  const canonicalScopeKey = session
    ? `session:${session.native_session_id}`
    : `stream:${manifest.source_stream_key}`;
  const events = await Promise.all(
    records.map((record) => projectRecord(record, session, canonicalScopeKey)),
  );
  return { session, events };
}

async function projectRecord(
  record: ParsedRecord,
  session: SessionProjection | null,
  canonicalScopeKey: string,
): Promise<EventProjection> {
  const { locator, envelope } = record;
  const payload = objectValue(envelope?.payload);
  const base: EventProjection = {
    record_index: locator.record_index,
    projection_index: 0,
    canonical_scope_key: canonicalScopeKey,
    logical_event_key: null,
    source_priority: 100,
    event_kind: "unknown",
    event_subtype: locator.native_payload_type ?? locator.native_type,
    phase: null,
    actor_role: session?.actor_role ?? "unknown",
    occurred_at: locator.occurred_at,
    observed_at: locator.occurred_at,
    native_item_id: stringValue(payload?.id),
    turn_id: stringValue(payload?.turn_id),
    tool_call_id: stringValue(payload?.call_id),
    message_role: null,
    message_origin: null,
    tool_name: null,
    tool_status: stringValue(payload?.status),
    model: session?.model ?? null,
    project_key: session?.project_key ?? null,
    repo_remote: session?.repo_remote ?? null,
    branch: session?.branch ?? null,
    cwd: session?.cwd ?? null,
    usage_stream_key: null,
    usage_scope: null,
    usage_is_cumulative: null,
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    total_tokens: null,
    error_code: null,
    content_sha256: null,
    content_byte_size: null,
    content_excerpt: null,
    attributes: null,
  };
  if (locator.parse_status !== "ok" || envelope === null) {
    return {
      ...base,
      error_code: `native_${locator.parse_status}`,
    };
  }

  const nativeType = stringValue(envelope.type);
  const payloadType = stringValue(payload?.type);
  if (nativeType === "session_meta" || nativeType === "turn_context") {
    return {
      ...base,
      event_kind: "lifecycle",
      event_subtype: nativeType,
      model: stringValue(payload?.model) ?? base.model,
      cwd: stringValue(payload?.cwd) ?? base.cwd,
    };
  }
  if (nativeType === "event_msg") {
    return await projectEventMessage(base, payloadType, payload);
  }
  if (nativeType === "response_item") {
    return await projectResponseItem(base, payloadType, payload);
  }
  return base;
}

async function projectEventMessage(
  base: EventProjection,
  payloadType: string | null,
  payload: JsonObject | null,
): Promise<EventProjection> {
  if (payloadType === "user_message" || payloadType === "agent_message") {
    const content = stringValue(payload?.message);
    const role = payloadType === "user_message" ? "user" : "assistant";
    return {
      ...base,
      ...(await messageFields(content)),
      event_kind: payloadType === "user_message" ? "message" : "agent_message",
      event_subtype: payloadType,
      message_role: role,
      message_origin: role === "user"
        ? "human"
        : assistantMessageOrigin(base.actor_role),
      logical_event_key: messageLogicalKey(base, role),
    };
  }
  if (payloadType === "token_count") {
    const usage = cumulativeUsage(payload);
    if (!usage) {
      return { ...base, error_code: "invalid_token_count" };
    }
    return {
      ...base,
      ...usage,
      event_kind: "usage",
      event_subtype: payloadType,
      usage_stream_key: base.canonical_scope_key,
      usage_scope: "session",
      usage_is_cumulative: true,
    };
  }
  if (
    payloadType === "task_started" || payloadType === "task_complete" ||
    payloadType === "turn_started" || payloadType === "turn_complete"
  ) {
    return { ...base, event_kind: "lifecycle", event_subtype: payloadType };
  }
  if (payloadType === "tool_output") {
    return { ...base, event_kind: "tool_result", event_subtype: payloadType };
  }
  if (payloadType === "error") {
    return {
      ...base,
      event_kind: "error",
      event_subtype: payloadType,
      error_code: stringValue(payload?.code) ?? "native_error",
    };
  }
  return base;
}

async function projectResponseItem(
  base: EventProjection,
  payloadType: string | null,
  payload: JsonObject | null,
): Promise<EventProjection> {
  if (payloadType === "message") {
    const role = stringValue(payload?.role);
    if (role !== "user" && role !== "assistant") {
      return {
        ...base,
        event_kind: "ignored",
        event_subtype: `message:${role ?? "unknown"}`,
      };
    }
    const content = messageText(payload?.content);
    return {
      ...base,
      ...(await messageFields(content)),
      event_kind: "message",
      event_subtype: payloadType,
      phase: stringValue(payload?.phase),
      message_role: role,
      message_origin: role === "user"
        ? "human"
        : assistantMessageOrigin(base.actor_role),
      source_priority: role === "user" ? 50 : 100,
      logical_event_key: messageLogicalKey(base, role),
    };
  }
  if (payloadType === "reasoning") {
    return { ...base, event_kind: "reasoning", event_subtype: payloadType };
  }
  if (
    payloadType === "function_call" || payloadType === "custom_tool_call" ||
    payloadType === "local_shell_call" || payloadType === "computer_call" ||
    payloadType === "web_search_call"
  ) {
    return {
      ...base,
      event_kind: "tool_call",
      event_subtype: payloadType,
      tool_name: stringValue(payload?.name) ?? payloadType,
    };
  }
  if (
    payloadType === "function_call_output" ||
    payloadType === "custom_tool_call_output" ||
    payloadType === "local_shell_call_output" ||
    payloadType === "computer_call_output"
  ) {
    return {
      ...base,
      event_kind: "tool_result",
      event_subtype: payloadType,
      tool_name: stringValue(payload?.name),
    };
  }
  return base;
}

function cumulativeUsage(
  payload: JsonObject | null,
): Partial<EventProjection> | null {
  const info = objectValue(payload?.info);
  const total = objectValue(info?.total_token_usage);
  const rawInput = nonNegativeInteger(total?.input_tokens);
  const cached = optionalNonNegativeInteger(total, "cached_input_tokens");
  const rawOutput = nonNegativeInteger(total?.output_tokens);
  const reasoning = optionalNonNegativeInteger(
    total,
    "reasoning_output_tokens",
  );
  const totalTokens = nonNegativeInteger(total?.total_tokens);
  if (
    rawInput === null || cached === null || rawOutput === null ||
    reasoning === null || totalTokens === null || cached > rawInput ||
    reasoning > rawOutput || rawInput + rawOutput !== totalTokens
  ) return null;
  const contextWindow = nonNegativeInteger(info?.model_context_window);
  return {
    input_tokens: rawInput - cached,
    cached_input_tokens: cached,
    output_tokens: rawOutput - reasoning,
    reasoning_tokens: reasoning,
    total_tokens: totalTokens,
    attributes: contextWindow === null
      ? null
      : { model_context_window: contextWindow },
  };
}

function messageLogicalKey(base: EventProjection, role: string): string | null {
  if (!base.turn_id) return null;
  if (role === "user") return `message:user:${base.turn_id}`;
  const suffix = base.native_item_id ?? base.phase;
  return suffix ? `message:assistant:${base.turn_id}:${suffix}` : null;
}

async function messageFields(
  content: string | null,
): Promise<Partial<EventProjection>> {
  if (!content) return { error_code: "empty_message_content" };
  const bytes = new TextEncoder().encode(content);
  return {
    content_sha256: await sha256Hex(bytes),
    content_byte_size: bytes.byteLength,
    content_excerpt: utf8Excerpt(bytes, 1024),
  };
}

function utf8Excerpt(bytes: Uint8Array, maximum: number): string {
  if (bytes.byteLength <= maximum) return new TextDecoder().decode(bytes);
  let end = maximum;
  while (end > 0) {
    const value = new TextDecoder().decode(bytes.slice(0, end));
    if (new TextEncoder().encode(value).byteLength <= maximum) return value;
    end -= 1;
  }
  return "";
}

function recordBytes(
  manifest: BatchManifest,
  source: Uint8Array,
  locator: RecordLocator,
): Uint8Array {
  const start = locator.source_start_offset - manifest.start_offset;
  const end = locator.source_end_offset - manifest.start_offset;
  let trimmedEnd = end;
  while (
    trimmedEnd > start &&
    (source[trimmedEnd - 1] === 10 || source[trimmedEnd - 1] === 13)
  ) trimmedEnd -= 1;
  return source.slice(start, trimmedEnd);
}

function parseEnvelope(bytes: Uint8Array): JsonObject | null {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return objectValue(value);
  } catch {
    return null;
  }
}

function actorRoleFromSource(source: unknown): ActorRole {
  const object = objectValue(source);
  if (object && objectValue(object.subagent)) {
    return JSON.stringify(object.subagent).toLowerCase().includes("guardian")
      ? "guardian"
      : "worker";
  }
  const text = stringValue(source)?.toLowerCase();
  if (text?.includes("automation")) return "automation";
  return text || source === undefined || source === null
    ? "primary"
    : "unknown";
}

function assistantMessageOrigin(role: ActorRole): "worker" | "unknown" {
  return role === "worker" || role === "guardian" || role === "automation"
    ? "worker"
    : "unknown";
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}

function optionalNonNegativeInteger(
  object: JsonObject | null,
  key: string,
): number | null {
  if (!object || object[key] === undefined) return 0;
  return nonNegativeInteger(object[key]);
}

function messageText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((item) => {
    if (typeof item === "string") return [item];
    const value = objectValue(item);
    const type = stringValue(value?.type);
    const text = stringValue(value?.text);
    return text &&
        (type === "input_text" || type === "output_text" || type === "text")
      ? [text]
      : [];
  });
  return parts.length ? parts.join("\n") : null;
}
