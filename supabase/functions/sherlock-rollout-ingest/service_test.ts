import {
  type Attribution,
  type BatchManifest,
  type CommittedReceipt,
  CONTRACT_VERSION,
  decodeBase64Bytes,
  FRAGMENT_SOURCE_BYTES,
  IngestError,
  MAX_LOGICAL_RECORD_BYTES,
  MAX_SOURCE_BYTES,
  MAX_STORED_BYTES,
  parseEnvelope,
  RECEIPT_VERSION,
  sha256Hex,
  storagePath,
  timestampMicros,
  validateManifest,
} from "./contract.ts";
import {
  collectorKeyForIdentity,
  publicCollectorGrant,
  workspaceRoutingConfig,
} from "./attribution.ts";
import {
  type BatchRepository,
  type ImmutableStorage,
  IngestService,
  validateStoredBatch,
} from "./service.ts";
import { advisoryLockIdentity, assertExactRecords } from "./postgres.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

const COLLECTOR = {
  name: "Test User",
  github_id: "test-user",
  email: "test@example.com",
  installation_id: "00000000-0000-4000-8000-000000000001",
};

async function fixture(): Promise<{
  attribution: Attribution;
  manifest: BatchManifest;
  stored: Uint8Array;
}> {
  const source = new TextEncoder().encode("test\n");
  const compressed = new Blob([source]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  const stored = new Uint8Array(await new Response(compressed).arrayBuffer());
  const digest = await sha256Hex(stored);
  return {
    attribution: {
      workspace_id: "00000000-0000-4000-8000-000000000001",
      person_id: "00000000-0000-4000-8000-000000000002",
      collector_key: "collector-test",
    },
    manifest: {
      contract_version: CONTRACT_VERSION,
      source_provider: "codex",
      source_kind: "rollout",
      source_stream_key: "stream-test",
      generation_key: "generation-test",
      generation_seq: 0,
      start_offset: 0,
      end_offset: 5,
      source_byte_count: 5,
      source_sha256: await sha256Hex(source),
      storage_encoding: "gzip",
      stored_byte_count: stored.byteLength,
      stored_sha256: digest,
      record_count: 1,
      records: [{
        record_index: 0,
        source_start_offset: 0,
        source_end_offset: 5,
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
    stored,
  };
}

function makeReceipt(
  attribution: Attribution,
  manifest: BatchManifest,
): CommittedReceipt {
  return {
    receipt_version: RECEIPT_VERSION,
    status: "committed",
    batch_id: "00000000-0000-4000-8000-000000000003",
    ...attribution,
    source_kind: "rollout",
    source_stream_key: manifest.source_stream_key,
    generation_key: manifest.generation_key,
    generation_seq: manifest.generation_seq,
    start_offset: manifest.start_offset,
    end_offset: manifest.end_offset,
    source_byte_count: manifest.source_byte_count,
    source_sha256: manifest.source_sha256,
    storage_path: storagePath(attribution, manifest),
    stored_byte_count: manifest.stored_byte_count,
    stored_sha256: manifest.stored_sha256,
    record_count: manifest.record_count,
    contract_version: CONTRACT_VERSION,
    committed_at: "2026-08-14T00:00:00.000Z",
  };
}

function fragmentManifest(
  manifest: BatchManifest,
  fragmentIndex = 1,
  logicalBytes = 20 * 1024 * 1024 + 7,
): BatchManifest {
  const logicalStart = 123;
  const logicalEnd = logicalStart + logicalBytes;
  const fragmentCount = Math.ceil(logicalBytes / FRAGMENT_SOURCE_BYTES);
  const startOffset = logicalStart + fragmentIndex * FRAGMENT_SOURCE_BYTES;
  const endOffset = Math.min(
    startOffset + FRAGMENT_SOURCE_BYTES,
    logicalEnd,
  );
  return {
    ...manifest,
    start_offset: startOffset,
    end_offset: endOffset,
    source_byte_count: endOffset - startOffset,
    source_sha256: "b".repeat(64),
    record_count: 1,
    records: [{
      record_index: 0,
      source_start_offset: startOffset,
      source_end_offset: endOffset,
      record_sha256: "b".repeat(64),
      native_type: null,
      native_payload_type: null,
      occurred_at: null,
      parse_status: "fragment",
      native_record_start_offset: logicalStart,
      native_record_end_offset: logicalEnd,
      native_record_sha256: "c".repeat(64),
      fragment_index: fragmentIndex,
      fragment_count: fragmentCount,
    }],
  };
}

class MemoryStorage implements ImmutableStorage {
  calls = 0;
  objects = new Map<string, Uint8Array>();

  ensure(path: string, bytes: Uint8Array): Promise<void> {
    this.calls += 1;
    const existing = this.objects.get(path);
    if (existing && existing.toString() !== bytes.toString()) {
      throw new Error("storage conflict");
    }
    this.objects.set(path, bytes);
    return Promise.resolve();
  }
}

class MemoryBatches implements BatchRepository {
  receipt: CommittedReceipt | null = null;
  commits = 0;
  failBeforeCommit = false;
  loseResponseAfterCommit = false;

  findExact(): Promise<CommittedReceipt | null> {
    return Promise.resolve(this.receipt);
  }

  commit(
    attribution: Attribution,
    manifest: BatchManifest,
  ): Promise<CommittedReceipt> {
    this.commits += 1;
    if (this.failBeforeCommit) {
      this.failBeforeCommit = false;
      throw new Error("database unavailable");
    }
    this.receipt = makeReceipt(attribution, manifest);
    if (this.loseResponseAfterCommit) {
      this.loseResponseAfterCommit = false;
      throw new Error("response lost after commit");
    }
    return Promise.resolve(this.receipt);
  }
}

Deno.test("exact retry returns the stable existing receipt", async () => {
  const { attribution, manifest, stored } = await fixture();
  const storage = new MemoryStorage();
  const batches = new MemoryBatches();
  const service = new IngestService(storage, batches);

  const first = await service.ingest(attribution, manifest, stored);
  const second = await service.ingest(attribution, manifest, stored);

  assert(JSON.stringify(first) === JSON.stringify(second), "receipts differ");
  assert(
    storage.calls === 1,
    "exact retry should not re-upload committed storage",
  );
  assert(batches.commits === 1, "exact retry should not insert a second batch");
});

Deno.test("storage success and database failure converges on retry", async () => {
  const { attribution, manifest, stored } = await fixture();
  const storage = new MemoryStorage();
  const batches = new MemoryBatches();
  batches.failBeforeCommit = true;
  const service = new IngestService(storage, batches);

  await service.ingest(attribution, manifest, stored).then(
    () => assert(false, "first attempt should fail"),
    () => undefined,
  );
  const receipt = await service.ingest(attribution, manifest, stored);

  assert(receipt.status === "committed");
  assert(
    storage.objects.size === 1,
    "storage retry must preserve one immutable object",
  );
  assert(batches.commits === 2, "database commit should be retried");
});

Deno.test("database success and response loss converges on exact lookup", async () => {
  const { attribution, manifest, stored } = await fixture();
  const storage = new MemoryStorage();
  const batches = new MemoryBatches();
  batches.loseResponseAfterCommit = true;
  const service = new IngestService(storage, batches);

  await service.ingest(attribution, manifest, stored).then(
    () => assert(false, "first response should be lost"),
    () => undefined,
  );
  const receipt = await service.ingest(attribution, manifest, stored);

  assert(receipt.status === "committed");
  assert(
    batches.commits === 1,
    "retry must return the already committed batch",
  );
  assert(
    storage.calls === 1,
    "retry must not touch Storage after database commit",
  );
});

Deno.test("durable acceptance returns without a normalization dependency", async () => {
  const { attribution, manifest, stored } = await fixture();
  const storage = new MemoryStorage();
  const batches = new MemoryBatches();
  const service = new IngestService(storage, batches);
  const receipt = await service.ingest(attribution, manifest, stored);

  assert(receipt.status === "committed");
  assert(batches.commits === 1, "raw batch must commit only once");
  assert(storage.calls === 1, "raw object must upload only once");
});

Deno.test("strict timestamp validation rejects impossible calendar dates", async () => {
  const { manifest, stored } = await fixture();
  const storedPayloadBase64 = btoa(String.fromCharCode(...stored));

  try {
    parseEnvelope({
      collector: COLLECTOR,
      manifest: {
        ...manifest,
        first_occurred_at: "2026-02-30T00:00:00Z",
        last_occurred_at: "2026-02-30T00:00:00Z",
      },
      stored_payload_base64: storedPayloadBase64,
    });
    assert(false, "invalid date should fail");
  } catch (error) {
    assert(error instanceof IngestError);
    assert(error.status === 400);
  }
});

Deno.test("base64 decoding preserves padding rules across runtimes", () => {
  for (const encoded of ["dGVzdA==", "dGVzdA", " dGVz\ndA== "]) {
    assert(new TextDecoder().decode(decodeBase64Bytes(encoded)) === "test");
  }
  for (const encoded of ["dGVzdA=", "dGVzdA===", "A===", "!!!!"]) {
    try {
      decodeBase64Bytes(encoded);
      assert(false, `${encoded} should be rejected`);
    } catch (error) {
      assert(error instanceof SyntaxError);
    }
  }
});

Deno.test("ingest base64 size gate runs before decoding", async () => {
  const { manifest } = await fixture();
  const maximumEncodedLength = Math.ceil(MAX_STORED_BYTES / 3) * 4;
  try {
    parseEnvelope({
      collector: COLLECTOR,
      manifest,
      stored_payload_base64: "A".repeat(maximumEncodedLength + 1),
    });
    assert(false, "oversized encoded payload should fail");
  } catch (error) {
    assert(error instanceof IngestError);
    assert(error.code === "payload_too_large");
    assert(error.status === 413);
  }
});

Deno.test("SHA-256 hashes only a non-zero-offset Uint8Array view", async () => {
  const backing = new Uint8Array([99, 1, 2, 3, 100]);
  const view = backing.subarray(1, 4);
  assert(
    await sha256Hex(view) === await sha256Hex(new Uint8Array([1, 2, 3])),
  );
  assert(await sha256Hex(view) !== await sha256Hex(backing));
});

Deno.test("approved collector domains resolve to configured workspaces", () => {
  const routing = workspaceRoutingConfig(
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  );
  const grant = publicCollectorGrant(routing, {
    ...COLLECTOR,
    email: "test@e3group.ai",
  });
  const sixtyfourGrant = publicCollectorGrant(routing, {
    ...COLLECTOR,
    email: "test@sixtyfour.ai",
  });

  assert(grant.workspace_id === "00000000-0000-4000-8000-000000000001");
  assert(
    sixtyfourGrant.workspace_id === "00000000-0000-4000-8000-000000000002",
  );
  assert(grant.collector_key_prefix === "team");
  assert(!("person_id" in grant), "configuration must not fix person identity");
});

Deno.test("workspace routing rejects invalid configuration and unknown domains", () => {
  for (
    const values of [
      ["", "00000000-0000-4000-8000-000000000002"],
      ["invalid", "00000000-0000-4000-8000-000000000002"],
      [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000001",
      ],
    ]
  ) {
    try {
      workspaceRoutingConfig(values[0], values[1]);
      assert(false, "invalid routing configuration must fail");
    } catch (error) {
      assert(error instanceof IngestError);
      assert(error.code === "invalid_configuration");
      assert(error.status === 500);
    }
  }

  const routing = workspaceRoutingConfig(
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  );
  for (
    const email of [
      "test@example.com",
      "test@sub.e3group.ai",
      "test@e3group.ai.example",
    ]
  ) {
    try {
      publicCollectorGrant(routing, { ...COLLECTOR, email });
      assert(false, "unknown collector domain must fail");
    } catch (error) {
      assert(error instanceof IngestError);
      assert(error.code === "collector_domain_forbidden");
      assert(error.status === 403);
    }
  }
});

Deno.test("collector keys distinguish machines while email remains the person key", async () => {
  const grant = {
    workspace_id: "00000000-0000-4000-8000-000000000001",
    collector_key_prefix: "team",
  };
  const first = await collectorKeyForIdentity(grant, COLLECTOR);
  const repeat = await collectorKeyForIdentity(grant, COLLECTOR);
  const secondMachine = await collectorKeyForIdentity(grant, {
    ...COLLECTOR,
    installation_id: "00000000-0000-4000-8000-000000000002",
  });

  assert(first === repeat, "one installation must keep a stable collector key");
  assert(
    first !== secondMachine,
    "two installations must have distinct collector keys",
  );
  assert(first.startsWith("team-"));
});

Deno.test("streaming decompression rejects a small gzip bomb", async () => {
  const { attribution, manifest } = await fixture();
  const oversizedSource = new Uint8Array(MAX_SOURCE_BYTES + 1);
  const compressed = new Blob([oversizedSource.buffer])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const stored = new Uint8Array(await new Response(compressed).arrayBuffer());
  const maliciousManifest = {
    ...manifest,
    stored_byte_count: stored.byteLength,
    stored_sha256: await sha256Hex(stored),
  };
  const service = new IngestService(new MemoryStorage(), new MemoryBatches());

  try {
    await service.ingest(attribution, maliciousManifest, stored);
    assert(false, "oversized expansion should fail");
  } catch (error) {
    assert(error instanceof IngestError);
    assert(error.code === "payload_too_large");
  }
});

Deno.test("manifest limits admit 16 MiB source and 17 MiB stored batches", async () => {
  const { manifest } = await fixture();
  const maximum = {
    ...manifest,
    start_offset: 0,
    end_offset: MAX_SOURCE_BYTES,
    source_byte_count: MAX_SOURCE_BYTES,
    stored_byte_count: MAX_STORED_BYTES,
    records: [{
      ...manifest.records[0],
      source_start_offset: 0,
      source_end_offset: MAX_SOURCE_BYTES,
    }],
  };
  validateManifest(maximum);

  for (
    const candidate of [
      {
        ...maximum,
        end_offset: MAX_SOURCE_BYTES + 1,
        source_byte_count: MAX_SOURCE_BYTES + 1,
      },
      { ...maximum, stored_byte_count: MAX_STORED_BYTES + 1 },
    ]
  ) {
    try {
      validateManifest(candidate);
      assert(false, "oversized manifest should fail");
    } catch (error) {
      assert(error instanceof IngestError);
      assert(error.code === "payload_too_large");
    }
  }
});

Deno.test("stored validation accepts an actual 16 MiB source", async () => {
  const { manifest } = await fixture();
  const source = new Uint8Array(MAX_SOURCE_BYTES);
  const compressed = new Blob([source.buffer]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  const stored = new Uint8Array(await new Response(compressed).arrayBuffer());
  const sourceSha256 = await sha256Hex(source);
  const maximum = {
    ...manifest,
    end_offset: MAX_SOURCE_BYTES,
    source_byte_count: MAX_SOURCE_BYTES,
    source_sha256: sourceSha256,
    stored_byte_count: stored.byteLength,
    stored_sha256: await sha256Hex(stored),
    records: [{
      ...manifest.records[0],
      source_end_offset: MAX_SOURCE_BYTES,
      record_sha256: sourceSha256,
    }],
  };

  const decoded = await validateStoredBatch(maximum, stored);
  assert(decoded.byteLength === MAX_SOURCE_BYTES);
});

Deno.test("fragment manifests use the deterministic 4 MiB partition", async () => {
  const { manifest, stored } = await fixture();
  const fragmented = fragmentManifest(manifest);
  validateManifest(fragmented);

  const parsed = parseEnvelope({
    collector: COLLECTOR,
    manifest: fragmented,
    stored_payload_base64: btoa(String.fromCharCode(...stored)),
  });
  assert(parsed.manifest.records[0].parse_status === "fragment");
  assert(parsed.manifest.records[0].fragment_index === 1);
  assert(parsed.manifest.records[0].fragment_count === 6);
});

Deno.test("fragment manifests reject incomplete or non-deterministic metadata", async () => {
  const { manifest } = await fixture();
  const fragmented = fragmentManifest(manifest);
  const record = fragmented.records[0];
  const candidates: BatchManifest[] = [
    {
      ...fragmented,
      records: [{ ...record, native_record_sha256: null }],
    },
    {
      ...fragmented,
      records: [{ ...record, fragment_count: 4 }],
    },
    {
      ...fragmented,
      records: [{ ...record, native_type: "event_msg" }],
    },
    fragmentManifest(manifest, 1, MAX_SOURCE_BYTES),
    {
      ...fragmented,
      start_offset: fragmented.start_offset + 1,
      source_byte_count: fragmented.source_byte_count - 1,
      records: [{
        ...record,
        source_start_offset: fragmented.start_offset + 1,
      }],
    },
    fragmentManifest(manifest, 1, MAX_LOGICAL_RECORD_BYTES + 1),
    {
      ...manifest,
      records: [{
        ...manifest.records[0],
        native_record_start_offset: 0,
      }],
    },
  ];

  for (const candidate of candidates) {
    try {
      validateManifest(candidate);
      assert(false, "invalid fragment manifest should fail");
    } catch (error) {
      assert(error instanceof IngestError);
      assert(
        error.code === "invalid_manifest" || error.code === "payload_too_large",
      );
    }
  }
});

Deno.test("exact retry rejects changed immutable record locators", async () => {
  const { manifest } = await fixture();
  const committed = manifest.records.map((record) => ({ ...record }));
  assertExactRecords(committed, manifest);
  committed[0].native_type = "different";

  try {
    assertExactRecords(committed, manifest);
    assert(false, "changed locator should fail exact retry validation");
  } catch (error) {
    assert(error instanceof IngestError);
    assert(error.code === "record_identity_conflict");
  }
});

Deno.test("exact retry includes immutable fragment identity", async () => {
  const { manifest } = await fixture();
  const fragmented = fragmentManifest(manifest);
  const committed = fragmented.records.map((record) => ({ ...record }));
  assertExactRecords(committed, fragmented);
  committed[0].fragment_index = 0;

  try {
    assertExactRecords(committed, fragmented);
    assert(
      false,
      "changed fragment identity should fail exact retry validation",
    );
  } catch (error) {
    assert(error instanceof IngestError);
    assert(error.code === "record_identity_conflict");
  }
});

Deno.test("timestamp identity preserves PostgreSQL microseconds", () => {
  assert(
    timestampMicros("2026-08-14T00:00:00.123456Z") !==
      timestampMicros("2026-08-14T00:00:00.123999Z"),
  );
});

Deno.test("advisory lock identity is PostgreSQL-safe and tuple-distinct", async () => {
  const { attribution, manifest } = await fixture();
  const identity = advisoryLockIdentity(attribution, manifest);
  const first = advisoryLockIdentity(
    { ...attribution, collector_key: "collector:rollout" },
    { ...manifest, source_stream_key: "stream" },
  );
  const second = advisoryLockIdentity(
    { ...attribution, collector_key: "collector" },
    { ...manifest, source_stream_key: "rollout:stream" },
  );

  assert(!identity.includes("\u0000"), "PostgreSQL text cannot contain NUL");
  assert(first !== second, "tuple boundaries must remain unambiguous");
});

Deno.test("ingest parses Claude transcripts without relabeling them as rollouts", async () => {
  const { manifest, stored } = await fixture();
  const value = parseEnvelope({
    collector: COLLECTOR,
    manifest: {
      ...manifest,
      source_provider: "claude_code",
      source_kind: "transcript",
      observed_native_session_id: "claude-session",
      observed_parent_native_session_id: null,
      codex_version: null,
      source_version: "2.0.59",
    },
    stored_payload_base64: btoa(String.fromCharCode(...stored)),
  });

  assert(value.manifest.source_provider === "claude_code");
  assert(value.manifest.source_kind === "transcript");
  assert(value.manifest.source_version === "2.0.59");
  assert(
    storagePath({
      workspace_id: "00000000-0000-4000-8000-000000000001",
      person_id: "00000000-0000-4000-8000-000000000002",
      collector_key: "collector-test",
    }, value.manifest).includes("/transcript/"),
  );
});

Deno.test("ingest accepts Claude hook evidence but rejects Codex hook batches", async () => {
  const { manifest, stored } = await fixture();
  const hookManifest = {
    ...manifest,
    source_provider: "claude_code",
    source_kind: "hook",
    observed_native_session_id: "claude-session",
    observed_parent_native_session_id: null,
    codex_version: null,
    source_version: "2.0.59",
  };
  const value = parseEnvelope({
    collector: COLLECTOR,
    manifest: hookManifest,
    stored_payload_base64: btoa(String.fromCharCode(...stored)),
  });
  assert(value.manifest.source_kind === "hook");
  assert(
    storagePath({
      workspace_id: "00000000-0000-4000-8000-000000000001",
      person_id: "00000000-0000-4000-8000-000000000002",
      collector_key: "collector-test",
    }, value.manifest).includes("/hook/"),
  );

  try {
    parseEnvelope({
      collector: COLLECTOR,
      manifest: { ...hookManifest, source_provider: "codex" },
      stored_payload_base64: btoa(String.fromCharCode(...stored)),
    });
    assert(false, "Codex hook batches must remain unsupported");
  } catch (error) {
    assert(error instanceof IngestError);
    assert(error.code === "unsupported_contract");
  }
});
