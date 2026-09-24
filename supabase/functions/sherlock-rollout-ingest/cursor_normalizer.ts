import {
  type BatchManifest,
  decodeBase64Bytes,
  sha256Hex,
} from "./contract.ts";
import type {
  BatchProjection,
  EventProjection,
  SessionProjection,
} from "./normalizer.ts";

export const CURSOR_NORMALIZER_VERSION = "sherlock.cursor-hook.v1";
const EVENTS = new Set([
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "stop",
  "afterAgentResponse",
  "afterAgentThought",
  "preCompact",
]);
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** Native hooks are observations, not transcript replay or inferred usage. */
export async function projectCursorBatch(
  manifest: BatchManifest,
  source: Uint8Array,
): Promise<BatchProjection> {
  let session: SessionProjection | null = null;
  const events: EventProjection[] = [];
  for (const locator of manifest.records) {
    const base: EventProjection = {
      record_index: locator.record_index,
      projection_index: 0,
      canonical_scope_key: null,
      logical_event_key: null,
      source_priority: 100,
      event_kind: "unknown",
      event_subtype: "cursor_hook_invalid",
      phase: null,
      actor_role: "unknown",
      occurred_at: null,
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
    try {
      if (locator.parse_status !== "ok") throw new Error("unparsed");
      const envelope = object(
        JSON.parse(new TextDecoder().decode(source.subarray(
          locator.source_start_offset - manifest.start_offset,
          locator.source_end_offset - manifest.start_offset,
        ))),
      );
      if (
        !envelope || envelope.schema_version !== CURSOR_NORMALIZER_VERSION ||
        envelope.type !== "cursor_hook"
      ) throw new Error("schema");
      const event = text(envelope.dispatch_event_name);
      const id = text(envelope.observation_id);
      const timestamp = text(envelope.timestamp);
      if (
        !event || !EVENTS.has(event) || !id ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          .test(id) ||
        !timestamp || timestamp !== locator.occurred_at ||
        !Number.isFinite(Date.parse(timestamp))
      ) {
        throw new Error("identity");
      }
      const bytes = decodeBase64Bytes(String(envelope.payload_base64));
      if (await sha256Hex(bytes) !== envelope.payload_sha256) {
        throw new Error("hash");
      }
      const payload = object(JSON.parse(new TextDecoder().decode(bytes)));
      if (
        !payload ||
        (payload.hook_event_name != null && payload.hook_event_name !== event)
      ) {
        throw new Error("dispatch");
      }
      const conversation = text(payload.conversation_id);
      if (!conversation) throw new Error("conversation");
      const childEvent = event === "subagentStart" || event === "subagentStop";
      const child = text(payload.subagent_id);
      if (childEvent && !child) throw new Error("child");
      const parent = childEvent
        ? "cursor:" + (text(payload.parent_conversation_id) ?? conversation)
        : null;
      const native = childEvent
        ? `${parent}:subagent:${child}`
        : `cursor:${conversation}`;
      if (
        native !== manifest.observed_native_session_id ||
        parent !== manifest.observed_parent_native_session_id ||
        (session !== null && session.native_session_id !== native)
      ) throw new Error("session");
      const model =
        text(childEvent ? payload.subagent_model : payload.model_id) ??
          text(payload.model);
      const cwd = text(payload.cwd) ??
        (Array.isArray(payload.workspace_roots)
          ? text(payload.workspace_roots[0])
          : null);
      session ??= {
        native_session_id: native,
        native_thread_id: conversation,
        parent_native_session_id: parent,
        actor_role: childEvent ? "worker" : "primary",
        role_version: "sherlock.cursor-role.v1",
        title: null,
        project_key: null,
        repo_remote: null,
        branch: null,
        cwd,
        model,
        started_at: timestamp,
      };
      Object.assign(base, {
        canonical_scope_key: `session:${native}`,
        logical_event_key: `cursor:observation:${id}`,
        native_item_id: id,
        actor_role: session.actor_role,
        observed_at: timestamp,
        model,
        cwd,
        turn_id: text(payload.generation_id)
          ? `cursor:generation:${payload.generation_id}`
          : null,
        attributes: {
          hook_event: event,
          timing_basis: "collector_observation",
        },
        event_kind: "lifecycle",
        event_subtype: event,
      });
      let content: string | null = null;
      if (event === "beforeSubmitPrompt") {
        // Other hooks may still reject this request; never count it as submitted.
        base.event_kind = "message";
        base.event_subtype = "prompt_attempt";
        base.message_role = "user";
        base.message_origin = "human";
        content = text(payload.prompt);
      } else if (
        event === "afterAgentResponse" || event === "afterAgentThought"
      ) {
        base.event_kind = event === "afterAgentThought"
          ? "reasoning"
          : "message";
        base.event_subtype = event === "afterAgentThought"
          ? "reasoning"
          : "message";
        base.message_role = "assistant";
        content = text(payload.text);
      } else if (event === "postToolUse" || event === "postToolUseFailure") {
        base.event_kind = "tool_result";
        base.event_subtype = "tool_result";
        base.tool_call_id = text(payload.tool_use_id);
        base.tool_name = text(payload.tool_name);
        base.tool_status = event === "postToolUseFailure"
          ? "failed"
          : "completed";
      } else if (event === "subagentStart") {
        base.event_kind = "agent_spawn";
        base.event_subtype = "subagent_start_observed";
      } else if (event === "stop" || event === "subagentStop") {
        // Completion status is retained without claiming success for aborted turns.
        base.event_subtype = "turn_complete";
        if (payload.status === "aborted" || payload.status === "error") {
          base.event_kind = "error";
          base.event_subtype = "turn_" + payload.status;
        }
      }
      if (content) {
        const encoded = new TextEncoder().encode(content);
        base.content_sha256 = await sha256Hex(encoded);
        base.content_byte_size = encoded.length;
        let excerpt = "";
        let size = 0;
        for (const character of content) {
          size += new TextEncoder().encode(character).length;
          if (size > 1024) break;
          excerpt += character;
        }
        base.content_excerpt = excerpt;
      }
    } catch {
      // Invalid source still receives a coverage fact, never fabricated activity.
      Object.assign(base, {
        event_kind: "unknown",
        event_subtype: "cursor_hook_invalid",
        error_code: "invalid_cursor_hook",
        content_excerpt: null,
      });
    }
    events.push(base);
  }
  return { session, events, session_scm: null };
}
