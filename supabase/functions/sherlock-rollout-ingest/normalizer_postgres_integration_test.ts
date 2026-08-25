import postgres from "npm:postgres@3.4.7";
import { PostgresActivityReducer } from "../sherlock-activity-reducer/postgres.ts";
import { CLAUDE_NORMALIZER_VERSION } from "./normalizer.ts";
import {
  type BatchManifest,
  type CollectorIdentity,
  type CommittedReceipt,
  CONTRACT_VERSION,
  IngestError,
  RECEIPT_VERSION,
  sha256Hex,
} from "./contract.ts";
import { PostgresBatchNormalizer } from "./normalizer_postgres.ts";
import { PostgresBatchRepository } from "./postgres.ts";

const permission = await Deno.permissions.query({
  name: "env",
  variable: "SHERLOCK_TEST_DATABASE_URL",
});
const databaseUrl = permission.state === "granted"
  ? Deno.env.get("SHERLOCK_TEST_DATABASE_URL")
  : null;
type Sql = ReturnType<typeof postgres>;

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

interface BatchOwner {
  workspaceId: string;
  personId: string;
  collectorKey: string;
}

interface SessionBatchInput extends BatchOwner {
  nativeSessionId: string;
  parentNativeSessionId?: string;
}

interface ClaudeBatchInput extends SessionBatchInput {
  nativeRecords?: ClaudeNativeRecord[];
}

interface HookBatchInput extends BatchOwner {
  nativeSessionId: string;
  promptUuid: string;
  assistantUuid: string;
}

type ClaudeNativeRecord = Record<string, unknown> & {
  type: string;
  timestamp: string;
};

function committedReceipt(
  manifest: BatchManifest,
  batchId: string,
  owner: BatchOwner,
  storagePath: string,
  committedAt: string,
): CommittedReceipt {
  return {
    receipt_version: RECEIPT_VERSION,
    status: "committed",
    batch_id: batchId,
    workspace_id: owner.workspaceId,
    person_id: owner.personId,
    collector_key: owner.collectorKey,
    source_kind: manifest.source_kind,
    source_stream_key: manifest.source_stream_key,
    generation_key: manifest.generation_key,
    generation_seq: manifest.generation_seq,
    start_offset: manifest.start_offset,
    end_offset: manifest.end_offset,
    source_byte_count: manifest.source_byte_count,
    source_sha256: manifest.source_sha256,
    storage_path: storagePath,
    stored_byte_count: manifest.stored_byte_count,
    stored_sha256: manifest.stored_sha256,
    record_count: manifest.record_count,
    contract_version: manifest.contract_version,
    committed_at: committedAt,
  };
}

async function seedBatch(
  sql: Sql,
  input: SessionBatchInput,
): Promise<BatchFixture> {
  const batchId = crypto.randomUUID();
  const timestamp = "2026-08-17T00:00:00.000Z";
  const source = new TextEncoder().encode(`${
    JSON.stringify({
      timestamp,
      type: "session_meta",
      payload: {
        id: input.nativeSessionId,
        git: {
          repository_url: "https://github.com/e3-solutions/sherlock.git",
          commit_hash: "a".repeat(40),
        },
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
    source_provider: "codex",
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
    observed_parent_native_session_id: input.parentNativeSessionId ?? null,
    first_occurred_at: timestamp,
    last_occurred_at: timestamp,
    codex_version: "integration-test",
    source_version: "integration-test",
    collector_version: "integration-test",
  };
  const receipt = committedReceipt(
    manifest,
    batchId,
    input,
    storagePath,
    timestamp,
  );
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

async function seedClaudeBatch(
  sql: Sql,
  input: ClaudeBatchInput,
): Promise<BatchFixture> {
  const batchId = crypto.randomUUID();
  const promptId = `prompt-${input.nativeSessionId}`;
  const sessionId = input.parentNativeSessionId ?? input.nativeSessionId;
  const providerFields = input.parentNativeSessionId
    ? {
      agentId: input.nativeSessionId,
      isSidechain: true,
    }
    : {};
  const terminalUsage = {
    input_tokens: 8,
    cache_read_input_tokens: 2,
    output_tokens: 3,
  };
  const partialUsage = { ...terminalUsage, output_tokens: 1 };
  const native: ClaudeNativeRecord[] = input.nativeRecords ?? [
    {
      ...providerFields,
      sessionId,
      promptId,
      type: "user",
      uuid: `${input.nativeSessionId}-user`,
      parentUuid: null,
      timestamp: "2026-08-17T00:00:00.000Z",
      message: { role: "user", content: "Sanitized Claude prompt" },
    },
    {
      ...providerFields,
      sessionId,
      type: "assistant",
      uuid: `${input.nativeSessionId}-thinking`,
      parentUuid: `${input.nativeSessionId}-user`,
      requestId: `${input.nativeSessionId}-request`,
      timestamp: "2026-08-17T00:00:01.000Z",
      message: {
        id: `${input.nativeSessionId}-message`,
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{ type: "thinking", thinking: "not projected" }],
        usage: partialUsage,
      },
    },
    {
      ...providerFields,
      sessionId,
      type: "assistant",
      uuid: `${input.nativeSessionId}-answer`,
      parentUuid: `${input.nativeSessionId}-thinking`,
      requestId: `${input.nativeSessionId}-request`,
      timestamp: "2026-08-17T00:00:02.000Z",
      message: {
        id: `${input.nativeSessionId}-message`,
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{ type: "text", text: "Sanitized Claude answer" }],
        stop_reason: "end_turn",
        usage: terminalUsage,
      },
    },
    {
      ...providerFields,
      sessionId,
      promptId,
      type: "system",
      subtype: "turn_duration",
      uuid: `${input.nativeSessionId}-duration`,
      parentUuid: `${input.nativeSessionId}-answer`,
      durationMs: 2_000,
      timestamp: "2026-08-17T00:00:03.000Z",
    },
  ];
  const encoder = new TextEncoder();
  const lines = native.map((record) =>
    encoder.encode(`${JSON.stringify(record)}\n`)
  );
  const source = new Uint8Array(
    lines.reduce((total, line) => total + line.byteLength, 0),
  );
  const records: BatchManifest["records"] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    source.set(line, offset);
    records.push({
      record_index: index,
      source_start_offset: offset,
      source_end_offset: offset + line.byteLength,
      record_sha256: await sha256Hex(line),
      native_type: native[index].type,
      native_payload_type: null,
      occurred_at: native[index].timestamp,
      parse_status: "ok",
    });
    offset += line.byteLength;
  }
  const sourceSha256 = await sha256Hex(source);
  const storagePath = `normalizer-integration/${batchId}.jsonl.gz`;
  const sourceStreamKey = `stream-${batchId}`;
  const generationKey = `generation-${batchId}`;
  const manifest: BatchManifest = {
    contract_version: CONTRACT_VERSION,
    source_provider: "claude_code",
    source_kind: "transcript",
    source_stream_key: sourceStreamKey,
    generation_key: generationKey,
    generation_seq: 0,
    start_offset: 0,
    end_offset: source.byteLength,
    source_byte_count: source.byteLength,
    source_sha256: sourceSha256,
    storage_encoding: "gzip",
    stored_byte_count: 1,
    stored_sha256: "b".repeat(64),
    record_count: records.length,
    records,
    observed_native_session_id: input.nativeSessionId,
    observed_parent_native_session_id: input.parentNativeSessionId ?? null,
    first_occurred_at: native[0].timestamp,
    last_occurred_at: native.at(-1)!.timestamp,
    codex_version: null,
    source_version: "2.0.59",
    collector_version: "integration-test",
  };
  const receipt = committedReceipt(
    manifest,
    batchId,
    input,
    storagePath,
    native.at(-1)!.timestamp,
  );
  await sql.unsafe(
    `insert into telemetry.ingest_batches (
       id, workspace_id, person_id, collector_key,
       observed_native_session_id, observed_parent_native_session_id,
       source_provider, source_kind, source_stream_key, generation_key,
       generation_seq, start_offset, end_offset, source_byte_count,
       source_sha256, storage_path, storage_encoding, stored_byte_count,
       stored_sha256, record_count, first_occurred_at, last_occurred_at,
       source_version, collector_version, contract_version, committed_at
     ) values (
       $1, $2, $3, $4, $5, $6, 'claude_code', 'transcript', $7, $8,
       0, 0, $9, $9, $10, $11, 'gzip', 1, $12, $13, $14, $15,
       '2.0.59', 'integration-test', $16, $15
     )`,
    [
      batchId,
      input.workspaceId,
      input.personId,
      input.collectorKey,
      input.nativeSessionId,
      input.parentNativeSessionId ?? null,
      sourceStreamKey,
      generationKey,
      source.byteLength,
      sourceSha256,
      storagePath,
      "b".repeat(64),
      records.length,
      native[0].timestamp,
      native.at(-1)!.timestamp,
      CONTRACT_VERSION,
    ],
  );
  for (const record of records) {
    await sql.unsafe(
      `insert into telemetry.native_records (
         workspace_id, batch_id, record_index, source_start_offset,
         source_end_offset, record_sha256, native_type, occurred_at,
         parse_status
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'ok')`,
      [
        input.workspaceId,
        batchId,
        record.record_index,
        record.source_start_offset,
        record.source_end_offset,
        record.record_sha256,
        record.native_type,
        record.occurred_at,
      ],
    );
  }
  return { receipt, manifest, source };
}

async function seedClaudeHookBatch(
  sql: Sql,
  input: HookBatchInput,
): Promise<BatchFixture> {
  const batchId = crypto.randomUUID();
  const timestamp = "2026-08-17T02:00:02.000Z";
  const payload = new TextEncoder().encode(JSON.stringify({
    session_id: input.nativeSessionId,
    transcript_path: "/sanitized/session.jsonl",
    cwd: "/repo",
    permission_mode: "default",
    hook_event_name: "Stop",
    stop_hook_active: false,
  }));
  let payloadBinary = "";
  for (const byte of payload) payloadBinary += String.fromCharCode(byte);
  const transcript = new TextEncoder().encode(
    "sanitized immutable Claude transcript\n",
  );
  const native = {
    type: "claude_hook",
    schema_version: "sherlock.claude-hook.v1",
    collector_observed_at: timestamp,
    dispatch_event_name: "Stop",
    payload_sha256: await sha256Hex(payload),
    payload_base64: btoa(payloadBinary),
    native_session_id: input.nativeSessionId,
    parent_native_session_id: null,
    terminal_assistant_uuid: input.assistantUuid,
    turn_anchor_id: input.promptUuid,
    transcript_byte_count: transcript.byteLength,
    transcript_sha256: await sha256Hex(transcript),
  };
  const source = new TextEncoder().encode(`${JSON.stringify(native)}\n`);
  const sourceSha256 = await sha256Hex(source);
  const storagePath = `normalizer-integration/${batchId}.jsonl.gz`;
  const sourceStreamKey = `hook-stream-${batchId}`;
  const generationKey = `hook-generation-${batchId}`;
  const recordSha256 = await sha256Hex(source);
  const manifest: BatchManifest = {
    contract_version: CONTRACT_VERSION,
    source_provider: "claude_code",
    source_kind: "hook",
    source_stream_key: sourceStreamKey,
    generation_key: generationKey,
    generation_seq: 0,
    start_offset: 0,
    end_offset: source.byteLength,
    source_byte_count: source.byteLength,
    source_sha256: sourceSha256,
    storage_encoding: "gzip",
    stored_byte_count: 1,
    stored_sha256: "c".repeat(64),
    record_count: 1,
    records: [{
      record_index: 0,
      source_start_offset: 0,
      source_end_offset: source.byteLength,
      record_sha256: recordSha256,
      native_type: "claude_hook",
      native_payload_type: null,
      occurred_at: null,
      parse_status: "ok",
    }],
    observed_native_session_id: input.nativeSessionId,
    observed_parent_native_session_id: null,
    first_occurred_at: null,
    last_occurred_at: null,
    codex_version: null,
    source_version: "2.0.59",
    collector_version: "integration-test",
  };
  const receipt = committedReceipt(
    manifest,
    batchId,
    input,
    storagePath,
    timestamp,
  );
  await sql.unsafe(
    `insert into telemetry.ingest_batches (
       id, workspace_id, person_id, collector_key,
       observed_native_session_id, observed_parent_native_session_id,
       source_provider, source_kind, source_stream_key, generation_key,
       generation_seq, start_offset, end_offset, source_byte_count,
       source_sha256, storage_path, storage_encoding, stored_byte_count,
       stored_sha256, record_count, first_occurred_at, last_occurred_at,
       source_version, collector_version, contract_version, committed_at
     ) values (
       $1, $2, $3, $4, $5, null, 'claude_code', 'hook', $6, $7,
       0, 0, $8, $8, $9, $10, 'gzip', 1, $11, 1, $12, $12,
       '2.0.59', 'integration-test', $13, $12
     )`,
    [
      batchId,
      input.workspaceId,
      input.personId,
      input.collectorKey,
      input.nativeSessionId,
      sourceStreamKey,
      generationKey,
      source.byteLength,
      sourceSha256,
      storagePath,
      "c".repeat(64),
      timestamp,
      CONTRACT_VERSION,
    ],
  );
  await sql.unsafe(
    `insert into telemetry.native_records (
       workspace_id, batch_id, record_index, source_start_offset,
       source_end_offset, record_sha256, native_type, occurred_at,
       parse_status
     ) values ($1, $2, 0, 0, $3, $4, 'claude_hook', null, 'ok')`,
    [
      input.workspaceId,
      batchId,
      source.byteLength,
      recordSha256,
    ],
  );
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

async function readPerson(
  sql: Sql,
  workspaceId: string,
  personId: string,
) {
  const [row] = await sql.unsafe(
    `select xmin::text as xmin, display_name, github_id
       from telemetry.people
      where workspace_id = $1 and id = $2`,
    [workspaceId, personId],
  );
  return row;
}

async function readSession(
  sql: Sql,
  workspaceId: string,
  sessionId: string,
) {
  const [row] = await sql.unsafe(
    `select xmin::text as xmin, updated_at::text as updated_at
       from telemetry.sessions
      where workspace_id = $1 and id = $2`,
    [workspaceId, sessionId],
  );
  return row;
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
  name: "Postgres person attribution skips identical physical updates",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 2 });
    const repository = PostgresBatchRepository.connect(databaseUrl!);
    const workspaceId = crypto.randomUUID();
    const grant = {
      workspace_id: workspaceId,
      collector_key_prefix: "identity-integration",
    };
    const identity: CollectorIdentity = {
      name: "Identity Test",
      github_id: "identity-test",
      email: "identity-test@example.com",
      installation_id: crypto.randomUUID(),
    };
    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name)
         values ($1, $2, 'Identity integration test')`,
        [workspaceId, `identity-${workspaceId}`],
      );

      const first = await repository.resolveAttribution(grant, identity);
      const attributedId = first.person_id;
      const beforeReplay = await readPerson(sql, workspaceId, attributedId);
      const replay = await repository.resolveAttribution(grant, identity);
      const afterReplay = await readPerson(sql, workspaceId, attributedId);
      assert(replay.person_id === first.person_id);
      assert(
        afterReplay.xmin === beforeReplay.xmin,
        "identical person attribution must not create a new row version",
      );

      const changed = await repository.resolveAttribution(grant, {
        ...identity,
        name: "Changed Identity Test",
        github_id: "changed-identity-test",
      });
      const afterChange = await readPerson(sql, workspaceId, attributedId);
      assert(changed.person_id === first.person_id);
      assert(
        afterChange.xmin !== afterReplay.xmin &&
          afterChange.display_name === "Changed Identity Test" &&
          afterChange.github_id === "changed-identity-test",
        "changed person metadata must create an auditable row version",
      );
    } finally {
      await sql.unsafe("delete from telemetry.people where workspace_id = $1", [
        workspaceId,
      ]).catch(() => undefined);
      await sql.unsafe("delete from telemetry.workspaces where id = $1", [
        workspaceId,
      ]).catch(() => undefined);
      await Promise.allSettled([repository.close(), sql.end()]);
    }
  },
});

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
    const reducer = PostgresActivityReducer.connect(databaseUrl!);
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
      const beforeReplay = await readSession(sql, workspaceId, childSessionId);
      assert(
        await normalize(firstNormalizer, childFirstChild) === childSessionId,
        "child replay must preserve its session id",
      );
      const afterReplay = await readSession(sql, workspaceId, childSessionId);
      assert(
        afterReplay.xmin === beforeReplay.xmin &&
          afterReplay.updated_at === beforeReplay.updated_at,
        "identical session replay must preserve xmin and updated_at",
      );
      const scmFacts = await sql.unsafe(
        `select repository_full_name, commit_sha
             from telemetry.session_scm
            where workspace_id = $1 and session_id = $2`,
        [workspaceId, childSessionId],
      );
      assert(
        scmFacts.length === 1 &&
          scmFacts[0].repository_full_name === "e3-solutions/sherlock" &&
          scmFacts[0].commit_sha === "a".repeat(40),
        "SCM fact insert must be exact and idempotent",
      );
      assert(
        await normalize(firstNormalizer, childFirstParent) === parentSessionId,
        "parent replay must preserve its session id",
      );

      const wrongPersonReplay = await seedBatch(sql, {
        workspaceId,
        personId: otherPersonId,
        collectorKey,
        nativeSessionId: "child-first-child",
      });
      try {
        await normalize(firstNormalizer, wrongPersonReplay);
        assert(false, "wrong-person session replay must conflict");
      } catch (error) {
        assert(error instanceof IngestError);
        assert(error.code === "session_attribution_conflict");
      }

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

      const claudeChild = await seedClaudeBatch(sql, {
        workspaceId,
        personId,
        collectorKey,
        nativeSessionId: "claude-child",
        parentNativeSessionId: "claude-parent",
      });
      const claudeParent = await seedClaudeBatch(sql, {
        workspaceId,
        personId,
        collectorKey,
        nativeSessionId: "claude-parent",
      });
      const claudeChildSessionId = await normalize(
        firstNormalizer,
        claudeChild,
      );
      await normalize(firstNormalizer, claudeParent);
      await assertParentLink(
        sql,
        workspaceId,
        collectorKey,
        "claude-child",
        "claude-parent",
      );
      const claudeSession = await sql.unsafe(
        `select actor_role, parent_native_session_id
           from telemetry.sessions
          where workspace_id = $1 and id = $2`,
        [workspaceId, claudeChildSessionId],
      );
      assert(claudeSession[0].actor_role === "worker");
      assert(
        claudeSession[0].parent_native_session_id === "claude-parent",
      );
      const claudeEvents = await sql.unsafe(
        `select event_kind, event_subtype, turn_id, logical_event_key,
                source_priority, output_tokens,
                usage_stream_key, content_sha256, content_byte_size,
                content_excerpt, attributes
           from telemetry.events
          where workspace_id = $1 and session_id = $2
            and normalizer_version = $3
          order by id`,
        [workspaceId, claudeChildSessionId, CLAUDE_NORMALIZER_VERSION],
      );
      assert(
        claudeEvents.some((event) =>
          event.event_kind === "message" &&
          event.event_subtype === "user_message" &&
          event.turn_id === "claude:prompt:prompt-claude-child"
        ),
        "Claude user messages must use provider-neutral semantics",
      );
      const reasoning = claudeEvents.find((event) =>
        event.event_kind === "reasoning"
      );
      assert(reasoning, "Claude thinking must produce structural evidence");
      assert(
        reasoning.content_sha256 === null &&
          reasoning.content_byte_size === null &&
          reasoning.content_excerpt === null && reasoning.attributes === null,
        "Claude reasoning content must not enter derived database columns",
      );
      const usage = claudeEvents.filter((event) =>
        event.event_kind === "usage"
      );
      assert(usage.length === 2, "raw usage projections remain auditable");
      assert(
        new Set(usage.map((event) => event.logical_event_key)).size === 1 &&
          new Set(usage.map((event) => event.usage_stream_key)).size === 1,
        "repeated Claude usage must share one canonical message identity",
      );
      assert(
        usage.some((event) =>
          event.source_priority === 110 && Number(event.output_tokens) === 3
        ),
        "the terminal Claude usage snapshot must win canonical selection",
      );
      assert(
        claudeEvents.some((event) =>
          event.event_kind === "lifecycle" &&
          event.event_subtype === "turn_complete" &&
          event.turn_id === "claude:prompt:prompt-claude-child"
        ),
        "Claude native turn duration must close the projected prompt turn",
      );

      const crossBatchSession = "claude-cross-batch";
      const crossBatchPrompt = await seedClaudeBatch(sql, {
        workspaceId,
        personId,
        collectorKey,
        nativeSessionId: crossBatchSession,
        nativeRecords: [{
          sessionId: crossBatchSession,
          type: "user",
          uuid: "cross-batch-user",
          parentUuid: null,
          timestamp: "2026-08-17T01:00:00.000Z",
          message: { role: "user", content: "Sanitized prompt" },
        }],
      });
      const crossBatchTool = await seedClaudeBatch(sql, {
        workspaceId,
        personId,
        collectorKey,
        nativeSessionId: crossBatchSession,
        nativeRecords: [{
          sessionId: crossBatchSession,
          type: "assistant",
          uuid: "cross-batch-thinking",
          parentUuid: "cross-batch-user",
          requestId: "cross-batch-request-1",
          timestamp: "2026-08-17T01:00:01.000Z",
          message: {
            id: "cross-batch-message-1",
            role: "assistant",
            content: [{ type: "thinking", thinking: "not projected" }],
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        }, {
          sessionId: crossBatchSession,
          type: "assistant",
          uuid: "cross-batch-tool-call",
          parentUuid: "cross-batch-thinking",
          requestId: "cross-batch-request-1",
          timestamp: "2026-08-17T01:00:02.000Z",
          message: {
            id: "cross-batch-message-1",
            role: "assistant",
            stop_reason: "tool_use",
            content: [{
              type: "tool_use",
              id: "cross-batch-tool",
              name: "Read",
              input: {},
            }],
            usage: { input_tokens: 5, output_tokens: 4 },
          },
        }, {
          sessionId: crossBatchSession,
          promptId: "cross-batch-user",
          type: "user",
          uuid: "cross-batch-tool-result",
          parentUuid: "cross-batch-tool-call",
          timestamp: "2026-08-17T01:00:03.000Z",
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "cross-batch-tool",
              content: "Sanitized result",
            }],
          },
        }],
      });
      const crossBatchTerminal = await seedClaudeBatch(sql, {
        workspaceId,
        personId,
        collectorKey,
        nativeSessionId: crossBatchSession,
        nativeRecords: [{
          sessionId: crossBatchSession,
          type: "assistant",
          uuid: "cross-batch-answer",
          parentUuid: "cross-batch-tool-result",
          requestId: "cross-batch-request-2",
          timestamp: "2026-08-17T01:00:04.000Z",
          message: {
            id: "cross-batch-message-2",
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Sanitized answer" }],
            usage: { input_tokens: 3, output_tokens: 2 },
          },
        }],
      });
      const crossBatchSessionId = await normalize(
        firstNormalizer,
        crossBatchPrompt,
      );
      await normalize(firstNormalizer, crossBatchTool);
      await normalize(firstNormalizer, crossBatchTerminal);
      const crossBatchTurns = await sql.unsafe(
        `select distinct turn_id
           from telemetry.events
          where workspace_id = $1 and session_id = $2
            and normalizer_version = $3 and turn_id is not null
          order by turn_id`,
        [workspaceId, crossBatchSessionId, CLAUDE_NORMALIZER_VERSION],
      );
      assert(
        crossBatchTurns.length === 1 &&
          crossBatchTurns[0].turn_id === "claude:prompt:cross-batch-user",
        "later Claude hook batches must rejoin the persisted prompt turn",
      );
      const crossBatchCutoff = await sql.unsafe(
        `select max(id)::text cutoff
           from telemetry.events
          where workspace_id = $1 and session_id = $2
            and normalizer_version = $3`,
        [workspaceId, crossBatchSessionId, CLAUDE_NORMALIZER_VERSION],
      );
      const activityVersion = "test.claude-cross-batch.v1";
      await reducer.reduceSession({
        workspaceId,
        sessionId: crossBatchSessionId,
        normalizerVersion: CLAUDE_NORMALIZER_VERSION,
        activityVersion,
        throughEventId: BigInt(String(crossBatchCutoff[0].cutoff)),
      });
      const crossBatchSpans = await sql.unsafe(
        `select activity_kind, span_state, timing_basis, end_event_id
           from analytics.activity_spans
          where workspace_id = $1 and session_id = $2
            and activity_version = $3 and not is_tombstone
            and activity_kind = 'turn'`,
        [workspaceId, crossBatchSessionId, activityVersion],
      );
      assert(
        crossBatchSpans.length === 1 &&
          crossBatchSpans[0].span_state === "active" &&
          crossBatchSpans[0].timing_basis === "paired_events" &&
          crossBatchSpans[0].end_event_id !== null,
        "the cross-batch Claude prompt must reduce to one closed turn",
      );

      for (const hookFirst of [true, false]) {
        const terminalSessionId = crypto.randomUUID();
        const terminalPromptUuid = crypto.randomUUID();
        const terminalAssistantUuid = crypto.randomUUID();
        const terminalTranscript = await seedClaudeBatch(sql, {
          workspaceId,
          personId,
          collectorKey,
          nativeSessionId: terminalSessionId,
          nativeRecords: [{
            sessionId: terminalSessionId,
            type: "user",
            uuid: terminalPromptUuid,
            parentUuid: null,
            timestamp: "2026-08-17T02:00:00.000Z",
            message: { role: "user", content: "Sanitized terminal prompt" },
          }, {
            sessionId: terminalSessionId,
            type: "assistant",
            uuid: terminalAssistantUuid,
            parentUuid: terminalPromptUuid,
            requestId: crypto.randomUUID(),
            timestamp: "2026-08-17T02:00:01.000Z",
            message: {
              id: crypto.randomUUID(),
              role: "assistant",
              model: "claude-sonnet-4",
              content: [{ type: "text", text: "Sanitized terminal answer" }],
              stop_reason: null,
              usage: { input_tokens: 2, output_tokens: 2 },
            },
          }],
        });
        const terminalHook = await seedClaudeHookBatch(sql, {
          workspaceId,
          personId,
          collectorKey,
          nativeSessionId: terminalSessionId,
          promptUuid: terminalPromptUuid,
          assistantUuid: terminalAssistantUuid,
        });
        const ordered = hookFirst
          ? [terminalHook, terminalTranscript]
          : [terminalTranscript, terminalHook];
        const normalizedSessionId = await normalize(
          firstNormalizer,
          ordered[0],
        );
        assert(
          await normalize(secondNormalizer, ordered[1]) ===
            normalizedSessionId,
          "hook and transcript batches must converge on one session",
        );
        const terminalEvents = await sql.unsafe(
          `select event_kind, event_subtype, turn_id, normalizer_version,
                  content_excerpt, attributes
             from telemetry.events
            where workspace_id = $1 and session_id = $2
            order by id`,
          [workspaceId, normalizedSessionId],
        );
        assert(
          terminalEvents.filter((event) =>
            event.turn_id === `claude:prompt:${terminalPromptUuid}`
          ).length >= 4,
          "prompt, assistant, usage, and hook evidence must share one turn",
        );
        const hookCompletion = terminalEvents.find((event) =>
          event.event_kind === "lifecycle" &&
          event.event_subtype === "turn_complete"
        );
        assert(hookCompletion, "the Stop hook must produce terminal evidence");
        assert(
          hookCompletion.turn_id === `claude:prompt:${terminalPromptUuid}` &&
            hookCompletion.normalizer_version === CLAUDE_NORMALIZER_VERSION,
          "hook and transcript evidence must use the same projection version",
        );
        assert(
          hookCompletion.content_excerpt === null &&
            hookCompletion.attributes?.payload_sha256 !== undefined &&
            hookCompletion.attributes?.transcript_sha256 !== undefined,
          "hook projection must retain fingerprints without response content",
        );
        const terminalCutoff = await sql.unsafe(
          `select max(id)::text cutoff
             from telemetry.events
            where workspace_id = $1 and session_id = $2
              and normalizer_version = $3`,
          [workspaceId, normalizedSessionId, CLAUDE_NORMALIZER_VERSION],
        );
        const terminalActivityVersion = `test.claude-hook-${
          hookFirst ? "first" : "last"
        }.v1`;
        await reducer.reduceSession({
          workspaceId,
          sessionId: normalizedSessionId,
          normalizerVersion: CLAUDE_NORMALIZER_VERSION,
          activityVersion: terminalActivityVersion,
          throughEventId: BigInt(String(terminalCutoff[0].cutoff)),
        });
        const terminalSpans = await sql.unsafe(
          `select activity_kind, span_state, timing_basis, end_event_id
             from analytics.activity_spans
            where workspace_id = $1 and session_id = $2
              and activity_version = $3 and not is_tombstone
              and activity_kind = 'turn'`,
          [workspaceId, normalizedSessionId, terminalActivityVersion],
        );
        assert(
          terminalSpans.length === 1 &&
            terminalSpans[0].span_state === "active" &&
            terminalSpans[0].timing_basis === "paired_events" &&
            terminalSpans[0].end_event_id !== null,
          `hook-${hookFirst ? "first" : "last"} normalization must reduce ` +
            "to one closed prompt turn",
        );
      }

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
        "delete from analytics.activity_spans where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from processing.telemetry_jobs where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe("delete from telemetry.events where workspace_id = $1", [
        workspaceId,
      ]).catch(() => undefined);
      await sql.unsafe(
        "delete from telemetry.session_scm where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
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
        reducer.close(),
        sql.end(),
      ]);
    }
  },
});
