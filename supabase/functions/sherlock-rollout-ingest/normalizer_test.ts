import { type BatchManifest, CONTRACT_VERSION, sha256Hex } from "./contract.ts";
import {
  CLAUDE_NORMALIZER_VERSION,
  LEGACY_CODEX_NORMALIZER_VERSION,
  legacyNormalizerVersionFor,
  NORMALIZER_VERSION,
  normalizerVersionFor,
  projectBatch,
  RUNTIME_CONTEXT_MESSAGE_ORIGIN,
  SCM_SOURCE_VERSION,
} from "./normalizer.ts";

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function claudeHookEnvelope(input: {
  dispatchEventName: "Stop" | "SubagentStop" | "SessionEnd";
  payload: Record<string, unknown>;
  nativeSessionId: string;
  parentNativeSessionId?: string | null;
  terminalAssistantUuid?: string | null;
  turnAnchorId?: string | null;
  transcript?: Uint8Array | null;
}): Promise<Record<string, unknown>> {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(input.payload));
  const transcript = input.transcript === undefined
    ? new TextEncoder().encode("sanitized immutable Claude transcript\n")
    : input.transcript;
  return {
    type: "claude_hook",
    schema_version: "sherlock.claude-hook.v1",
    collector_observed_at: "2026-08-19T00:00:02.000000Z",
    dispatch_event_name: input.dispatchEventName,
    payload_sha256: await sha256Hex(payloadBytes),
    payload_base64: encodeBase64(payloadBytes),
    native_session_id: input.nativeSessionId,
    parent_native_session_id: input.parentNativeSessionId ?? null,
    terminal_assistant_uuid: input.terminalAssistantUuid ?? null,
    turn_anchor_id: input.turnAnchorId ?? null,
    transcript_byte_count: transcript?.byteLength ?? null,
    transcript_sha256: transcript ? await sha256Hex(transcript) : null,
  };
}

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
          commit_hash: "A".repeat(40),
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

  assert(NORMALIZER_VERSION === "sherlock.codex-rollout.v2");
  assert(projection.session?.native_session_id === "child-session");
  assert(projection.session?.parent_native_session_id === "parent-session");
  assert(projection.session?.actor_role === "guardian");
  assert(projection.session?.model === "gpt-5");
  assert(projection.session?.cwd === "/repo/current");
  assert(projection.events.length === manifest.record_count);
  assert(projection.session_scm?.record_index === 0);
  assert(projection.session_scm.source_version === SCM_SOURCE_VERSION);
  assert(
    projection.session_scm.repository_full_name ===
      "e3-solutions/sherlock",
  );
  assert(projection.session_scm.commit_sha === "a".repeat(40));

  const messages = projection.events.filter((event) =>
    event.event_kind === "message"
  );
  assert(messages.length === 4);
  const userMessages = messages.filter((event) =>
    event.message_role === "user"
  );
  assert(userMessages.length === 2);
  assert(
    userMessages.every((event) => event.message_origin === "human"),
  );
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

Deno.test("collector-discovered Codex subagent keeps worker topology", async () => {
  const childId = "55555555-5555-4555-8555-555555555555";
  const parentId = "66666666-6666-4666-8666-666666666666";
  const { manifest, source } = await fixture([{
    type: "session_meta",
    payload: {
      id: childId,
      source: { subagent: { other: "worker" } },
      parent_thread_id: parentId,
      root_thread_id: parentId,
    },
  }]);
  manifest.observed_native_session_id = childId;

  const projection = await projectBatch(manifest, source);

  assert(projection.session?.native_session_id === childId);
  assert(projection.session?.parent_native_session_id === parentId);
  assert(projection.session?.actor_role === "worker");
});

Deno.test("Codex v2 classifies the explicit runtime envelope contract", async () => {
  const machineMessages = [
    "<recommended_plugins>machine context</recommended_plugins>",
    '<in-app-browser-context version="2">machine context</in-app-browser-context>',
    "<app-context>machine context</app-context>",
    "<skills_instructions>machine context</skills_instructions>",
    "<permissions instructions>machine context</permissions>",
    "<permissions_instructions>machine context</permissions_instructions>",
    "<environment_context>machine context</environment_context>",
    "<collaboration_mode>machine context</collaboration_mode>",
    "<apps_instructions>machine context</apps_instructions>",
    "<plugins_instructions>machine context</plugins_instructions>",
    '<codex_delegation schema_version="2">machine context</codex_delegation>',
    "<heartbeat>machine context</heartbeat>",
    "<turn_aborted>machine context</turn_aborted>",
    '<automation id="test">machine context</automation>',
    "<skill>machine context</skill>",
    "# AGENTS.md instructions for /repo",
    "# Bonaparte Implementation context",
    "The configured soft phase budget has expired. Continue.",
  ];
  const humanMessages = [
    "<customer_instructions>human request</customer_instructions>",
    "<project_context>human-authored context</project_context>",
    "<legal-delegation>human-authored XML</legal-delegation>",
    "<order><item>human-authored XML</item></order>",
    "Build a context-aware parser",
  ];
  const records = [...machineMessages, ...humanMessages].map((text, index) => ({
    timestamp: `2026-08-15T00:01:${String(index).padStart(2, "0")}Z`,
    type: "response_item",
    payload: {
      id: `message-${index}`,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  }));
  const { manifest, source } = await fixture([{
    timestamp: "2026-08-15T00:00:59Z",
    type: "session_meta",
    payload: { id: "child-session", source: "cli" },
  }, ...records]);

  const projection = await projectBatch(manifest, source);
  const messages = projection.events.filter((event) =>
    event.event_kind === "message"
  );

  assert(normalizerVersionFor(manifest) === NORMALIZER_VERSION);
  assert(messages.length === records.length);
  assert(
    messages.slice(0, machineMessages.length).every((event) =>
      event.message_origin === RUNTIME_CONTEXT_MESSAGE_ORIGIN
    ),
  );
  assert(
    messages.slice(machineMessages.length).every((event) =>
      event.message_origin === "human"
    ),
  );
});

Deno.test("Codex v1 remains reproducible while v2 appends corrected facts", async () => {
  const runtimeText = "<environment_context>injected</environment_context>";
  const { manifest, source } = await fixture([{
    timestamp: "2026-08-15T00:01:59Z",
    type: "session_meta",
    payload: { id: "child-session", source: "cli" },
  }, {
    timestamp: "2026-08-15T00:02:00Z",
    type: "response_item",
    payload: {
      id: "runtime-message",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: runtimeText }],
    },
  }, {
    timestamp: "2026-08-15T00:02:01Z",
    type: "event_msg",
    payload: {
      type: "user_message",
      message: runtimeText,
    },
  }]);

  const legacy = await projectBatch(
    manifest,
    source,
    LEGACY_CODEX_NORMALIZER_VERSION,
  );
  const current = await projectBatch(manifest, source, NORMALIZER_VERSION);

  assert(
    legacyNormalizerVersionFor(manifest) === LEGACY_CODEX_NORMALIZER_VERSION,
  );
  assert(legacy.events[1].message_origin === "human");
  assert(current.events[1].message_origin === RUNTIME_CONTEXT_MESSAGE_ORIGIN);
  assert(
    current.events[2].message_origin === "human",
    "submitted user_message envelopes remain human facts",
  );
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

Deno.test("Claude fragments cannot poison provider-specific session facts", async () => {
  const { manifest, source } = await fixture([{
    sessionId: "fabricated-session",
    agentId: "fabricated-agent",
    isSidechain: true,
    customTitle: "fabricated title",
    gitBranch: "fabricated-branch",
    cwd: "/fabricated",
    type: "assistant",
    message: {
      role: "assistant",
      model: "fabricated-model",
      content: [{ type: "text", text: "fabricated message" }],
    },
  }]);
  manifest.source_provider = "claude_code";
  manifest.source_kind = "transcript";
  manifest.source_version = "2.0.59";
  manifest.codex_version = null;
  manifest.observed_native_session_id = "observed-session";
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

  assert(projection.session?.native_session_id === "observed-session");
  assert(
    projection.session?.actor_role === "primary",
    `unexpected fragment actor role: ${projection.session?.actor_role}`,
  );
  assert(projection.session?.title === null);
  assert(projection.session?.branch === null);
  assert(projection.session?.cwd === null);
  assert(projection.session?.model === null);
  assert(projection.events.length === 1);
  const fragment = projection.events[0];
  assert(fragment.event_kind === "unknown");
  assert(fragment.error_code === "native_fragment");
  assert(fragment.native_item_id === null);
  assert(fragment.parent_native_item_id === null);
  assert(fragment.event_subtype === null);
  assert(fragment.message_role === null);
  assert(fragment.model === null);
  assert(fragment.branch === null);
  assert(fragment.cwd === null);
  assert(fragment.attributes === null);
  assert(fragment.content_excerpt === null);
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

Deno.test("legacy Claude Stop hooks close only with a collector-derived anchor", async () => {
  const sessionId = "0e80d9f3-de3e-498d-91b1-18beb3790278";
  const promptUuid = "1d1ab296-9746-4cca-bceb-768359d37b30";
  const assistantUuid = "d6d138fa-1ec7-4991-828d-fb3d672db7de";
  const hook = await claudeHookEnvelope({
    dispatchEventName: "Stop",
    nativeSessionId: sessionId,
    terminalAssistantUuid: assistantUuid,
    turnAnchorId: promptUuid,
    payload: {
      session_id: sessionId,
      transcript_path: "/sanitized/0e80.jsonl",
      cwd: "/repo",
      permission_mode: "default",
      hook_event_name: "Stop",
      stop_hook_active: false,
    },
  });
  const { manifest, source } = await fixture([hook]);
  manifest.source_provider = "claude_code";
  manifest.source_kind = "hook";
  manifest.codex_version = null;
  manifest.source_version = "2.0.59";
  manifest.observed_native_session_id = sessionId;

  const projection = await projectBatch(manifest, source);

  assert(normalizerVersionFor(manifest) === CLAUDE_NORMALIZER_VERSION);
  assert(projection.session?.native_session_id === sessionId);
  assert(projection.events.length === 1);
  const completion = projection.events[0];
  assert(completion.event_kind === "lifecycle");
  assert(completion.event_subtype === "turn_complete");
  assert(completion.turn_id === `claude:prompt:${promptUuid}`);
  assert(completion.native_item_id === assistantUuid);
  assert(
    completion.logical_event_key ===
      `claude:lifecycle:${assistantUuid}:turn_complete`,
  );
  assert(completion.content_sha256 === null);
  assert(completion.content_excerpt === null);
  assert(completion.attributes?.dispatch_event_name === "Stop");
  assert(typeof completion.attributes?.payload_sha256 === "string");
  assert(typeof completion.attributes?.transcript_sha256 === "string");
});

Deno.test("Claude SessionEnd is session evidence and never turn completion", async () => {
  const sessionId = "0e80d9f3-de3e-498d-91b1-18beb3790278";
  const hook = await claudeHookEnvelope({
    dispatchEventName: "SessionEnd",
    nativeSessionId: sessionId,
    payload: {
      session_id: sessionId,
      transcript_path: "/sanitized/0e80.jsonl",
      cwd: "/repo",
      permission_mode: "default",
      hook_event_name: "SessionEnd",
      reason: "prompt_input_exit",
    },
  });
  const { manifest, source } = await fixture([hook]);
  manifest.source_provider = "claude_code";
  manifest.source_kind = "hook";
  manifest.codex_version = null;
  manifest.observed_native_session_id = sessionId;

  const projection = await projectBatch(manifest, source);

  assert(projection.events.length === 1);
  assert(projection.events[0].event_subtype === "session_end");
  assert(projection.events[0].turn_id === null);
  assert(projection.events[0].native_item_id === null);
  assert(projection.events[0].attributes?.reason === "prompt_input_exit");
  assert(
    !projection.events.some((event) => event.event_subtype === "turn_complete"),
  );
});

Deno.test("legacy Claude Stop hooks stay unlinked without a verified prompt anchor", async () => {
  const sessionId = "0e80d9f3-de3e-498d-91b1-18beb3790278";
  const assistantUuid = "d6d138fa-1ec7-4991-828d-fb3d672db7de";
  const hook = await claudeHookEnvelope({
    dispatchEventName: "Stop",
    nativeSessionId: sessionId,
    terminalAssistantUuid: assistantUuid,
    turnAnchorId: null,
    payload: {
      session_id: sessionId,
      hook_event_name: "Stop",
    },
  });
  const { manifest, source } = await fixture([hook]);
  manifest.source_provider = "claude_code";
  manifest.source_kind = "hook";
  manifest.codex_version = null;
  manifest.observed_native_session_id = sessionId;

  const projection = await projectBatch(manifest, source);

  assert(projection.events[0].event_subtype === "response_complete_unlinked");
  assert(projection.events[0].turn_id === null);
  assert(projection.events[0].native_item_id === assistantUuid);
});

Deno.test("Claude hook projections reject tampered payloads and identity", async () => {
  const sessionId = "0e80d9f3-de3e-498d-91b1-18beb3790278";
  const promptUuid = "1d1ab296-9746-4cca-bceb-768359d37b30";
  const assistantUuid = "d6d138fa-1ec7-4991-828d-fb3d672db7de";
  const valid = await claudeHookEnvelope({
    dispatchEventName: "Stop",
    nativeSessionId: sessionId,
    terminalAssistantUuid: assistantUuid,
    turnAnchorId: promptUuid,
    payload: {
      session_id: sessionId,
      hook_event_name: "Stop",
      last_assistant_message: "Sanitized response",
    },
  });
  const cases = [
    { ...valid, payload_sha256: "0".repeat(64) },
    { ...valid, dispatch_event_name: "SubagentStop" },
    { ...valid, native_session_id: "wrong-session" },
    { ...valid, turn_anchor_id: "not-a-uuid" },
  ];
  for (const hook of cases) {
    const { manifest, source } = await fixture([hook]);
    manifest.source_provider = "claude_code";
    manifest.source_kind = "hook";
    manifest.codex_version = null;
    manifest.observed_native_session_id = sessionId;
    const projection = await projectBatch(manifest, source);
    assert(
      projection.events.every((event) =>
        event.event_subtype !== "turn_complete" && event.turn_id === null
      ),
      "untrusted hook fields must never close a turn",
    );
  }
});

Deno.test("Claude SubagentStop hooks anchor worker turns to the child session", async () => {
  const parentSessionId = "0e80d9f3-de3e-498d-91b1-18beb3790278";
  const agentId = "6b349eef-2637-45f9-bb0f-2cf02a9f9d60";
  const promptUuid = "5bf222ad-299f-46c9-9d0f-9f0d54e12487";
  const assistantUuid = "9684045b-c770-4ee0-b395-14d3e60b13d3";
  const hook = await claudeHookEnvelope({
    dispatchEventName: "SubagentStop",
    nativeSessionId: agentId,
    parentNativeSessionId: parentSessionId,
    terminalAssistantUuid: assistantUuid,
    turnAnchorId: promptUuid,
    payload: {
      session_id: parentSessionId,
      agent_id: agentId,
      agent_transcript_path: "/sanitized/agent.jsonl",
      hook_event_name: "SubagentStop",
      stop_hook_active: false,
      last_assistant_message: "Sanitized worker result",
    },
  });
  const { manifest, source } = await fixture([hook]);
  manifest.source_provider = "claude_code";
  manifest.source_kind = "hook";
  manifest.codex_version = null;
  manifest.observed_native_session_id = agentId;
  manifest.observed_parent_native_session_id = parentSessionId;

  const projection = await projectBatch(manifest, source);

  assert(projection.session?.actor_role === "worker");
  assert(projection.session?.parent_native_session_id === parentSessionId);
  assert(projection.events[0].actor_role === "worker");
  assert(projection.events[0].event_subtype === "turn_complete");
  assert(projection.events[0].turn_id === `claude:prompt:${promptUuid}`);
});
