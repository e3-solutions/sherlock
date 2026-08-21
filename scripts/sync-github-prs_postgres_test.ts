import postgres from "npm:postgres@3.4.7";
import {
  type BatchManifest,
  type CommittedReceipt,
  CONTRACT_VERSION,
  RECEIPT_VERSION,
  sha256Hex,
} from "../supabase/functions/sherlock-rollout-ingest/contract.ts";
import { PostgresBatchNormalizer } from "../supabase/functions/sherlock-rollout-ingest/normalizer_postgres.ts";
import { PostgresLookupStore, syncPending } from "./sync-github-prs.ts";

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

Deno.test({
  name: "normalizer projection becomes a persisted exact GitHub lookup attempt",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 2 });
    const normalizer = PostgresBatchNormalizer.connect(databaseUrl!);
    const store = PostgresLookupStore.connect(databaseUrl!);
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const repositoryFullName = `e3-solutions/sync-${workspaceId}`;
    const commitSha = "c".repeat(40);
    const native = {
      timestamp,
      type: "session_meta",
      payload: {
        id: `session-${workspaceId}`,
        git: {
          repository_url: `https://github.com/${repositoryFullName}.git`,
          commit_hash: commitSha,
        },
      },
    };
    const source = new TextEncoder().encode(`${JSON.stringify(native)}\n`);
    const sourceSha256 = await sha256Hex(source);
    const sourceStreamKey = `github-sync-stream-${batchId}`;
    const generationKey = `github-sync-generation-${batchId}`;
    const storagePath = `github-sync-${batchId}`;
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
        record_sha256: sourceSha256,
        native_type: "session_meta",
        native_payload_type: null,
        occurred_at: timestamp,
        parse_status: "ok",
      }],
      observed_native_session_id: `session-${workspaceId}`,
      observed_parent_native_session_id: null,
      first_occurred_at: timestamp,
      last_occurred_at: timestamp,
      codex_version: "integration-test",
      source_version: "integration-test",
      collector_version: "integration-test",
    };
    const receipt: CommittedReceipt = {
      receipt_version: RECEIPT_VERSION,
      status: "committed",
      batch_id: batchId,
      workspace_id: workspaceId,
      person_id: personId,
      collector_key: "github-sync",
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
    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name)
         values ($1, $2, 'GitHub sync integration')`,
        [workspaceId, `github-sync-${workspaceId}`],
      );
      await sql.unsafe(
        `insert into telemetry.people (id, workspace_id, identity_key)
         values ($1, $2, 'github-sync-person')`,
        [personId, workspaceId],
      );
      await sql.unsafe(
        `insert into telemetry.ingest_batches (
           id, workspace_id, person_id, collector_key, source_kind,
           source_stream_key, generation_key, generation_seq, start_offset,
           end_offset, source_byte_count, source_sha256, storage_path,
           storage_encoding, stored_byte_count, stored_sha256, record_count,
           contract_version, first_occurred_at, last_occurred_at
         ) values ($1, $2, $3, 'github-sync', 'rollout', $4, $5, 0, 0, $6,
                   $6, $7, $8, 'gzip', 1, repeat('a', 64), 1, $9, $10, $10)`,
        [
          batchId,
          workspaceId,
          personId,
          sourceStreamKey,
          generationKey,
          source.byteLength,
          sourceSha256,
          storagePath,
          CONTRACT_VERSION,
          timestamp,
        ],
      );
      await sql.unsafe(
        `insert into telemetry.native_records (
           workspace_id, batch_id, record_index, source_start_offset,
           source_end_offset, record_sha256, native_type, occurred_at,
           parse_status
         ) values ($1, $2, 0, 0, $3, $4, 'session_meta', $5, 'ok')`,
        [workspaceId, batchId, source.byteLength, sourceSha256, timestamp],
      );

      await normalizer.normalize(receipt, manifest, source);
      const pairs = await store.pendingPairs(workspaceId, 10);
      assert(pairs.length === 1, "matched projection must become pending");
      const result = await syncPending(store, {
        workspaceId,
        token: "test-token",
        fetcher: () =>
          Promise.resolve(
            new Response(JSON.stringify([{
              id: 7001,
              number: 61,
              state: "closed",
              created_at: timestamp,
              closed_at: timestamp,
              merged_at: timestamp,
              base: { repo: { id: 8001, full_name: repositoryFullName } },
            }])),
          ),
      });
      assert(result.inserted === 1 && result.failed === 0);

      const facts = await sql.unsafe(
        `select attempt.outcome, attempt.lookup_version, attempt.api_version,
                attempt.candidate_count, candidate.github_repository_id,
                candidate.pull_request_number
           from github.commit_pull_attempts attempt
           join github.commit_pull_candidates candidate
             on candidate.workspace_id = attempt.workspace_id
            and candidate.attempt_id = attempt.id
          where attempt.workspace_id = $1`,
        [workspaceId],
      );
      assert(facts.length === 1);
      assert(facts[0].outcome === "complete");
      assert(facts[0].lookup_version === "sherlock.github-associated-pulls.v1");
      assert(facts[0].api_version === "2026-03-10");
      assert(Number(facts[0].candidate_count) === 1);
      assert(Number(facts[0].github_repository_id) === 8001);
      assert(Number(facts[0].pull_request_number) === 61);
    } finally {
      await store.close();
      await normalizer.close();
      await sql.begin(async (tx) => {
        for (
          const table of [
            "github.commit_pull_candidates",
            "github.commit_pull_attempts",
            "analytics.activity_spans",
            "telemetry.events",
            "telemetry.scm_projections",
            "processing.telemetry_jobs",
            "telemetry.native_records",
            "telemetry.ingest_batches",
            "telemetry.sessions",
            "telemetry.people",
          ]
        ) {
          await tx.unsafe(`delete from ${table} where workspace_id = $1`, [
            workspaceId,
          ]);
        }
        await tx.unsafe("delete from telemetry.workspaces where id = $1", [
          workspaceId,
        ]);
      });
      await sql.end();
    }
  },
});
