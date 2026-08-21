import {
  type BatchManifest,
  type RecordLocator,
  sha256Hex,
} from "./contract.ts";

export const NORMALIZER_VERSION = "sherlock.codex-rollout.v1";
export const ROLE_VERSION = "sherlock.codex-role.v1";
export const CLAUDE_NORMALIZER_VERSION = "sherlock.claude-code-transcript.v1";
export const CLAUDE_ROLE_VERSION = "sherlock.claude-code-role.v1";
export const SCM_VERSION = "sherlock.github-scm.v1";

const CLAUDE_HOOK_SCHEMA_VERSION = "sherlock.claude-hook.v1";
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT_SHA = /^[0-9a-f]{40}$/;
const GITHUB_REPOSITORY_PART = /^[a-z0-9_.-]+$/;

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
  role_version: string;
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
  parent_native_item_id: string | null;
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

export interface ScmProjection {
  record_index: number;
  scm_version: string;
  projection_status: "matched" | "no_match";
  repository_full_name: string | null;
  commit_sha: string | null;
  observed_at: string | null;
}

export interface BatchProjection {
  session: SessionProjection | null;
  events: EventProjection[];
  scm_projections: ScmProjection[];
}

interface ParsedRecord {
  locator: RecordLocator;
  envelope: JsonObject | null;
}

export async function projectBatch(
  manifest: BatchManifest,
  source: Uint8Array,
): Promise<BatchProjection> {
  const projection = manifest.source_provider === "claude_code"
    ? manifest.source_kind === "hook"
      ? await projectClaudeHookBatch(manifest, source)
      : await projectClaudeBatch(manifest, source)
    : await projectCodexBatch(manifest, source);
  const byRecord = new Map(
    projection.scm_projections.map((item) => [item.record_index, item]),
  );
  return {
    ...projection,
    scm_projections: manifest.records
      .filter(({ native_type }) => native_type === "session_meta")
      .map((record) =>
        byRecord.get(record.record_index) ?? {
          record_index: record.record_index,
          scm_version: SCM_VERSION,
          projection_status: "no_match",
          repository_full_name: null,
          commit_sha: null,
          observed_at: null,
        }
      ),
  };
}

export function normalizerVersionFor(manifest: BatchManifest): string {
  return manifest.source_provider === "claude_code"
    ? CLAUDE_NORMALIZER_VERSION
    : NORMALIZER_VERSION;
}

export function githubRepositoryFullName(value: unknown): string | null {
  const remote = stringValue(value);
  if (!remote) return null;
  const prefixes = [
    "https://github.com/",
    "ssh://git@github.com/",
    "git@github.com:",
  ];
  const prefix = prefixes.find((candidate) =>
    remote.toLowerCase().startsWith(candidate)
  );
  if (!prefix) return null;
  let path = remote.slice(prefix.length);
  if (path.endsWith("/")) path = path.slice(0, -1);
  if (path.toLowerCase().endsWith(".git")) path = path.slice(0, -4);
  const parts = path.toLowerCase().split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) =>
      !GITHUB_REPOSITORY_PART.test(part) || part === "." || part === ".."
    )
  ) return null;
  return parts.join("/");
}

async function projectClaudeHookBatch(
  manifest: BatchManifest,
  source: Uint8Array,
): Promise<BatchProjection> {
  const records = manifest.records.map((locator) => ({
    locator,
    envelope: parseEnvelope(recordBytes(manifest, source, locator)),
  }));
  const nativeSessionId = manifest.observed_native_session_id;
  const parentNativeSessionId = manifest.observed_parent_native_session_id;
  const actorRole: ActorRole = parentNativeSessionId
    ? "worker"
    : nativeSessionId
    ? "primary"
    : "unknown";
  const session = nativeSessionId
    ? {
      native_session_id: nativeSessionId,
      native_thread_id: null,
      parent_native_session_id: parentNativeSessionId,
      actor_role: actorRole,
      role_version: CLAUDE_ROLE_VERSION,
      title: null,
      project_key: null,
      repo_remote: null,
      branch: null,
      cwd: null,
      model: null,
      started_at: manifest.first_occurred_at,
    } satisfies SessionProjection
    : null;
  const canonicalScopeKey = session
    ? `session:${session.native_session_id}`
    : `stream:${manifest.source_stream_key}`;
  const projected = await Promise.all(
    records.map((record) =>
      projectClaudeHookRecord(record, session, canonicalScopeKey)
    ),
  );
  return { session, events: projected, scm_projections: [] };
}

async function projectClaudeHookRecord(
  record: ParsedRecord,
  session: SessionProjection | null,
  canonicalScopeKey: string,
): Promise<EventProjection> {
  const { locator, envelope } = record;
  const base: EventProjection = {
    record_index: locator.record_index,
    projection_index: 0,
    canonical_scope_key: canonicalScopeKey,
    logical_event_key: null,
    source_priority: 120,
    event_kind: "lifecycle",
    event_subtype: "hook_invalid",
    phase: null,
    actor_role: session?.actor_role ?? "unknown",
    occurred_at: locator.occurred_at,
    observed_at: locator.occurred_at,
    native_item_id: null,
    parent_native_item_id: null,
    turn_id: null,
    tool_call_id: null,
    message_role: null,
    message_origin: null,
    tool_name: null,
    tool_status: null,
    model: null,
    project_key: null,
    repo_remote: null,
    branch: null,
    cwd: null,
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
    return { ...base, error_code: `native_${locator.parse_status}` };
  }

  const validation = await validateClaudeHookEnvelope(envelope, session);
  if (!validation.valid) {
    return { ...base, error_code: validation.error };
  }
  const {
    dispatchEventName,
    payloadSha256,
    payload,
    collectorObservedAt,
    transcriptByteCount,
    transcriptSha256,
  } = validation;
  const attributes: JsonObject = {
    dispatch_event_name: dispatchEventName,
    payload_sha256: payloadSha256,
  };
  if (transcriptByteCount !== null) {
    attributes.transcript_byte_count = transcriptByteCount;
  }
  if (transcriptSha256 !== null) {
    attributes.transcript_sha256 = transcriptSha256;
  }
  if (dispatchEventName === "SessionEnd") {
    const reason = stringValue(payload.reason);
    if (
      reason && [
        "clear",
        "resume",
        "logout",
        "prompt_input_exit",
        "bypass_permissions_disabled",
        "other",
      ].includes(reason)
    ) attributes.reason = reason;
    return {
      ...base,
      observed_at: collectorObservedAt,
      event_subtype: "session_end",
      logical_event_key: `claude:hook:${payloadSha256}`,
      native_item_id: null,
      attributes,
    };
  }

  const terminalAssistantUuid = stringValue(envelope.terminal_assistant_uuid);
  const turnAnchorId = stringValue(envelope.turn_anchor_id);
  const hasAuditableTurnBinding = terminalAssistantUuid !== null &&
    CANONICAL_UUID.test(terminalAssistantUuid) &&
    turnAnchorId !== null && CANONICAL_UUID.test(turnAnchorId) &&
    transcriptByteCount !== null && transcriptSha256 !== null;
  if (!hasAuditableTurnBinding) {
    return {
      ...base,
      observed_at: collectorObservedAt,
      event_subtype: "response_complete_unlinked",
      logical_event_key: `claude:hook:${payloadSha256}`,
      native_item_id: CANONICAL_UUID.test(terminalAssistantUuid ?? "")
        ? terminalAssistantUuid
        : null,
      attributes,
    };
  }
  return {
    ...base,
    observed_at: collectorObservedAt,
    event_subtype: "turn_complete",
    logical_event_key:
      `claude:lifecycle:${terminalAssistantUuid}:turn_complete`,
    native_item_id: terminalAssistantUuid,
    turn_id: `claude:prompt:${turnAnchorId}`,
    attributes,
  };
}

type ClaudeHookValidation = {
  valid: true;
  dispatchEventName: "Stop" | "SubagentStop" | "SessionEnd";
  payloadSha256: string;
  payload: JsonObject;
  collectorObservedAt: string;
  transcriptByteCount: number | null;
  transcriptSha256: string | null;
} | { valid: false; error: string };

async function validateClaudeHookEnvelope(
  envelope: JsonObject,
  session: SessionProjection | null,
): Promise<ClaudeHookValidation> {
  if (
    stringValue(envelope.type) !== "claude_hook" ||
    stringValue(envelope.schema_version) !== CLAUDE_HOOK_SCHEMA_VERSION
  ) return { valid: false, error: "invalid_claude_hook_schema" };
  const collectorObservedAt = utcTimestamp(envelope.collector_observed_at);
  if (collectorObservedAt === null) {
    return { valid: false, error: "invalid_claude_hook_observed_at" };
  }
  const dispatchEventName = stringValue(envelope.dispatch_event_name);
  if (
    dispatchEventName !== "Stop" && dispatchEventName !== "SubagentStop" &&
    dispatchEventName !== "SessionEnd"
  ) return { valid: false, error: "invalid_claude_hook_event" };
  const payloadSha256 = stringValue(envelope.payload_sha256);
  const payloadBase64 = stringValue(envelope.payload_base64);
  if (!payloadSha256 || !SHA256.test(payloadSha256) || !payloadBase64) {
    return { valid: false, error: "invalid_claude_hook_payload" };
  }
  const payloadBytes = decodeBase64Bytes(payloadBase64);
  if (!payloadBytes || await sha256Hex(payloadBytes) !== payloadSha256) {
    return { valid: false, error: "invalid_claude_hook_payload_hash" };
  }
  const payload = parseEnvelope(payloadBytes);
  if (!payload || stringValue(payload.hook_event_name) !== dispatchEventName) {
    return { valid: false, error: "invalid_claude_hook_payload_event" };
  }
  const nativeSessionId = stringValue(envelope.native_session_id);
  const parentNativeSessionId = stringValue(envelope.parent_native_session_id);
  const payloadSessionId = stringValue(payload.session_id);
  const expectedNativeSessionId = dispatchEventName === "SubagentStop"
    ? stringValue(payload.agent_id)
    : payloadSessionId;
  const expectedParentSessionId = dispatchEventName === "SubagentStop"
    ? payloadSessionId
    : null;
  if (
    nativeSessionId === null || nativeSessionId !== expectedNativeSessionId ||
    parentNativeSessionId !== expectedParentSessionId ||
    nativeSessionId !== session?.native_session_id ||
    parentNativeSessionId !== session.parent_native_session_id
  ) return { valid: false, error: "invalid_claude_hook_session" };
  const transcriptByteCount = nonNegativeInteger(
    envelope.transcript_byte_count,
  );
  const transcriptSha256 = stringValue(envelope.transcript_sha256);
  if (
    (transcriptByteCount === null) !== (transcriptSha256 === null) ||
    (transcriptSha256 !== null && !SHA256.test(transcriptSha256))
  ) return { valid: false, error: "invalid_claude_hook_transcript" };
  const terminalAssistantUuid = stringValue(envelope.terminal_assistant_uuid);
  const turnAnchorId = stringValue(envelope.turn_anchor_id);
  if (
    (terminalAssistantUuid !== null &&
      !CANONICAL_UUID.test(terminalAssistantUuid)) ||
    (turnAnchorId !== null && !CANONICAL_UUID.test(turnAnchorId)) ||
    dispatchEventName === "SessionEnd" &&
      (terminalAssistantUuid !== null || turnAnchorId !== null)
  ) return { valid: false, error: "invalid_claude_hook_anchor" };
  if (
    terminalAssistantUuid !== null &&
    (transcriptByteCount === null || transcriptByteCount === 0)
  ) return { valid: false, error: "invalid_claude_hook_transcript" };
  return {
    valid: true,
    dispatchEventName,
    payloadSha256,
    payload,
    collectorObservedAt,
    transcriptByteCount,
    transcriptSha256,
  };
}

function utcTimestamp(value: unknown): string | null {
  const candidate = stringValue(value);
  const match = candidate &&
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/
      .exec(candidate);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    year < 1 || parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour || parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second
  ) return null;
  return candidate;
}

function decodeBase64Bytes(value: string): Uint8Array | null {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function projectCodexBatch(
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
    record.locator.native_type === "session_meta" &&
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
  const metaGit = objectValue(meta?.git);
  const commitSha = stringValue(metaGit?.commit_hash)?.toLowerCase() ?? null;
  const repositoryFullName = githubRepositoryFullName(
    metaGit?.repository_url,
  );
  const observedAt = metaRecord?.locator.occurred_at ??
    manifest.first_occurred_at;
  const scmMatched = Boolean(
    session && observedAt && commitSha && GIT_COMMIT_SHA.test(commitSha) &&
      repositoryFullName,
  );
  const scmProjections = metaRecord
    ? [
      {
        record_index: metaRecord.locator.record_index,
        scm_version: SCM_VERSION,
        projection_status: scmMatched ? "matched" : "no_match",
        repository_full_name: scmMatched ? repositoryFullName : null,
        commit_sha: scmMatched ? commitSha : null,
        observed_at: scmMatched ? observedAt : null,
      } satisfies ScmProjection,
    ]
    : [];
  return { session, events, scm_projections: scmProjections };
}

async function projectClaudeBatch(
  manifest: BatchManifest,
  source: Uint8Array,
): Promise<BatchProjection> {
  const records = manifest.records.map((locator) => ({
    locator,
    // A transport fragment is opaque source evidence, never a partial Claude
    // envelope. Provider-native interpretation starts only after reassembly.
    envelope: locator.parse_status === "fragment"
      ? null
      : parseEnvelope(recordBytes(manifest, source, locator)),
  }));
  const envelopes = records.flatMap((record) =>
    record.envelope ? [record.envelope] : []
  );
  const first = envelopes[0] ?? null;
  const latest =
    [...envelopes].reverse().find((envelope) =>
      stringValue(envelope.cwd) !== null ||
      stringValue(envelope.gitBranch) !== null
    ) ?? first;
  const assistant = envelopes.find((envelope) =>
    stringValue(envelope.type) === "assistant" &&
    objectValue(envelope.message) !== null
  );
  const assistantMessage = objectValue(assistant?.message);
  const declaredSessionId = stringValue(first?.sessionId) ??
    stringValue(first?.session_id);
  const declaredAgentId = stringValue(first?.agentId) ??
    stringValue(first?.agent_id);
  const nativeSessionId = manifest.observed_native_session_id ??
    declaredAgentId ?? declaredSessionId;
  const parentNativeSessionId = manifest.observed_parent_native_session_id ??
    (declaredAgentId && declaredSessionId !== nativeSessionId
      ? declaredSessionId
      : null);
  const actorRole: ActorRole =
    parentNativeSessionId || first?.isSidechain === true
      ? "worker"
      : nativeSessionId
      ? "primary"
      : "unknown";
  const session = nativeSessionId
    ? {
      native_session_id: nativeSessionId,
      native_thread_id: null,
      parent_native_session_id: parentNativeSessionId,
      actor_role: actorRole,
      role_version: CLAUDE_ROLE_VERSION,
      title: stringValue(first?.customTitle),
      project_key: null,
      repo_remote: null,
      branch: stringValue(latest?.gitBranch),
      cwd: stringValue(latest?.cwd),
      model: stringValue(assistantMessage?.model),
      started_at: manifest.first_occurred_at,
    } satisfies SessionProjection
    : null;
  const canonicalScopeKey = session
    ? `session:${session.native_session_id}`
    : `stream:${manifest.source_stream_key}`;
  const turnIds = claudeTurnIds(records);
  const projected = await Promise.all(
    records.map((record) =>
      projectClaudeRecord(
        record,
        session,
        canonicalScopeKey,
        turnIds.get(record.locator.record_index) ?? null,
      )
    ),
  );
  return { session, events: projected.flat(), scm_projections: [] };
}

async function projectClaudeRecord(
  record: ParsedRecord,
  session: SessionProjection | null,
  canonicalScopeKey: string,
  turnId: string | null,
): Promise<EventProjection[]> {
  const { locator, envelope } = record;
  const message = objectValue(envelope?.message);
  const nativeType = stringValue(envelope?.type);
  const base: EventProjection = {
    record_index: locator.record_index,
    projection_index: 0,
    canonical_scope_key: canonicalScopeKey,
    logical_event_key: null,
    source_priority: 100,
    event_kind: "unknown",
    event_subtype: nativeType ?? locator.native_type,
    phase: null,
    actor_role: session?.actor_role ?? "unknown",
    occurred_at: locator.occurred_at,
    observed_at: locator.occurred_at,
    native_item_id: stringValue(envelope?.uuid) ?? stringValue(message?.id),
    parent_native_item_id: stringValue(envelope?.parentUuid) ??
      stringValue(envelope?.parent_uuid),
    turn_id: turnId,
    tool_call_id: null,
    message_role: null,
    message_origin: null,
    tool_name: null,
    tool_status: null,
    model: stringValue(message?.model) ?? session?.model ?? null,
    project_key: session?.project_key ?? null,
    repo_remote: session?.repo_remote ?? null,
    branch: stringValue(envelope?.gitBranch) ?? session?.branch ?? null,
    cwd: stringValue(envelope?.cwd) ?? session?.cwd ?? null,
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
    return [{ ...base, error_code: `native_${locator.parse_status}` }];
  }
  if ((nativeType !== "user" && nativeType !== "assistant") || !message) {
    const nativeSubtype = stringValue(envelope.subtype);
    const turnComplete = nativeType === "system" &&
      nativeSubtype === "turn_duration";
    return [{
      ...base,
      event_kind: nativeType === "system" || nativeType === "progress"
        ? "lifecycle"
        : "unknown",
      event_subtype: turnComplete
        ? "turn_complete"
        : nativeSubtype ?? base.event_subtype,
      attributes: turnComplete ? durationAttributes(envelope.durationMs) : null,
    }];
  }

  const role = stringValue(message.role) ?? nativeType;
  const messageId = stringValue(message.id);
  const stopReason = stringValue(message.stop_reason) ??
    stringValue(message.stopReason);
  const content = message.content;
  const events: EventProjection[] = [];
  const text = messageText(content);
  if (text) {
    events.push({
      ...base,
      ...(await messageFields(text)),
      projection_index: events.length,
      event_kind: "message",
      event_subtype: nativeType === "user" ? "user_message" : "message",
      message_role: role,
      message_origin: claudeMessageOrigin(envelope, role, base.actor_role),
      logical_event_key: base.native_item_id
        ? `claude:message:${base.native_item_id}`
        : null,
    });
  }
  if (Array.isArray(content)) {
    for (const [blockIndex, item] of content.entries()) {
      const block = objectValue(item);
      const blockType = stringValue(block?.type);
      if (blockType === "thinking" || blockType === "redacted_thinking") {
        events.push({
          ...base,
          projection_index: events.length,
          event_kind: "reasoning",
          event_subtype: blockType,
          logical_event_key: base.native_item_id
            ? `claude:reasoning:${base.native_item_id}:block:${blockIndex}`
            : null,
        });
      } else if (blockType === "tool_use") {
        events.push({
          ...base,
          projection_index: events.length,
          event_kind: "tool_call",
          event_subtype: blockType,
          tool_call_id: stringValue(block?.id),
          tool_name: stringValue(block?.name),
        });
      } else if (blockType === "tool_result") {
        events.push({
          ...base,
          projection_index: events.length,
          event_kind: "tool_result",
          event_subtype: blockType,
          tool_call_id: stringValue(block?.tool_use_id),
          tool_status: block?.is_error === true ? "failed" : "completed",
        });
      }
    }
  }
  const usage = claudeUsage(objectValue(message.usage));
  if (usage) {
    events.push({
      ...base,
      ...usage,
      projection_index: events.length,
      event_kind: "usage",
      event_subtype: "message_usage",
      usage_stream_key: messageId
        ? `${canonicalScopeKey}:message:${messageId}`
        : canonicalScopeKey,
      usage_scope: "message",
      usage_is_cumulative: false,
      logical_event_key: messageId ? `claude:usage:${messageId}` : null,
      source_priority: stopReason === null ? base.source_priority : 110,
    });
  }
  if (stopReason !== null && stopReason !== "tool_use") {
    events.push({
      ...base,
      projection_index: events.length,
      event_kind: "lifecycle",
      event_subtype: "turn_complete",
      logical_event_key: base.native_item_id
        ? `claude:lifecycle:${base.native_item_id}:turn_complete`
        : null,
    });
  }
  return events.length ? events : [{
    ...base,
    event_kind: "ignored",
    event_subtype: `${nativeType}:empty_content`,
  }];
}

function claudeTurnIds(records: readonly ParsedRecord[]): Map<number, string> {
  const byUuid = new Map<string, JsonObject>();
  for (const record of records) {
    const envelope = record.envelope;
    const uuid = stringValue(envelope?.uuid);
    if (uuid && envelope) byUuid.set(uuid, envelope);
  }
  const memo = new Map<JsonObject, string | null>();
  const resolve = (
    envelope: JsonObject,
    visiting = new Set<JsonObject>(),
  ): string | null => {
    if (memo.has(envelope)) return memo.get(envelope) ?? null;
    const promptId = stringValue(envelope.promptId) ??
      stringValue(envelope.prompt_id);
    if (promptId) {
      const value = `claude:prompt:${promptId}`;
      memo.set(envelope, value);
      return value;
    }
    if (visiting.has(envelope)) return null;
    visiting.add(envelope);
    const parentUuid = stringValue(envelope.parentUuid) ??
      stringValue(envelope.parent_uuid);
    const parent = parentUuid ? byUuid.get(parentUuid) : undefined;
    const inherited = parent ? resolve(parent, visiting) : null;
    visiting.delete(envelope);
    if (inherited) {
      memo.set(envelope, inherited);
      return inherited;
    }
    const requestId = stringValue(envelope.requestId) ??
      stringValue(envelope.request_id);
    if (requestId) {
      const value = `claude:request:${requestId}`;
      memo.set(envelope, value);
      return value;
    }
    const message = objectValue(envelope.message);
    const content = message?.content;
    const isSubmittedUserMessage = stringValue(envelope.type) === "user" &&
      envelope.isMeta !== true && messageText(content) !== null &&
      !hasContentBlock(content, "tool_result");
    const uuid = stringValue(envelope.uuid);
    const fallback = isSubmittedUserMessage && uuid
      ? `claude:prompt:${uuid}`
      : null;
    memo.set(envelope, fallback);
    return fallback;
  };

  return new Map(records.flatMap((record) => {
    const turnId = record.envelope ? resolve(record.envelope) : null;
    return turnId === null
      ? []
      : [[record.locator.record_index, turnId] as const];
  }));
}

function hasContentBlock(content: unknown, type: string): boolean {
  return Array.isArray(content) &&
    content.some((item) => stringValue(objectValue(item)?.type) === type);
}

function durationAttributes(value: unknown): JsonObject | null {
  const durationMs = nonNegativeInteger(value);
  return durationMs === null ? null : { duration_ms: durationMs };
}

function claudeMessageOrigin(
  envelope: JsonObject,
  role: string,
  actorRole: ActorRole,
): "human" | "parent_agent" | "system" | "worker" | "unknown" {
  if (role !== "user") return assistantMessageOrigin(actorRole);
  if (envelope.isMeta === true) return "system";
  return actorRole === "primary" ? "human" : "parent_agent";
}

function claudeUsage(
  usage: JsonObject | null,
): Partial<EventProjection> | null {
  if (!usage) return null;
  const input = nonNegativeInteger(usage.input_tokens);
  const cacheRead = optionalNonNegativeInteger(
    usage,
    "cache_read_input_tokens",
  );
  const cacheCreate = optionalNonNegativeInteger(
    usage,
    "cache_creation_input_tokens",
  );
  const output = nonNegativeInteger(usage.output_tokens);
  if (
    input === null || cacheRead === null || cacheCreate === null ||
    output === null
  ) {
    return null;
  }
  return {
    input_tokens: input,
    cached_input_tokens: cacheRead + cacheCreate,
    output_tokens: output,
    reasoning_tokens: 0,
    total_tokens: input + cacheRead + cacheCreate + output,
    attributes: cacheCreate > 0
      ? { cache_creation_input_tokens: cacheCreate }
      : null,
  };
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
    parent_native_item_id: null,
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
