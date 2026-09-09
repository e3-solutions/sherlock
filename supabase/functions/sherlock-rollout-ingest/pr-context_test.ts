import {
  type BatchManifest,
  CONTRACT_VERSION,
  parseEnvelope,
  sha256Hex,
} from "./contract.ts";
import {
  legacyNormalizerVersionFor,
  normalizerVersionFor,
  projectBatch,
} from "./normalizer.ts";
import { PR_CONTEXT_VERSION } from "./pr-context.ts";
import { validateStoredBatch } from "./service.ts";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
const event = {
  type: PR_CONTEXT_VERSION,
  event_id: "00000000-0000-4000-8000-000000000001",
  operation: "link",
  provider: "codex",
  native_session_id: "session:1",
  occurred_at: "2026-09-09T12:00:00.000001Z",
  repository: "e3-solutions/sherlock",
  pull_request_number: 91,
};
async function fixture(
  value: unknown = event,
  provider: BatchManifest["source_provider"] = "codex",
) {
  const source = new TextEncoder().encode(JSON.stringify(value) + "\n");
  const stored = new Uint8Array(
    await new Response(
      new Blob([source]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const manifest: BatchManifest = {
    contract_version: CONTRACT_VERSION,
    source_provider: provider,
    source_kind: "collector",
    source_stream_key: crypto.randomUUID(),
    generation_key: crypto.randomUUID(),
    generation_seq: 0,
    start_offset: 0,
    end_offset: source.length,
    source_byte_count: source.length,
    source_sha256: await sha256Hex(source),
    storage_encoding: "gzip",
    stored_byte_count: stored.length,
    stored_sha256: await sha256Hex(stored),
    record_count: 1,
    observed_native_session_id: event.native_session_id,
    observed_parent_native_session_id: null,
    source_version: PR_CONTEXT_VERSION,
    codex_version: null,
    collector_version: "test",
    first_occurred_at: null,
    last_occurred_at: null,
    records: [{
      record_index: 0,
      source_start_offset: 0,
      source_end_offset: source.length,
      record_sha256: await sha256Hex(source),
      parse_status: "ok",
      native_type: PR_CONTEXT_VERSION,
      native_payload_type: null,
      occurred_at: null,
    }],
  };
  return { manifest, source, stored };
}
async function rejected(fn: () => Promise<unknown>) {
  let failed = false;
  try {
    await fn();
  } catch {
    failed = true;
  }
  assert(failed);
}
for (const provider of ["codex", "claude_code"] as const) {
  Deno.test(`${provider} sidecars preserve raw bytes and project no session/activity/tokens`, async () => {
    const f = await fixture({ ...event, provider }, provider);
    const raw = new Uint8Array(f.source);
    assert(normalizerVersionFor(f.manifest) === PR_CONTEXT_VERSION);
    assert(legacyNormalizerVersionFor(f.manifest) === PR_CONTEXT_VERSION);
    const p = await projectBatch(
      f.manifest,
      await validateStoredBatch(f.manifest, f.stored),
    );
    assert(
      p.session === null && p.events.length === 0 && p.session_scm === null,
    );
    assert(p.pr_context?.length === 1 && p.pr_context[0].provider === provider);
    assert(p.pr_context[0].occurred_at.endsWith("000001Z"));
    assert(raw.every((v, i) => v === f.source[i]));
    const encoded = btoa(String.fromCharCode(...f.stored));
    assert(
      parseEnvelope({
        collector: {
          name: "Tester",
          github_id: "tester",
          email: "tester@example.com",
          installation_id: crypto.randomUUID(),
        },
        manifest: f.manifest,
        stored_payload_base64: encoded,
      }).manifest.source_kind === "collector",
    );
  });
}
Deno.test("sidecar dispatch refuses native normalizer versions", async () => {
  const f = await fixture();
  await rejected(() =>
    projectBatch(f.manifest, f.source, "sherlock.codex-rollout.v2")
  );
});
Deno.test("multi-record sidecars are rejected before receipt even with valid raw hashes", async () => {
  const f = await fixture();
  const source = new Uint8Array([...f.source, ...f.source]);
  const stored = new Uint8Array(
    await new Response(
      new Blob([source]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const manifest: BatchManifest = {
    ...f.manifest,
    end_offset: source.length,
    source_byte_count: source.length,
    source_sha256: await sha256Hex(source),
    stored_byte_count: stored.length,
    stored_sha256: await sha256Hex(stored),
    record_count: 2,
    records: [f.manifest.records[0], {
      ...f.manifest.records[0],
      record_index: 1,
      source_start_offset: f.source.length,
      source_end_offset: source.length,
    }],
  };
  await rejected(() => validateStoredBatch(manifest, stored));
});
Deno.test("explicit operations reject wrong provider/session/schema and unsupported payloads before receipt", async () => {
  for (
    const changed of [
      { provider: "claude_code" },
      { native_session_id: "other" },
      { type: "unknown.v2" },
      { operation: "finish" },
      { repository: "https://private.example/foo" },
      { repository: "owner/.." },
      { pull_request_number: 0 },
      { pull_request_number: 2147483648 },
      { event_id: "invalid" },
      { occurred_at: "2026-02-30T00:00:00Z" },
      { author: "untrusted" },
      { link_event_id: crypto.randomUUID() },
    ]
  ) {
    const f = await fixture({ ...event, ...changed });
    await rejected(() => validateStoredBatch(f.manifest, f.stored));
  }
});
Deno.test("collector kind supports only narrowly versioned context and no parent inheritance", async () => {
  const f = await fixture();
  for (
    const changed of [
      { source_version: null },
      { source_version: "sherlock.pr-context.v2" },
      { observed_parent_native_session_id: "parent" },
      { observed_native_session_id: null },
    ]
  ) {
    await rejected(() =>
      validateStoredBatch({ ...f.manifest, ...changed }, f.stored)
    );
  }
});
Deno.test("retractions refer to link IDs even before link arrives and carry no target URL", async () => {
  const { repository: _repo, pull_request_number: _pr, ...base } = event;
  const retract = {
    ...base,
    operation: "retract",
    event_id: crypto.randomUUID(),
    link_event_id: event.event_id,
  };
  const f = await fixture(retract);
  const p = await projectBatch(f.manifest, f.source);
  assert(
    p.pr_context?.[0].link_event_id === event.event_id &&
      p.pr_context[0].repository === null,
  );
  const invalid = await fixture({
    ...retract,
    link_event_id: retract.event_id,
  });
  await rejected(() => projectBatch(invalid.manifest, invalid.source));
});
Deno.test("semantic dedup hashes canonical repository/time but preserve microsecond conflicts", async () => {
  const values = [
    event,
    {
      ...event,
      repository: "E3-Solutions/Sherlock",
      occurred_at: "2026-09-09T08:00:00.000001-04:00",
    },
    { ...event, occurred_at: "2026-09-09T12:00:00.000002Z" },
    { ...event, native_session_id: "other" },
  ];
  const hashes = [];
  for (const value of values) {
    const f = await fixture(value);
    f.manifest.observed_native_session_id = value.native_session_id;
    hashes.push(
      (await projectBatch(f.manifest, f.source)).pr_context![0].payload_sha256,
    );
  }
  assert(
    hashes[0] === hashes[1] && hashes[0] !== hashes[2] &&
      hashes[0] !== hashes[3],
  );
});
