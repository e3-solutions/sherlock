import { type BatchManifest, CONTRACT_VERSION, sha256Hex } from "./contract.ts";
import {
  CLAUDE_NORMALIZER_VERSION,
  NORMALIZER_VERSION,
  normalizerVersionFor,
  projectBatch,
} from "./normalizer.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

async function fixture(
  records: Array<Record<string, unknown> | string>,
): Promise<{
  manifest: BatchManifest;
  source: Uint8Array;
}> {
  const encoder = new TextEncoder();
  const lines = records.map((record) =>
    encoder.encode(
      typeof record === "string"
        ? `${record}\n`
        : `${JSON.stringify(record)}\n`,
    )
  );
  const byteCount = lines.reduce((total, line) => total + line.byteLength, 0);
  const source = new Uint8Array(byteCount);
  const locators: BatchManifest["records"] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    source.set(line, offset);
    let decoded: Record<string, unknown> | null = null;
    try {
      const candidate = JSON.parse(new TextDecoder().decode(line));
      decoded = typeof candidate === "object" && candidate !== null &&
          !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
    } catch {
      // The malformed record is represented in the immutable locator below.
    }
    const payload = decoded?.payload;
    const payloadObject = typeof payload === "object" && payload !== null &&
        !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
    locators.push({
      record_index: index,
      source_start_offset: offset,
      source_end_offset: offset + line.byteLength,
      record_sha256: await sha256Hex(line),
      native_type: typeof decoded?.type === "string" ? decoded.type : null,
      native_payload_type: typeof payloadObject?.type === "string"
        ? payloadObject.type
        : null,
      occurred_at: typeof decoded?.timestamp === "string"
        ? decoded.timestamp
        : null,
      parse_status: decoded
        ? (typeof decoded.type === "string" ? "ok" : "unknown")
        : "malformed",
    });
    offset += line.byteLength;
  }
  const occurred = locators.flatMap((record) =>
    record.occurred_at ? [record.occurred_at] : []
  );
  return {
    source,
    manifest: {
      contract_version: CONTRACT_VERSION,
      source_provider: "codex",
      source_kind: "rollout",
      source_stream_key: "stream-normalizer",
      generation_key: "generation-normalizer",
      generation_seq: 0,
      start_offset: 0,
      end_offset: source.byteLength,
      source_byte_count: source.byteLength,
      source_sha256: await sha256Hex(source),
      storage_encoding: "gzip",
      stored_byte_count: 1,
      stored_sha256: "a".repeat(64),
      record_count: locators.length,
      records: locators,
      observed_native_session_id: "child-session",
      observed_parent_native_session_id: null,
      first_occurred_at: occurred[0] ?? null,
      last_occurred_at: occurred.at(-1) ?? null,
      codex_version: "test",
      source_version: "test",
      collector_version: "test",
    },
  };
}

Deno.test("normalizer projects sessions, messages, usage, and tools", async () => {
  const { manifest, source } = await fixture([
    {
      timestamp: "2026-08-15T00:00:00Z",
      type: "session_meta",
      payload: {
        id: "child-session",
        session_id: "parent-session",
        parent_thread_id: "parent-session",
        source: { subagent: { other: "guardian" } },
        cwd: "/repo",
        git: {
          repository_url: "https://github.com/e3-solutions/sherlock.git",
          branch: "arya/test",
        },
      },
    },
    {
      timestamp: "2026-08-15T00:00:01Z",
      type: "turn_context",
      payload: { model: "gpt-5", cwd: "/repo/current" },
    },
    {
      timestamp: "2026-08-15T00:00:02Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        turn_id: "turn-1",
        content: [{ type: "input_text", text: "Hello Sherlock" }],
      },
    },
    {
      timestamp: "2026-08-15T00:00:03Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        turn_id: "turn-1",
        message: "Hello Sherlock",
      },
    },
    {
      timestamp: "2026-08-15T00:00:04Z",
      type: "response_item",
      payload: {
        id: "message-commentary",
        type: "message",
        role: "assistant",
        phase: "commentary",
        turn_id: "turn-1",
        content: [{ type: "output_text", text: "Working on it" }],
      },
    },
    {
      timestamp: "2026-08-15T00:00:05Z",
      type: "response_item",
      payload: {
        id: "message-final",
        type: "message",
        role: "assistant",
        phase: "final_answer",
        turn_id: "turn-1",
        content: [{ type: "output_text", text: "Done" }],
      },
    },
    {
      timestamp: "2026-08-15T00:00:06Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 10,
            total_tokens: 130,
          },
          model_context_window: 258400,
        },
      },
    },
    {
      timestamp: "2026-08-15T00:00:07Z",
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call-1",
        name: "functions.exec",
        status: "completed",
      },
    },
  ]);

  const projection = await projectBatch(manifest, source);

  assert(NORMALIZER_VERSION === "sherlock.codex-rollout.v1");
  assert(projection.session?.native_session_id === "child-session");
  assert(projection.session?.parent_native_session_id === "parent-session");
  assert(projection.session?.actor_role === "guardian");
  assert(projection.session?.model === "gpt-5");
  assert(projection.session?.cwd === "/repo/current");
  assert(projection.events.length === manifest.record_count);

  const messages = projection.events.filter((event) =>
    event.event_kind === "message"
  );
  assert(messages.length === 4);
  const userMessages = messages.filter((event) =>
    event.message_role === "user"
  );
  assert(userMessages.length === 2);
  assert(
    userMessages[0].logical_event_key === userMessages[1].logical_event_key,
  );
  assert(userMessages[0].source_priority === 50);
  assert(userMessages[1].source_priority === 100);
  assert(messages.some((event) => event.phase === "commentary"));
  assert(messages.some((event) => event.phase === "final_answer"));
  assert(messages.every((event) => event.content_sha256?.length === 64));

  const usage = projection.events.find((event) => event.event_kind === "usage");
  assert(usage?.input_tokens === 80);
  assert(usage?.cached_input_tokens === 20);
  assert(usage?.output_tokens === 20);
  assert(usage?.reasoning_tokens === 10);
  assert(usage?.total_tokens === 130);
  assert(usage?.usage_is_cumulative === true);

  const tool = projection.events.find((event) =>
    event.event_kind === "tool_call"
  );
  assert(tool?.tool_call_id === "call-1");
  assert(tool?.tool_name === "functions.exec");
});

Deno.test("normalizer emits observable unknown events for malformed records", async () => {
  const { manifest, source } = await fixture(["not-json"]);

  const projection = await projectBatch(manifest, source);

  assert(projection.events.length === 1);
  assert(projection.events[0].event_kind === "unknown");
  assert(projection.events[0].error_code === "native_malformed");
});

Deno.test("normalizer never parses a native record fragment", async () => {
  const { manifest, source } = await fixture([{
    timestamp: "2026-08-15T00:00:00Z",
    type: "event_msg",
    payload: {
      type: "agent_message",
      message: "this would become product activity if parsed",
    },
  }]);
  manifest.records[0] = {
    ...manifest.records[0],
    native_type: null,
    native_payload_type: null,
    occurred_at: null,
    parse_status: "fragment",
    native_record_start_offset: 0,
    native_record_end_offset: source.byteLength * 2,
    native_record_sha256: "f".repeat(64),
    fragment_index: 0,
    fragment_count: 2,
  };

  const projection = await projectBatch(manifest, source);

  assert(projection.events.length === 1);
  assert(projection.events[0].event_kind === "unknown");
  assert(projection.events[0].error_code === "native_fragment");
  assert(projection.events[0].content_excerpt === null);
});

Deno.test("usage without a native session keeps a deterministic stream scope", async () => {
  const { manifest, source } = await fixture([{
    timestamp: "2026-08-15T00:00:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
      },
    },
  }]);
  manifest.observed_native_session_id = null;

  const projection = await projectBatch(manifest, source);

  assert(projection.session === null);
  assert(
    projection.events[0].canonical_scope_key === "stream:stream-normalizer",
  );
  assert(projection.events[0].usage_stream_key === "stream:stream-normalizer");
});

Deno.test("a chunk without session metadata does not invent a primary role", async () => {
  const { manifest, source } = await fixture([{
    timestamp: "2026-08-15T00:00:00Z",
    type: "event_msg",
    payload: {
      type: "agent_message",
      turn_id: "turn-later-chunk",
      message: "continuing in a later chunk",
    },
  }]);

  const projection = await projectBatch(manifest, source);

  assert(projection.session?.actor_role === "unknown");
  assert(projection.events[0].actor_role === "unknown");
  assert(projection.events[0].message_origin === "unknown");
});

Deno.test("Claude transcripts use a provider-specific projection", async () => {
  const { manifest, source } = await fixture([
    {
      parentUuid: null,
      sessionId: "claude-session",
      cwd: "/repo",
      gitBranch: "arya/claude",
      version: "2.0.59",
      type: "user",
      uuid: "user-message",
      timestamp: "2026-08-19T00:00:00Z",
      message: { role: "user", content: "Hello from Claude" },
    },
    {
      parentUuid: "user-message",
      sessionId: "claude-session",
      cwd: "/repo",
      gitBranch: "arya/claude",
      type: "assistant",
      uuid: "assistant-message",
      timestamp: "2026-08-19T00:00:01Z",
      message: {
        id: "message-1",
        role: "assistant",
        model: "claude-opus-4-1",
        content: [
          { type: "text", text: "I will inspect it." },
          { type: "tool_use", id: "tool-1", name: "Read", input: {} },
        ],
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 4,
          output_tokens: 6,
        },
      },
    },
    {
      parentUuid: "assistant-message",
      sessionId: "claude-session",
      type: "user",
      uuid: "tool-result-message",
      timestamp: "2026-08-19T00:00:02Z",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "file contents",
        }],
      },
    },
  ]);
  manifest.source_provider = "claude_code";
  manifest.source_kind = "transcript";
  manifest.source_version = "2.0.59";
  manifest.codex_version = null;
  manifest.observed_native_session_id = "claude-session";

  const projection = await projectBatch(manifest, source);

  assert(normalizerVersionFor(manifest) === CLAUDE_NORMALIZER_VERSION);
  assert(projection.session?.native_session_id === "claude-session");
  assert(projection.session?.actor_role === "primary");
  assert(projection.session?.model === "claude-opus-4-1");
  assert(projection.session?.branch === "arya/claude");
  assert(
    projection.events.some((event) =>
      event.event_kind === "message" && event.message_role === "user" &&
      event.content_excerpt === "Hello from Claude"
    ),
  );
  assert(
    projection.events.some((event) =>
      event.event_kind === "tool_call" && event.tool_call_id === "tool-1" &&
      event.tool_name === "Read"
    ),
  );
  assert(
    projection.events.some((event) =>
      event.event_kind === "tool_result" && event.tool_call_id === "tool-1"
    ),
  );
  const usage = projection.events.find((event) => event.event_kind === "usage");
  assert(usage?.input_tokens === 10);
  assert(usage?.cached_input_tokens === 4);
  assert(usage?.output_tokens === 6);
  assert(usage?.total_tokens === 20);
  assert(usage?.usage_is_cumulative === false);
});

Deno.test("Claude subagent identity remains linked to its parent session", async () => {
  const { manifest, source } = await fixture([{
    sessionId: "parent-session",
    agentId: "agent-worker",
    isSidechain: true,
    type: "assistant",
    timestamp: "2026-08-19T00:00:00Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-4",
      content: [{ type: "text", text: "Subagent result" }],
    },
  }]);
  manifest.source_provider = "claude_code";
  manifest.source_kind = "transcript";
  manifest.source_version = "2.0.59";
  manifest.codex_version = null;
  manifest.observed_native_session_id = "agent-worker";
  manifest.observed_parent_native_session_id = "parent-session";

  const projection = await projectBatch(manifest, source);

  assert(projection.session?.native_session_id === "agent-worker");
  assert(projection.session?.parent_native_session_id === "parent-session");
  assert(projection.session?.actor_role === "worker");
  assert(projection.events[0].message_origin === "worker");
});

Deno.test("realistic Claude records keep semantic turns and canonical usage", async () => {
  const promptId = "prompt-primary-1";
  const terminalUsage = {
    input_tokens: 20,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 3,
    output_tokens: 7,
  };
  const partialUsage = { ...terminalUsage, output_tokens: 2 };
  const { manifest, source } = await fixture([
    {
      sessionId: "claude-primary",
      promptId,
      type: "user",
      uuid: "user-1",
      parentUuid: null,
      timestamp: "2026-08-19T00:00:00Z",
      message: { role: "user", content: "Inspect the repository" },
    },
    {
      sessionId: "claude-primary",
      type: "assistant",
      uuid: "thinking-1",
      parentUuid: "user-1",
      requestId: "request-1",
      timestamp: "2026-08-19T00:00:01Z",
      message: {
        id: "message-1",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{
          type: "thinking",
          thinking: "sensitive reasoning that must not be projected",
          signature: "opaque-signature",
        }],
        usage: partialUsage,
      },
    },
    {
      sessionId: "claude-primary",
      type: "assistant",
      uuid: "thinking-2",
      parentUuid: "thinking-1",
      requestId: "request-1",
      timestamp: "2026-08-19T00:00:01.500Z",
      message: {
        id: "message-1",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{
          type: "thinking",
          thinking: "a distinct reasoning chunk that also stays private",
        }],
        usage: partialUsage,
      },
    },
    {
      sessionId: "claude-primary",
      type: "assistant",
      uuid: "tool-call-1",
      parentUuid: "thinking-2",
      requestId: "request-1",
      timestamp: "2026-08-19T00:00:02Z",
      message: {
        id: "message-1",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
        stop_reason: "tool_use",
        usage: terminalUsage,
      },
    },
    {
      sessionId: "claude-primary",
      promptId,
      type: "user",
      uuid: "tool-result-1",
      parentUuid: "tool-call-1",
      timestamp: "2026-08-19T00:00:03Z",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "source bytes stay only in the immutable transcript",
        }],
      },
    },
    {
      sessionId: "claude-primary",
      type: "assistant",
      uuid: "answer-1",
      parentUuid: "tool-result-1",
      requestId: "request-2",
      timestamp: "2026-08-19T00:00:04Z",
      message: {
        id: "message-2",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{ type: "text", text: "The repository is healthy." }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 4,
          cache_read_input_tokens: 1,
          output_tokens: 3,
        },
      },
    },
    {
      sessionId: "claude-primary",
      promptId,
      type: "system",
      subtype: "turn_duration",
      uuid: "turn-duration-1",
      parentUuid: "answer-1",
      durationMs: 4_500,
      timestamp: "2026-08-19T00:00:05Z",
    },
  ]);
  manifest.source_provider = "claude_code";
  manifest.source_kind = "transcript";
  manifest.codex_version = null;
  manifest.source_version = "2.0.59";
  manifest.observed_native_session_id = "claude-primary";

  const projection = await projectBatch(manifest, source);
  const turnId = `claude:prompt:${promptId}`;
  const user = projection.events.find((event) =>
    event.event_kind === "message" && event.message_role === "user"
  );
  assert(user?.event_subtype === "user_message");
  assert(user.turn_id === turnId);
  const answer = projection.events.find((event) =>
    event.event_kind === "message" && event.message_role === "assistant"
  );
  assert(answer?.event_subtype === "message");
  assert(answer.turn_id === turnId);

  const reasoning = projection.events.filter((event) =>
    event.event_kind === "reasoning"
  );
  assert(reasoning.length === 2);
  assert(
    new Set(reasoning.map((event) => event.logical_event_key)).size === 2,
    "distinct thinking records must remain distinct derived evidence",
  );
  assert(reasoning.every((event) => event.event_subtype === "thinking"));
  assert(reasoning.every((event) => event.turn_id === turnId));
  assert(reasoning.every((event) => event.content_sha256 === null));
  assert(reasoning.every((event) => event.content_byte_size === null));
  assert(reasoning.every((event) => event.content_excerpt === null));
  assert(reasoning.every((event) => event.attributes === null));
  assert(
    reasoning.every((event) => event.logical_event_key?.endsWith(":block:0")),
  );

  const repeated = projection.events.filter((event) =>
    event.event_kind === "usage" &&
    event.logical_event_key === "claude:usage:message-1"
  );
  assert(repeated.length === 3, "raw record projections remain auditable");
  assert(
    new Set(repeated.map((event) => event.logical_event_key)).size === 1,
    "repeated message usage must have one cross-batch canonical identity",
  );
  assert(
    repeated.every((event) =>
      event.usage_stream_key ===
        "session:claude-primary:message:message-1"
    ),
  );
  assert(repeated.every((event) => event.turn_id === turnId));
  assert(repeated.every((event) => event.cached_input_tokens === 8));
  const terminalUsageEvent = repeated.find((event) =>
    event.source_priority === 110
  );
  assert(terminalUsageEvent?.output_tokens === 7);
  assert(
    repeated.filter((event) => event.source_priority === 100).length === 2,
  );

  const completions = projection.events.filter((event) =>
    event.event_kind === "lifecycle" && event.event_subtype === "turn_complete"
  );
  assert(completions.length === 2);
  assert(completions.every((event) => event.turn_id === turnId));
  assert(
    completions.some((event) =>
      event.logical_event_key ===
        "claude:lifecycle:answer-1:turn_complete"
    ),
    "a native end_turn response must close the projected turn",
  );
  assert(
    completions.some((event) => event.attributes?.duration_ms === 4_500),
  );
});

Deno.test("Claude meta messages are system-originated, not human prompts", async () => {
  const { manifest, source } = await fixture([{
    sessionId: "claude-primary",
    promptId: "prompt-meta-1",
    type: "user",
    isMeta: true,
    uuid: "meta-user-1",
    parentUuid: "answer-before-meta",
    timestamp: "2026-08-19T00:00:06Z",
    message: { role: "user", content: "Sanitized injected context" },
  }]);
  manifest.source_provider = "claude_code";
  manifest.source_kind = "transcript";
  manifest.codex_version = null;
  manifest.observed_native_session_id = "claude-primary";

  const projection = await projectBatch(manifest, source);
  assert(projection.events.length === 1);
  assert(projection.events[0].event_subtype === "user_message");
  assert(projection.events[0].message_origin === "system");
  assert(projection.events[0].turn_id === "claude:prompt:prompt-meta-1");
});

Deno.test("realistic Claude subagent records inherit their prompt turn", async () => {
  const { manifest, source } = await fixture([
    {
      sessionId: "parent-session",
      agentId: "agent-worker",
      isSidechain: true,
      promptId: "worker-prompt",
      type: "user",
      uuid: "worker-user",
      timestamp: "2026-08-19T00:00:00Z",
      message: { role: "user", content: "Inspect in parallel" },
    },
    {
      sessionId: "parent-session",
      agentId: "agent-worker",
      isSidechain: true,
      type: "assistant",
      uuid: "worker-answer",
      parentUuid: "worker-user",
      timestamp: "2026-08-19T00:00:01Z",
      message: {
        id: "worker-message",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{ type: "text", text: "Worker result" }],
        usage: { input_tokens: 2, output_tokens: 2 },
      },
    },
  ]);
  manifest.source_provider = "claude_code";
  manifest.source_kind = "transcript";
  manifest.codex_version = null;
  manifest.source_version = "2.0.59";
  manifest.observed_native_session_id = "agent-worker";
  manifest.observed_parent_native_session_id = "parent-session";

  const projection = await projectBatch(manifest, source);
  assert(projection.session?.actor_role === "worker");
  assert(projection.session?.parent_native_session_id === "parent-session");
  assert(
    projection.events.every((event) =>
      event.turn_id === "claude:prompt:worker-prompt"
    ),
  );
  assert(
    projection.events.find((event) => event.event_kind === "message")
      ?.message_origin === "parent_agent",
  );
});

Deno.test("Claude response-only batches use request identity conservatively", async () => {
  const { manifest, source } = await fixture([
    {
      sessionId: "claude-primary",
      type: "assistant",
      uuid: "thinking-later-batch",
      parentUuid: "user-record-from-an-earlier-batch",
      requestId: "request-later-batch",
      timestamp: "2026-08-19T00:00:10Z",
      message: {
        id: "message-later-batch",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{ type: "thinking", thinking: "not projected" }],
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    },
    {
      sessionId: "claude-primary",
      type: "assistant",
      uuid: "answer-later-batch",
      parentUuid: "thinking-later-batch",
      requestId: "request-later-batch",
      timestamp: "2026-08-19T00:00:11Z",
      message: {
        id: "message-later-batch",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{ type: "text", text: "Later-batch response" }],
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    },
  ]);
  manifest.source_provider = "claude_code";
  manifest.source_kind = "transcript";
  manifest.codex_version = null;
  manifest.observed_native_session_id = "claude-primary";

  const projection = await projectBatch(manifest, source);
  assert(
    projection.events.find((event) =>
      event.native_item_id === "thinking-later-batch"
    )?.parent_native_item_id === "user-record-from-an-earlier-batch",
  );
  assert(
    projection.events.every((event) =>
      event.turn_id === "claude:request:request-later-batch"
    ),
  );
  const usage = projection.events.filter((event) =>
    event.event_kind === "usage"
  );
  assert(usage.length === 2);
  assert(
    usage.every((event) =>
      event.logical_event_key === "claude:usage:message-later-batch" &&
      event.usage_stream_key ===
        "session:claude-primary:message:message-later-batch"
    ),
  );
});
