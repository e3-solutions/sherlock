import {
  type Attribution,
  type BatchManifest,
  BULK_RECEIPT_VERSION,
  type CommittedReceipt,
  CONTRACT_VERSION,
  COVERAGE_QUERY_VERSION,
  IngestError,
  parseBulkEnvelope,
  parseCoverageQuery,
  parseEnvelope,
  RECEIPT_VERSION,
  sha256Hex,
  storagePath,
  timestampMicros,
} from "./contract.ts";
import {
  collectorKeyForIdentity,
  publicCollectorGrant,
} from "./attribution.ts";
import {
  type BatchNormalizer,
  type BatchRepository,
  type ImmutableStorage,
  IngestService,
} from "./service.ts";
import { advisoryLockIdentity, assertExactRecords } from "./postgres.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

async function encodeBulk(
  entries: Array<{
    collector?: typeof COLLECTOR;
    manifest: BatchManifest;
    stored: Uint8Array;
  }>,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const magic = encoder.encode("SHRBULK2");
  const encoded = await Promise.all(entries.map(async (entry) => {
    const metadata = entry.collector
      ? { collector: entry.collector, manifest: entry.manifest }
      : entry.manifest;
    const manifest = encoder.encode(JSON.stringify(metadata));
    const compressed = new Blob([manifest])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    return {
      manifest,
      manifestGzip: new Uint8Array(
        await new Response(compressed).arrayBuffer(),
      ),
      stored: entry.stored,
    };
  }));
  const size = 12 + encoded.reduce(
    (total, entry) =>
      total + 12 + entry.manifestGzip.length + entry.stored.length,
    0,
  );
  const body = new Uint8Array(size);
  body.set(magic);
  const view = new DataView(body.buffer);
  view.setUint32(8, encoded.length);
  let offset = 12;
  for (const entry of encoded) {
    view.setUint32(offset, entry.manifestGzip.length);
    view.setUint32(offset + 4, entry.manifest.length);
    view.setUint32(offset + 8, entry.stored.length);
    offset += 12;
    body.set(entry.manifestGzip, offset);
    offset += entry.manifestGzip.length;
    body.set(entry.stored, offset);
    offset += entry.stored.length;
  }
  return body;
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
        native_record_start_offset: null,
        native_record_end_offset: null,
        native_record_sha256: null,
        fragment_index: null,
        fragment_count: null,
      }],
      observed_native_session_id: null,
      first_occurred_at: null,
      last_occurred_at: null,
      codex_version: null,
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

class MemoryStorage implements ImmutableStorage {
  calls = 0;
  objects = new Map<string, Uint8Array>();

  async ensure(path: string, bytes: Uint8Array): Promise<void> {
    this.calls += 1;
    const existing = this.objects.get(path);
    if (existing && existing.toString() !== bytes.toString()) {
      throw new Error("storage conflict");
    }
    this.objects.set(path, bytes);
  }
}

class MemoryBatches implements BatchRepository {
  receipt: CommittedReceipt | null = null;
  commits = 0;
  failBeforeCommit = false;
  loseResponseAfterCommit = false;

  async findExact(): Promise<CommittedReceipt | null> {
    return this.receipt;
  }

  async commit(
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
    return this.receipt;
  }
}

class MemoryNormalizer implements BatchNormalizer {
  calls = 0;
  failOnce = false;
  sources: string[] = [];

  async normalize(
    _receipt: CommittedReceipt,
    _manifest: BatchManifest,
    source: Uint8Array,
  ): Promise<void> {
    this.calls += 1;
    this.sources.push(new TextDecoder().decode(source));
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("normalizer unavailable");
    }
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

Deno.test("normalization failure retries from the committed raw batch", async () => {
  const { attribution, manifest, stored } = await fixture();
  const storage = new MemoryStorage();
  const batches = new MemoryBatches();
  const normalizer = new MemoryNormalizer();
  normalizer.failOnce = true;
  const service = new IngestService(storage, batches, normalizer);

  await service.ingest(attribution, manifest, stored).then(
    () => assert(false, "first normalization should fail"),
    () => undefined,
  );
  const receipt = await service.ingest(attribution, manifest, stored);

  assert(receipt.status === "committed");
  assert(batches.commits === 1, "raw batch must commit only once");
  assert(storage.calls === 1, "raw object must upload only once");
  assert(normalizer.calls === 2, "normalization must retry after raw commit");
  assert(normalizer.sources.every((source) => source === "test\n"));
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

Deno.test("oversized native record fragments retain their logical identity", async () => {
  const { manifest, stored } = await fixture();
  const nativeRecordHash = "a".repeat(64);
  const parsed = parseEnvelope({
    manifest: {
      ...manifest,
      records: [{
        ...manifest.records[0],
        native_type: null,
        parse_status: "fragment",
        native_record_start_offset: 0,
        native_record_end_offset: 10,
        native_record_sha256: nativeRecordHash,
        fragment_index: 0,
        fragment_count: 2,
      }],
    },
    stored_payload_base64: btoa(String.fromCharCode(...stored)),
  });

  assert(parsed.manifest.records[0].parse_status === "fragment");
  assert(
    parsed.manifest.records[0].native_record_sha256 === nativeRecordHash,
  );
});

Deno.test("compressed binary bulk envelope avoids base64 and preserves order", async () => {
  const { manifest, stored } = await fixture();
  const second = {
    ...manifest,
    start_offset: 5,
    end_offset: 10,
    records: [{
      ...manifest.records[0],
      source_start_offset: 5,
      source_end_offset: 10,
    }],
  };

  const parsed = await parseBulkEnvelope(
    await encodeBulk([
      { collector: COLLECTOR, manifest, stored },
      { collector: COLLECTOR, manifest: second, stored },
    ]),
  );

  assert(parsed.length === 2);
  assert(parsed[0].manifest.start_offset === 0);
  assert(parsed[1].manifest.start_offset === 5);
  assert(parsed[0].collector?.email === "test@example.com");
  assert(parsed[0].stored_payload.byteLength === stored.byteLength);
  assert(BULK_RECEIPT_VERSION === "sherlock.bulk-receipts.v1");
});

Deno.test("binary bulk envelope rejects trailing bytes", async () => {
  const { manifest, stored } = await fixture();
  const encoded = await encodeBulk([{ manifest, stored }]);
  const malformed = new Uint8Array(encoded.length + 1);
  malformed.set(encoded);

  try {
    await parseBulkEnvelope(malformed);
    assert(false, "trailing bytes should fail");
  } catch (error) {
    assert(error instanceof IngestError);
    assert(error.code === "invalid_request");
  }
});

Deno.test("coverage query validates bounded immutable stream identities", () => {
  const parsed = parseCoverageQuery({
    coverage_version: COVERAGE_QUERY_VERSION,
    collector: COLLECTOR,
    streams: [{
      source_kind: "rollout",
      source_stream_key: "stream-test",
      generation_key: "generation-test",
      generation_seq: 2,
      end_offset: 512,
    }],
  });

  assert(parsed.streams.length === 1);
  assert(parsed.streams[0].generation_seq === 2);
  assert(parsed.streams[0].end_offset === 512);
});

Deno.test("coverage query rejects duplicate streams", () => {
  const stream = {
    source_kind: "rollout",
    source_stream_key: "stream-test",
    generation_key: "generation-test",
    generation_seq: 0,
    end_offset: 512,
  };
  try {
    parseCoverageQuery({
      coverage_version: COVERAGE_QUERY_VERSION,
      streams: [stream, stream],
    });
    assert(false, "duplicate coverage streams should fail");
  } catch (error) {
    assert(error instanceof IngestError);
    assert(error.code === "invalid_request");
  }
});

Deno.test("binary bulk envelope bounds decoded manifest expansion", async () => {
  const { manifest, stored } = await fixture();
  const encoded = await encodeBulk([{ manifest, stored }]);
  const view = new DataView(encoded.buffer);
  view.setUint32(16, view.getUint32(16) - 1);

  try {
    await parseBulkEnvelope(encoded);
    assert(false, "manifest expansion beyond its declaration should fail");
  } catch (error) {
    assert(error instanceof IngestError);
    assert(error.code === "payload_too_large");
  }
});

Deno.test("public ingest is scoped to the configured workspace", () => {
  const grant = publicCollectorGrant(
    "00000000-0000-4000-8000-000000000001",
  );

  assert(grant.workspace_id === "00000000-0000-4000-8000-000000000001");
  assert(grant.collector_key_prefix === "team");
  assert(!("person_id" in grant), "configuration must not fix person identity");
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
  const oversizedSource = new Uint8Array(5 * 1024 * 1024 + 1);
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

Deno.test("exact retry rejects changed immutable record locators", async () => {
  const { manifest } = await fixture();
  const committed = manifest.records.map((record) => ({ ...record }));
  committed[0].native_type = "different";

  try {
    assertExactRecords(committed, manifest);
    assert(false, "changed locator should fail exact retry validation");
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
