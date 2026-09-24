import { sha256Hex } from "./contract.ts";
import { cursorFixture as fixture } from "./cursor_test_fixture.ts";
import {
  normalizerVersionFor,
  normalizerVersionsFor,
  projectBatch,
} from "./normalizer.ts";
import { CURSOR_NORMALIZER_VERSION } from "./cursor_normalizer.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("Cursor dispatch is distinct from Claude and Codex", async () => {
  const { manifest, source } = await fixture("postToolUse", {
    tool_name: "Shell",
    tool_use_id: "call-1",
  });
  assert(normalizerVersionFor(manifest) === CURSOR_NORMALIZER_VERSION);
  assert(normalizerVersionsFor(manifest).length === 1);
  const result = await projectBatch(manifest, source);
  assert(result.session?.native_session_id === "cursor:parent");
  assert(result.events[0].event_kind === "tool_result");
  assert(result.events[0].tool_status === "completed");
  assert(result.events[0].input_tokens === null);
  assert(
    result.events[0].occurred_at === null,
    "collector time must not become native time",
  );
});

Deno.test("Cursor pre-submit observations do not assert submitted prompts", async () => {
  const { manifest, source } = await fixture("beforeSubmitPrompt", {
    prompt: "hello",
  });
  const event = (await projectBatch(manifest, source)).events[0];
  assert(event.event_subtype === "prompt_attempt");
  assert(event.content_excerpt === "hello");
  assert(
    event.content_sha256 === await sha256Hex(new TextEncoder().encode("hello")),
  );
});

Deno.test("Cursor assistant excerpts are bounded without breaking Unicode", async () => {
  const { manifest, source } = await fixture("afterAgentResponse", {
    text: "界".repeat(1000),
  });
  const event = (await projectBatch(manifest, source)).events[0];
  assert(event.event_kind === "message" && event.message_role === "assistant");
  assert(event.content_byte_size === 3000);
  assert(new TextEncoder().encode(event.content_excerpt!).length <= 1024);
  assert(!event.content_excerpt!.includes("�"));
});

Deno.test("Cursor subagents preserve explicit parent identity", async () => {
  const { manifest, source } = await fixture("subagentStop", {
    subagent_id: "child",
  });
  const result = await projectBatch(manifest, source);
  assert(result.session?.actor_role === "worker");
  assert(result.session?.parent_native_session_id === "cursor:parent");
});

Deno.test("Cursor forged identity is coverage only", async () => {
  const { manifest, source } = await fixture("afterAgentResponse", {
    text: "hello",
  });
  manifest.observed_native_session_id = "cursor:other";
  const result = await projectBatch(manifest, source);
  assert(result.session === null);
  assert(result.events[0].event_kind === "unknown");
  assert(result.events[0].content_excerpt === null);
});

Deno.test("Cursor corrupted raw payload cannot become activity", async () => {
  const { manifest, source } = await fixture("stop");
  const envelope = JSON.parse(new TextDecoder().decode(source));
  envelope.payload_sha256 = "0".repeat(64);
  const corrupted = new TextEncoder().encode(JSON.stringify(envelope) + "\n");
  const result = await projectBatch(manifest, corrupted);
  assert(result.events[0].error_code === "invalid_cursor_hook");
});
