import { type BatchManifest, CONTRACT_VERSION, sha256Hex } from "./contract.ts";
import {
  CLAUDE_NORMALIZER_VERSION,
  CODEX_V3_NORMALIZER_VERSION,
  CODEX_V4_NORMALIZER_VERSION,
  LEGACY_CODEX_NORMALIZER_VERSION,
  legacyNormalizerVersionFor,
  NORMALIZER_VERSION,
  normalizerVersionFor,
  projectBatch,
  ROLE_VERSION,
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

async function codexHookEnvelope(input: {
  dispatchEventName: "SessionStart" | "UserPromptSubmit" | "Stop";
  payload: Record<string, unknown>;
  nativeSessionId: string;
  parentNativeSessionId?: string | null;
  sessionSource?: string | null;
  git?: unknown;
  observedAt?: string;
}): Promise<Record<string, unknown>> {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(input.payload));
  const observedAt = input.observedAt ?? "2026-11-05T18:00:00.000000Z";
  return {
    type: "codex_hook",
    schema_version: "sherlock.codex-hook.v1",
    collector_observed_at: observedAt,
    timestamp: observedAt,
    dispatch_event_name: input.dispatchEventName,
    payload_sha256: await sha256Hex(payloadBytes),
    payload_base64: encodeBase64(payloadBytes),
    native_session_id: input.nativeSessionId,
    parent_native_session_id: input.parentNativeSessionId ?? null,
    session_source: input.sessionSource ?? null,
    git: input.git === undefined
      ? {
        repository_url: "https://github.com/e3-solutions/sherlock.git",
        branch: "main",
      }
      : input.git,
  };
}

async function codexHookFixture(
  records: Array<Record<string, unknown> | string>,
  nativeSessionId: string | null,
  parentNativeSessionId: string | null = null,
) {
  const result = await fixture(records);
  result.manifest.source_kind = "hook";
  result.manifest.observed_native_session_id = nativeSessionId;
  result.manifest.observed_parent_native_session_id = parentNativeSessionId;
  return result;
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

Deno.test("Codex v3 excludes runtime continuations in both formats without reinterpreting v1/v2", async () => {
  const goal =
    '<codex_internal_context source="goal">Continue the active goal.</codex_internal_context>';
  const texts = [
    goal,
    " \n\t" + goal,
    " ".repeat(2048) + goal,
    '<CODEX_INTERNAL_CONTEXT source="goal">Continue.</CODEX_INTERNAL_CONTEXT>',
    "<environment_context>runtime</environment_context>",
    "Please explain " + goal,
    "```xml\n" + goal + "\n```",
    "<codex_internal_contextual>human XML</codex_internal_contextual>",
    "Continue working on my request.",
  ];
  const records = texts.flatMap((text, index) => [
    { type: "event_msg", payload: { type: "user_message", message: text } },
    {
      type: "response_item",
      payload: {
        id: `message-${index}`,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    },
  ]);
  const { manifest, source } = await fixture(records);
  const corrected = await projectBatch(
    manifest,
    source,
    "sherlock.codex-rollout.v3",
  );
  for (const [index, event] of corrected.events.entries()) {
    assert(
      event.message_origin === (index < 10 ? "runtime_context" : "human"),
      `wrong v3 origin for representation ${index}`,
    );
    assert(event.message_role === "user", "runtime role must remain user");
    assert(
      event.content_sha256 ===
        await sha256Hex(
          new TextEncoder().encode(texts[Math.floor(index / 2)].trim()),
        ),
      "classification must preserve full content hash",
    );
  }
  for (
    const version of ["sherlock.codex-rollout.v1", "sherlock.codex-rollout.v2"]
  ) {
    const historical = await projectBatch(manifest, source, version);
    for (const [index, event] of historical.events.entries()) {
      assert(
        event.message_origin ===
          (version.endsWith("v2") && index === 9 ? "runtime_context" : "human"),
        `${version} interpretation changed at representation ${index}`,
      );
    }
  }
});

Deno.test("normalizer emits observable unknown events for malformed records", async () => {
  const { manifest, source } = await fixture(["not-json"]);

  const projection = await projectBatch(manifest, source);

  assert(projection.events.length === 1);
  assert(projection.events[0].event_kind === "unknown");
  assert(projection.events[0].error_code === "native_malformed");
});

Deno.test("normalizer never parses a native record fragment above 100 MiB", async () => {
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
    native_record_end_offset: 104 * 1024 * 1024 + 7,
    native_record_sha256: "f".repeat(64),
    fragment_index: 0,
    fragment_count: 27,
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
    native_record_end_offset: 104 * 1024 * 1024 + 7,
    native_record_sha256: "f".repeat(64),
    fragment_index: 0,
    fragment_count: 27,
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

Deno.test("Claude hooks for unsaved runs carry transcript_state", async () => {
  const sessionId = "0e80d9f3-de3e-498d-91b1-18beb3790278";
  async function project(
    transcriptState: unknown,
    transcript: Uint8Array | null,
  ) {
    const hook = {
      ...(await claudeHookEnvelope({
        dispatchEventName: "Stop",
        nativeSessionId: sessionId,
        transcript,
        payload: { session_id: sessionId, hook_event_name: "Stop" },
      })),
      transcript_state: transcriptState,
    };
    const { manifest, source } = await fixture([hook]);
    manifest.source_provider = "claude_code";
    manifest.source_kind = "hook";
    manifest.codex_version = null;
    manifest.observed_native_session_id = sessionId;
    return (await projectBatch(manifest, source)).events[0];
  }

  const unsaved = await project("not_saved", null);
  assert(unsaved.event_subtype === "response_complete_unlinked");
  assert(unsaved.attributes?.transcript_state === "not_saved");
  const capturedWithBytes = await project(
    "captured",
    new TextEncoder().encode("sanitized immutable Claude transcript\n"),
  );
  assert(capturedWithBytes.attributes?.transcript_state === "captured");
  // Unknown or inconsistent labels are dropped, never rejected.
  assert(
    (await project("bogus", null)).attributes?.transcript_state === undefined,
  );
  assert(
    (await project("captured", null)).attributes?.transcript_state ===
      undefined,
  );
  assert(
    (await project(undefined, null)).attributes?.transcript_state === undefined,
  );
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

Deno.test("Codex v4 projects response usage once, retaining legacy interpretations", async () => {
  const usage = {
    input_tokens: 100,
    cached_input_tokens: 20,
    cache_write_input_tokens: 30,
    output_tokens: 40,
    reasoning_output_tokens: 10,
    total_tokens: 140,
  };
  const record = {
    timestamp: "2026-10-17T12:00:00Z",
    ordinal: 1,
    type: "token_usage_record",
    payload: {
      thread_id: "child-session",
      session_id: "child-session",
      turn_id: "turn",
      root_turn_id: "root",
      response_id: "response",
      usage,
      turn_token_usage: { ...usage, total_tokens: 999 },
      thread_token_usage: { ...usage, total_tokens: 9999 },
    },
  };
  const data = await fixture([record, record, {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage,
        last_token_usage: usage,
        model_context_window: 200000,
      },
    },
  }]);
  const v4 = await projectBatch(
    data.manifest,
    data.source,
    CODEX_V4_NORMALIZER_VERSION,
  );
  assert(v4.events.length === 3);
  const response = v4.events[0];
  assert(response.event_kind === "usage");
  assert(response.event_subtype === "token_usage_record");
  assert(
    response.usage_scope === "response" &&
      response.usage_is_cumulative === false,
  );
  assert(response.logical_event_key === v4.events[1].logical_event_key);
  assert(response.usage_stream_key === v4.events[1].usage_stream_key);
  assert(response.native_item_id === "response" && response.turn_id === "turn");
  for (const event of [response, v4.events[2]]) {
    assert(event.input_tokens === 50 && event.cached_input_tokens === 50);
    assert(event.output_tokens === 30 && event.reasoning_tokens === 10);
    assert(event.total_tokens === 140);
    assert(event.attributes?.cache_write_input_tokens === 30);
  }
  assert(
    v4.events[2].usage_scope === "session" && v4.events[2].usage_is_cumulative,
  );
  assert(v4.events[2].attributes?.model_context_window === 200000);
  for (
    const version of [
      LEGACY_CODEX_NORMALIZER_VERSION,
      NORMALIZER_VERSION,
      CODEX_V3_NORMALIZER_VERSION,
    ]
  ) {
    const old = await projectBatch(data.manifest, data.source, version);
    assert(old.events[0].event_kind === "unknown");
    assert(
      old.events[2].input_tokens === 80 &&
        old.events[2].cached_input_tokens === 20,
    );
  }
});

Deno.test("Codex v4 accepts absent cache writes but rejects malformed usage and missing response IDs", async () => {
  const valid = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
  const invalid = [
    { ...valid, cache_write_input_tokens: -1 },
    { ...valid, cached_input_tokens: 8, cache_write_input_tokens: 3 },
    { ...valid, cache_write_input_tokens: "1" },
    { ...valid, total_tokens: 16 },
    { ...valid, reasoning_output_tokens: 6 },
    { ...valid, output_tokens: null },
  ];
  const data = await fixture([
    {
      type: "token_usage_record",
      payload: { response_id: "response", usage: valid },
    },
    { type: "token_usage_record", payload: { usage: valid } },
    ...invalid.map((usage) => ({
      type: "token_usage_record",
      payload: { response_id: "response", usage },
    })),
    ...invalid.map((usage) => ({
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: usage } },
    })),
  ]);
  const result = await projectBatch(
    data.manifest,
    data.source,
    CODEX_V4_NORMALIZER_VERSION,
  );
  assert(result.events[0].event_kind === "usage");
  assert(result.events[0].cached_input_tokens === 0);
  for (const event of result.events.slice(1)) {
    assert(event.event_kind === "unknown" && event.error_code !== null);
  }
});

Deno.test("Codex v4 keeps v3 runtime message classification", async () => {
  const data = await fixture([
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "<codex_internal_context>runtime</codex_internal_context>",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "<codex_internal_context>runtime</codex_internal_context>",
        }],
      },
    },
  ]);
  const result = await projectBatch(
    data.manifest,
    data.source,
    CODEX_V4_NORMALIZER_VERSION,
  );
  assert(
    result.events.every((event) =>
      event.message_origin === RUNTIME_CONTEXT_MESSAGE_ORIGIN
    ),
  );
});

const CODEX_FORK_ID = "019a5c5e-7c1d-7d2e-8f3a-4b5c6d7e8f90";
const CODEX_FORK_PARENT_ID = "019a5c5e-0000-7000-8000-000000000001";

async function codexForkHooks(): Promise<Record<string, unknown>[]> {
  return [
    await codexHookEnvelope({
      dispatchEventName: "SessionStart",
      nativeSessionId: CODEX_FORK_ID,
      parentNativeSessionId: CODEX_FORK_PARENT_ID,
      sessionSource: "fork",
      observedAt: "2026-11-05T18:00:00.000000Z",
      payload: {
        hook_event_name: "SessionStart",
        session_id: CODEX_FORK_ID,
        forked_from_id: CODEX_FORK_PARENT_ID,
        cwd: "/repo",
        model: "gpt-5.5-codex",
        transcript_path: null,
        source: "fork",
      },
    }),
    await codexHookEnvelope({
      dispatchEventName: "UserPromptSubmit",
      nativeSessionId: CODEX_FORK_ID,
      sessionSource: "fork",
      observedAt: "2026-11-05T18:00:01.000000Z",
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: CODEX_FORK_ID,
        turn_id: "turn-1",
        cwd: "/repo",
        model: "gpt-5.5-codex",
        transcript_path: null,
        prompt: "  Sanitized side question  ",
      },
    }),
    await codexHookEnvelope({
      dispatchEventName: "Stop",
      nativeSessionId: CODEX_FORK_ID,
      sessionSource: "fork",
      observedAt: "2026-11-05T18:00:05.000000Z",
      payload: {
        hook_event_name: "Stop",
        session_id: CODEX_FORK_ID,
        turn_id: "turn-1",
        cwd: "/repo",
        model: "gpt-5.5-codex",
        transcript_path: null,
        stop_hook_active: false,
        last_assistant_message: "Sanitized side answer",
      },
    }),
  ];
}

Deno.test("Codex fork hooks project a rolloutless session below rollout priority", async () => {
  // SessionStart is the only hook that names the parent; its batch carries it.
  const [start, prompt, stop] = await codexForkHooks();
  const first = await codexHookFixture(
    [start],
    CODEX_FORK_ID,
    CODEX_FORK_PARENT_ID,
  );
  const started = await projectBatch(
    first.manifest,
    first.source,
    CODEX_V4_NORMALIZER_VERSION,
  );
  assert(started.session?.native_session_id === CODEX_FORK_ID);
  assert(
    started.session?.parent_native_session_id === CODEX_FORK_PARENT_ID,
  );
  assert(started.session?.actor_role === "primary");
  assert(started.session?.role_version === ROLE_VERSION);
  assert(started.session?.title === null);
  assert(started.session?.cwd === "/repo");
  assert(started.session?.model === "gpt-5.5-codex");
  assert(
    started.session?.repo_remote ===
      "https://github.com/e3-solutions/sherlock.git",
  );
  assert(started.session?.branch === "main");
  assert(started.session?.started_at === "2026-11-05T18:00:00.000000Z");
  assert(started.session_scm === null);
  const lifecycle = started.events[0];
  assert(lifecycle.event_kind === "lifecycle");
  assert(lifecycle.event_subtype === "session_start");
  assert(lifecycle.source_priority === 90);
  assert(lifecycle.error_code === null);
  assert(
    lifecycle.logical_event_key ===
      `codex:hook:${lifecycle.attributes?.payload_sha256}`,
  );
  assert(lifecycle.canonical_scope_key === `session:${CODEX_FORK_ID}`);
  assert(lifecycle.attributes?.dispatch_event_name === "SessionStart");
  assert(lifecycle.attributes?.session_source === "fork");
  assert(lifecycle.attributes?.source === "fork");
  assert(lifecycle.content_excerpt === null);

  const rest = await codexHookFixture([prompt, stop], CODEX_FORK_ID);
  const continued = await projectBatch(
    rest.manifest,
    rest.source,
    CODEX_V4_NORMALIZER_VERSION,
  );
  // Without SessionStart the batch cannot tell the role; unknown never
  // overwrites the stored one.
  assert(continued.session?.actor_role === "unknown");
  assert(continued.session?.parent_native_session_id === null);
  const [submitted, answered] = continued.events;
  assert(submitted.event_kind === "message");
  assert(submitted.event_subtype === "user_message");
  assert(submitted.message_role === "user");
  assert(submitted.message_origin === "human");
  assert(submitted.turn_id === "turn-1");
  assert(submitted.logical_event_key === "message:user:turn-1");
  assert(submitted.source_priority === 90);
  assert(submitted.observed_at === "2026-11-05T18:00:01.000000Z");
  assert(submitted.cwd === "/repo" && submitted.model === "gpt-5.5-codex");
  // Trimmed exactly like a rollout user_message, so the hashes agree.
  assert(
    submitted.content_sha256 ===
      await sha256Hex(new TextEncoder().encode("Sanitized side question")),
  );
  assert(submitted.content_excerpt === "Sanitized side question");
  assert(answered.event_kind === "agent_message");
  assert(answered.event_subtype === "agent_message");
  assert(answered.message_role === "assistant");
  assert(answered.content_excerpt === "Sanitized side answer");
  assert(
    answered.logical_event_key === "message:assistant:turn-1:hook_stop",
  );
  assert(answered.error_code === null);
});

Deno.test("Codex hook batches project at every Codex normalizer version", async () => {
  const hooks = await codexForkHooks();
  const { manifest, source } = await codexHookFixture(
    hooks.slice(1),
    CODEX_FORK_ID,
  );
  for (
    const version of [
      CODEX_V4_NORMALIZER_VERSION,
      CODEX_V3_NORMALIZER_VERSION,
      NORMALIZER_VERSION,
      LEGACY_CODEX_NORMALIZER_VERSION,
    ]
  ) {
    const projection = await projectBatch(manifest, source, version);
    assert(
      projection.events.map((event) => event.event_subtype).join(",") ===
        "user_message,agent_message",
      `${version} must use the hook projection, never the rollout one`,
    );
  }
  let rejected = false;
  try {
    await projectBatch(manifest, source, CLAUDE_NORMALIZER_VERSION);
  } catch (error) {
    rejected = (error as { code?: string }).code ===
      "unsupported_normalizer_version";
  }
  assert(rejected, "a Claude normalizer must not read Codex hooks");
});

Deno.test("Codex hook projections reject tampered payloads and identity", async () => {
  const [start, prompt] = await codexForkHooks();
  const otherPayload = new TextEncoder().encode(JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: CODEX_FORK_ID,
    prompt: "Forged prompt",
  }));
  const cases: Array<{
    hook: Record<string, unknown> | string;
    error: string;
    parent?: string | null;
    manifestId?: string | null;
  }> = [
    {
      hook: { ...prompt, type: "claude_hook" },
      error: "invalid_codex_hook_schema",
    },
    {
      hook: { ...prompt, schema_version: "sherlock.codex-hook.v2" },
      error: "invalid_codex_hook_schema",
    },
    {
      hook: { ...prompt, collector_observed_at: "2026-11-05T18:00:01+00:00" },
      error: "invalid_codex_hook_observed_at",
    },
    {
      hook: { ...prompt, dispatch_event_name: "PreToolUse" },
      error: "invalid_codex_hook_event",
    },
    {
      hook: { ...prompt, dispatch_event_name: "Stop" },
      error: "invalid_codex_hook_payload_event",
    },
    {
      hook: { ...prompt, payload_sha256: "0".repeat(64) },
      error: "invalid_codex_hook_payload_hash",
    },
    {
      hook: { ...prompt, payload_base64: encodeBase64(otherPayload) },
      error: "invalid_codex_hook_payload_hash",
    },
    {
      hook: { ...prompt, payload_sha256: "short" },
      error: "invalid_codex_hook_payload",
    },
    {
      hook: { ...prompt, native_session_id: CODEX_FORK_PARENT_ID },
      error: "invalid_codex_hook_session",
      manifestId: CODEX_FORK_PARENT_ID,
    },
    {
      hook: prompt,
      error: "invalid_codex_hook_session",
      manifestId: CODEX_FORK_PARENT_ID,
    },
    // A parent the payload never named is not trusted.
    {
      hook: { ...prompt, parent_native_session_id: CODEX_FORK_PARENT_ID },
      error: "invalid_codex_hook_session",
      parent: CODEX_FORK_PARENT_ID,
    },
    // The payload's parent must reach the manifest too.
    { hook: start, error: "invalid_codex_hook_session", parent: null },
    { hook: { ...prompt, git: "main" }, error: "invalid_codex_hook_git" },
    {
      hook: { ...prompt, git: { repository_url: 42, branch: "main" } },
      error: "invalid_codex_hook_git",
    },
    {
      hook: {
        ...prompt,
        git: { repository_url: null, branch: "b".repeat(2049) },
      },
      error: "invalid_codex_hook_git",
    },
    { hook: "{not json", error: "native_malformed" },
  ];
  for (const { hook, error, parent, manifestId } of cases) {
    const { manifest, source } = await codexHookFixture(
      [hook],
      manifestId === undefined ? CODEX_FORK_ID : manifestId,
      parent ?? null,
    );
    const projection = await projectBatch(
      manifest,
      source,
      CODEX_V4_NORMALIZER_VERSION,
    );
    const [event] = projection.events;
    assert(
      event.event_subtype === "hook_invalid" && event.error_code === error,
      `expected ${error}, got ${event.error_code}`,
    );
    assert(event.content_sha256 === null && event.turn_id === null);
    assert(event.logical_event_key === null);
    // Rejected records never contribute session facts.
    assert(projection.session?.cwd === null);
    assert(projection.session?.repo_remote === null);
  }
  const absent = await codexHookFixture([prompt], null);
  const unattributed = await projectBatch(
    absent.manifest,
    absent.source,
    CODEX_V4_NORMALIZER_VERSION,
  );
  assert(unattributed.session === null);
  assert(unattributed.events[0].error_code === "invalid_codex_hook_session");
});

Deno.test("Codex hook prompts classify runtime context and tolerate missing optional fields", async () => {
  const runtime = await codexHookEnvelope({
    dispatchEventName: "UserPromptSubmit",
    nativeSessionId: CODEX_FORK_ID,
    git: null,
    payload: {
      hook_event_name: "UserPromptSubmit",
      session_id: CODEX_FORK_ID,
      prompt:
        "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
    },
  });
  const bare = await codexHookEnvelope({
    dispatchEventName: "UserPromptSubmit",
    nativeSessionId: CODEX_FORK_ID,
    git: { repository_url: null },
    payload: {
      hook_event_name: "UserPromptSubmit",
      session_id: CODEX_FORK_ID,
      prompt: "Plain human question",
    },
  });
  const { manifest, source } = await codexHookFixture(
    [runtime, bare],
    CODEX_FORK_ID,
  );
  const projection = await projectBatch(
    manifest,
    source,
    CODEX_V4_NORMALIZER_VERSION,
  );
  const [context, human] = projection.events;
  assert(context.error_code === null);
  assert(context.message_origin === RUNTIME_CONTEXT_MESSAGE_ORIGIN);
  assert(human.message_origin === "human");
  // No turn_id: the payload hash keys the prompt instead.
  assert(human.turn_id === null);
  assert(
    human.logical_event_key ===
      `codex:hook:${human.attributes?.payload_sha256}`,
  );
  assert(human.attributes?.session_source === undefined);
  assert(human.cwd === null && human.model === null);
  assert(projection.session?.repo_remote === null);
  assert(projection.session?.branch === null);
  assert(projection.session?.cwd === null);
});

Deno.test("Codex Stop hooks without a final message stay observable but contentless", async () => {
  for (const lastAssistantMessage of [undefined, null, "   "]) {
    const stop = await codexHookEnvelope({
      dispatchEventName: "Stop",
      nativeSessionId: CODEX_FORK_ID,
      payload: {
        hook_event_name: "Stop",
        session_id: CODEX_FORK_ID,
        stop_hook_active: false,
        ...(lastAssistantMessage === undefined
          ? {}
          : { last_assistant_message: lastAssistantMessage }),
      },
    });
    const { manifest, source } = await codexHookFixture([stop], CODEX_FORK_ID);
    const [event] = (await projectBatch(
      manifest,
      source,
      CODEX_V4_NORMALIZER_VERSION,
    )).events;
    assert(event.event_kind === "agent_message");
    assert(event.message_role === "assistant");
    assert(event.error_code === "empty_message_content");
    assert(event.content_sha256 === null && event.content_excerpt === null);
    assert(
      event.logical_event_key ===
        `codex:hook:${event.attributes?.payload_sha256}`,
    );
  }
});
