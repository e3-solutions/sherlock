import postgres from "npm:postgres@3.4.7";
import {
  type BatchManifest,
  type CommittedReceipt,
  CONTRACT_VERSION,
  RECEIPT_VERSION,
  sha256Hex,
} from "./contract.ts";
import { PostgresBatchNormalizer } from "./normalizer_postgres.ts";

const permission = await Deno.permissions.query({
  name: "env",
  variable: "SHERLOCK_TEST_DATABASE_URL",
});
const databaseUrl = permission.state === "granted"
  ? Deno.env.get("SHERLOCK_TEST_DATABASE_URL")
  : null;

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

interface BatchFixture {
  receipt: CommittedReceipt;
  manifest: BatchManifest;
  source: Uint8Array;
}

async function seedBatch(
  sql: ReturnType<typeof postgres>,
  input: {
    workspaceId: string;
    personId: string;
    collectorKey: string;
    nativeSessionId: string;
    parentNativeSessionId?: string;
  },
): Promise<BatchFixture> {
  const batchId = crypto.randomUUID();
  const timestamp = "2026-08-17T00:00:00.000Z";
  const source = new TextEncoder().encode(`${
    JSON.stringify({
      timestamp,
      type: "session_meta",
      payload: {
        id: input.nativeSessionId,
        ...(input.parentNativeSessionId
          ? {
            session_id: input.parentNativeSessionId,
            parent_thread_id: input.parentNativeSessionId,
            source: { subagent: { other: "worker" } },
          }
          : {}),
      },
    })
  }\n`);
  const sourceSha256 = await sha256Hex(source);
  const recordSha256 = await sha256Hex(source);
  const storagePath = `normalizer-integration/${batchId}.jsonl.gz`;
  const sourceStreamKey = `stream-${batchId}`;
  const generationKey = `generation-${batchId}`;
  const manifest: BatchManifest = {
    contract_version: CONTRACT_VERSION,
    source_kind: "rollout",
    source_stream_key: sourceStreamKey,
    generation_key: generationKey,
    generation_seq: 0,
    start_offset: 0,
    end_offset: source.byteLength,
    source_byte_count: source.byteLength,
    source_sha256: sourceSha256,
    storage_encoding: "gzip",
    stored_byte_count: 1,
    stored_sha256: "a".repeat(64),
    record_count: 1,
    records: [{
      record_index: 0,
      source_start_offset: 0,
      source_end_offset: source.byteLength,
      record_sha256: recordSha256,
      native_type: "session_meta",
      native_payload_type: null,
      occurred_at: timestamp,
      parse_status: "ok",
    }],
    observed_native_session_id: input.nativeSessionId,
    first_occurred_at: timestamp,
    last_occurred_at: timestamp,
    codex_version: "integration-test",
    collector_version: "integration-test",
  };
  const receipt: CommittedReceipt = {
    receipt_version: RECEIPT_VERSION,
    status: "committed",
    batch_id: batchId,
    workspace_id: input.workspaceId,
    person_id: input.personId,
    collector_key: input.collectorKey,
    source_kind: "rollout",
    source_stream_key: sourceStreamKey,
    generation_key: generationKey,
    generation_seq: 0,
    start_offset: 0,
    end_offset: source.byteLength,
    source_byte_count: source.byteLength,
    source_sha256: sourceSha256,
    storage_path: storagePath,
    stored_byte_count: 1,
    stored_sha256: "a".repeat(64),
    record_count: 1,
    contract_version: CONTRACT_VERSION,
    committed_at: timestamp,
  };
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `insert into telemetry.ingest_batches (
         id, workspace_id, person_id, collector_key, source_kind,
         source_stream_key, generation_key, generation_seq, start_offset,
         end_offset, source_byte_count, source_sha256, storage_path,
         storage_encoding, stored_byte_count, stored_sha256, record_count,
         contract_version, first_occurred_at, last_occurred_at, committed_at
       ) values (
         $1, $2, $3, $4, 'rollout', $5, $6, 0, 0, $7, $7, $8, $9,
         'gzip', 1, $10, 1, $11, $12, $12, $12
       )`,
      [
        batchId,
        input.workspaceId,
        input.personId,
        input.collectorKey,
        sourceStreamKey,
        generationKey,
        source.byteLength,
        sourceSha256,
        storagePath,
        "a".repeat(64),
        CONTRACT_VERSION,
        timestamp,
      ],
    );
    await tx.unsafe(
      `insert into telemetry.native_records (
         workspace_id, batch_id, record_index, source_start_offset,
         source_end_offset, record_sha256, native_type, occurred_at,
         parse_status
       ) values ($1, $2, 0, 0, $3, $4, 'session_meta', $5, 'ok')`,
      [
        input.workspaceId,
        batchId,
        source.byteLength,
        recordSha256,
        timestamp,
      ],
    );
  });
  return { receipt, manifest, source };
}

async function normalize(
  normalizer: PostgresBatchNormalizer,
  fixture: BatchFixture,
): Promise<string> {
  const result = await normalizer.normalize(
    fixture.receipt,
    fixture.manifest,
    fixture.source,
  );
  assert(
    result.session_ids.length === 1,
    "normalization must return one session",
  );
  return result.session_ids[0];
}

async function assertParentLink(
  sql: ReturnType<typeof postgres>,
  workspaceId: string,
  collectorKey: string,
  childNativeSessionId: string,
  parentNativeSessionId: string,
): Promise<void> {
  const rows = await sql.unsafe(
    `select child.parent_session_id, parent.id as expected_parent_session_id
       from telemetry.sessions child
       join telemetry.sessions parent
         on parent.workspace_id = child.workspace_id
        and parent.collector_key = child.collector_key
        and parent.person_id = child.person_id
        and parent.native_session_id = $4
      where child.workspace_id = $1 and child.collector_key = $2
        and child.native_session_id = $3`,
    [
      workspaceId,
      collectorKey,
      childNativeSessionId,
      parentNativeSessionId,
    ],
  );
  assert(rows.length === 1, "expected child and parent sessions");
  assert(
    rows[0].parent_session_id === rows[0].expected_parent_session_id,
    `expected ${childNativeSessionId} to link to ${parentNativeSessionId}`,
  );
}

Deno.test({
  name:
    "Postgres normalizer repairs parent-first, child-first, replayed, and concurrent session trees",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 8 });
    const firstNormalizer = PostgresBatchNormalizer.connect(databaseUrl!);
    const secondNormalizer = PostgresBatchNormalizer.connect(databaseUrl!);
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const otherPersonId = crypto.randomUUID();
    const collectorKey = `normalizer-${workspaceId}`;
    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name)
         values ($1, $2, 'Normalizer integration test')`,
        [workspaceId, `normalizer-${workspaceId}`],
      );
      await sql.unsafe(
        `insert into telemetry.people (id, workspace_id, identity_key)
         values ($1, $3, 'normalizer-person'),
                ($2, $3, 'normalizer-other-person')`,
        [personId, otherPersonId, workspaceId],
      );

      const parentFirstParent = await seedBatch(sql, {
        workspaceId,
        personId,
        collectorKey,
        nativeSessionId: "parent-first-parent",
      });
      const parentFirstChild = await seedBatch(sql, {
        workspaceId,
        personId,
        collectorKey,
        nativeSessionId: "parent-first-child",
        parentNativeSessionId: "parent-first-parent",
      });
      await normalize(firstNormalizer, parentFirstParent);
      await normalize(firstNormalizer, parentFirstChild);
      await assertParentLink(
        sql,
        workspaceId,
        collectorKey,
        "parent-first-child",
        "parent-first-parent",
      );

      const childFirstChild = await seedBatch(sql, {
        workspaceId,
        personId,
        collectorKey,
        nativeSessionId: "child-first-child",
        parentNativeSessionId: "child-first-parent",
      });
      const childFirstParent = await seedBatch(sql, {
        workspaceId,
        personId,
        collectorKey,
        nativeSessionId: "child-first-parent",
      });
      const childSessionId = await normalize(firstNormalizer, childFirstChild);
      const unresolved = await sql.unsafe(
        `select parent_session_id from telemetry.sessions
          where workspace_id = $1 and id = $2`,
        [workspaceId, childSessionId],
      );
      assert(
        unresolved[0].parent_session_id === null,
        "child must begin unresolved",
      );
      const parentSessionId = await normalize(
        firstNormalizer,
        childFirstParent,
      );
      await assertParentLink(
        sql,
        workspaceId,
        collectorKey,
        "child-first-child",
        "child-first-parent",
      );
      assert(
        await normalize(firstNormalizer, childFirstChild) === childSessionId,
        "child replay must preserve its session id",
      );
      assert(
        await normalize(firstNormalizer, childFirstParent) === parentSessionId,
        "parent replay must preserve its session id",
      );

      const concurrentChild = await seedBatch(sql, {
        workspaceId,
        personId,
        collectorKey,
        nativeSessionId: "concurrent-child",
        parentNativeSessionId: "concurrent-parent",
      });
      const concurrentParent = await seedBatch(sql, {
        workspaceId,
        personId,
        collectorKey,
        nativeSessionId: "concurrent-parent",
      });
      await Promise.all([
        normalize(firstNormalizer, concurrentChild),
        normalize(secondNormalizer, concurrentParent),
      ]);
      await assertParentLink(
        sql,
        workspaceId,
        collectorKey,
        "concurrent-child",
        "concurrent-parent",
      );

      const attributedParent = await seedBatch(sql, {
        workspaceId,
        personId,
        collectorKey,
        nativeSessionId: "attributed-parent",
      });
      const otherPersonChild = await seedBatch(sql, {
        workspaceId,
        personId: otherPersonId,
        collectorKey,
        nativeSessionId: "other-person-child",
        parentNativeSessionId: "attributed-parent",
      });
      await normalize(firstNormalizer, attributedParent);
      const otherChildSessionId = await normalize(
        firstNormalizer,
        otherPersonChild,
      );
      const attributionBoundary = await sql.unsafe(
        `select parent_session_id from telemetry.sessions
          where workspace_id = $1 and id = $2`,
        [workspaceId, otherChildSessionId],
      );
      assert(
        attributionBoundary[0].parent_session_id === null,
        "a matching native id owned by another person must not become a parent",
      );
    } finally {
      await sql.unsafe(
        "delete from processing.telemetry_jobs where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe("delete from telemetry.events where workspace_id = $1", [
        workspaceId,
      ]).catch(() => undefined);
      await sql.unsafe(
        "delete from telemetry.native_records where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from telemetry.ingest_batches where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from telemetry.sessions where workspace_id = $1",
        [
          workspaceId,
        ],
      ).catch(() => undefined);
      await sql.unsafe("delete from telemetry.people where workspace_id = $1", [
        workspaceId,
      ]).catch(() => undefined);
      await sql.unsafe("delete from telemetry.workspaces where id = $1", [
        workspaceId,
      ]).catch(() => undefined);
      await Promise.allSettled([
        firstNormalizer.close(),
        secondNormalizer.close(),
        sql.end(),
      ]);
    }
  },
});
