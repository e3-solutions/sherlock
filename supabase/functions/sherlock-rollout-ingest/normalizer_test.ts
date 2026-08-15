import { type BatchManifest, CONTRACT_VERSION, sha256Hex } from "./contract.ts";
import { NORMALIZER_VERSION, projectBatch } from "./normalizer.ts";

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
      first_occurred_at: occurred[0] ?? null,
      last_occurred_at: occurred.at(-1) ?? null,
      codex_version: "test",
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
