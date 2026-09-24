import { type BatchManifest, CONTRACT_VERSION, sha256Hex } from "./contract.ts";
import { CURSOR_NORMALIZER_VERSION } from "./cursor_normalizer.ts";
export async function cursorFixture(
  event: string,
  fields: Record<string, unknown> = {},
  at = "2026-09-24T12:00:00.000Z",
) {
  const payload = new TextEncoder().encode(JSON.stringify({
    conversation_id: "parent",
    generation_id: "turn-1",
    hook_event_name: event,
    ...fields,
  }));
  const timestamp = at;
  const child = event === "subagentStart" || event === "subagentStop";
  const observationId = crypto.randomUUID();
  const envelope = {
    type: "cursor_hook",
    schema_version: CURSOR_NORMALIZER_VERSION,
    timestamp,
    dispatch_event_name: event,
    observation_id: observationId,
    payload_sha256: await sha256Hex(payload),
    payload_base64: btoa(String.fromCharCode(...payload)),
  };
  const source = new TextEncoder().encode(JSON.stringify(envelope) + "\n");
  const stored = new Uint8Array(
    await new Response(
      new Blob([source]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const manifest: BatchManifest = {
    contract_version: CONTRACT_VERSION,
    source_provider: "cursor",
    source_kind: "hook",
    source_stream_key: "cursor-test-" + observationId,
    generation_key: observationId,
    generation_seq: 0,
    start_offset: 0,
    end_offset: source.length,
    source_byte_count: source.length,
    source_sha256: await sha256Hex(source),
    storage_encoding: "gzip",
    stored_byte_count: stored.length,
    stored_sha256: await sha256Hex(stored),
    record_count: 1,
    records: [{
      record_index: 0,
      source_start_offset: 0,
      source_end_offset: source.length,
      record_sha256: await sha256Hex(source),
      native_type: "cursor_hook",
      native_payload_type: null,
      occurred_at: timestamp,
      parse_status: "ok",
    }],
    observed_native_session_id: child
      ? "cursor:parent:subagent:child"
      : "cursor:parent",
    observed_parent_native_session_id: child ? "cursor:parent" : null,
    first_occurred_at: timestamp,
    last_occurred_at: timestamp,
    codex_version: null,
    source_version: "test",
    collector_version: "test",
  };
  return { manifest, source, stored };
}
