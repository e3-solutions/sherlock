import { CONTRACT_VERSION, sha256Hex } from "./contract.ts";
import { handleRequest, parseWorkloadClassHint } from "./index.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("workload class header is optional and strictly bounded", () => {
  assert(parseWorkloadClassHint(null) === null);
  assert(parseWorkloadClassHint("") === null);
  assert(parseWorkloadClassHint("live") === "live");
  assert(parseWorkloadClassHint("backfill") === "backfill");
  let rejected = false;
  try {
    parseWorkloadClassHint("urgent");
  } catch {
    rejected = true;
  }
  assert(rejected, "unknown scheduling classes must be rejected");
});

async function requestFor(email: string): Promise<Request> {
  const source = new TextEncoder().encode("test\n");
  const compressed = new Blob([source]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  const stored = new Uint8Array(await new Response(compressed).arrayBuffer());
  const body = {
    collector: {
      name: "Test User",
      github_id: "test-user",
      email,
      installation_id: "00000000-0000-4000-8000-000000000001",
    },
    manifest: {
      contract_version: CONTRACT_VERSION,
      source_provider: "codex",
      source_kind: "rollout",
      source_stream_key: "stream-test",
      generation_key: "generation-test",
      generation_seq: 0,
      start_offset: 0,
      end_offset: source.byteLength,
      source_byte_count: source.byteLength,
      source_sha256: await sha256Hex(source),
      storage_encoding: "gzip",
      stored_byte_count: stored.byteLength,
      stored_sha256: await sha256Hex(stored),
      record_count: 1,
      records: [{
        record_index: 0,
        source_start_offset: 0,
        source_end_offset: source.byteLength,
        record_sha256: await sha256Hex(source),
        native_type: "event",
        native_payload_type: null,
        occurred_at: null,
        parse_status: "ok",
      }],
      observed_native_session_id: null,
      observed_parent_native_session_id: null,
      first_occurred_at: null,
      last_occurred_at: null,
      codex_version: null,
      source_version: null,
      collector_version: "test",
    },
    stored_payload_base64: btoa(String.fromCharCode(...stored)),
  };
  return new Request("https://example.test/ingest", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

Deno.test("unknown collector domain is rejected before backend initialization", async () => {
  let backendCalls = 0;
  const response = await handleRequest(
    await requestFor("outsider@example.com"),
    {
      environment: (name) =>
        ({
          SHERLOCK_E3_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
          SHERLOCK_SIXTYFOUR_WORKSPACE_ID:
            "00000000-0000-4000-8000-000000000002",
        })[name],
      backendFactory: (() => {
        backendCalls += 1;
        throw new Error("backend must not initialize");
      }) as never,
    },
  );

  assert(response.status === 403);
  assert(response.headers.get("Cache-Control") === "no-store");
  assert((await response.json()).error.code === "collector_domain_forbidden");
  assert(backendCalls === 0);
});

Deno.test("handler passes the server-selected workspace for each approved domain", async () => {
  for (
    const [email, expectedWorkspaceId] of [
      ["USER@E3GROUP.AI", "00000000-0000-4000-8000-000000000001"],
      ["user@sixtyfour.ai", "00000000-0000-4000-8000-000000000002"],
    ]
  ) {
    let selectedWorkspaceId = "";
    const response = await handleRequest(await requestFor(email), {
      environment: (name) =>
        ({
          SHERLOCK_E3_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
          SHERLOCK_SIXTYFOUR_WORKSPACE_ID:
            "00000000-0000-4000-8000-000000000002",
        })[name],
      backendFactory: (() => ({
        batches: {
          resolveAttribution: (grant: { workspace_id: string }) => {
            selectedWorkspaceId = grant.workspace_id;
            return Promise.resolve({
              workspace_id: grant.workspace_id,
              person_id: "00000000-0000-4000-8000-000000000003",
              collector_key: "team-test",
            });
          },
        },
        service: {
          ingest: (attribution: Record<string, string>) =>
            Promise.resolve({ status: "committed", ...attribution }),
        },
      })) as never,
    });

    assert(response.status === 200);
    assert(selectedWorkspaceId === expectedWorkspaceId);
    assert((await response.json()).workspace_id === expectedWorkspaceId);
  }
});
