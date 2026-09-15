import postgres from "./postgres.ts";
import {
  type BatchManifest,
  CONTRACT_VERSION,
  sha256Hex,
  storagePath,
} from "../../supabase/functions/sherlock-rollout-ingest/contract.ts";
import { PostgresBatchRepository } from "../../supabase/functions/sherlock-rollout-ingest/postgres.ts";
import { PostgresBatchNormalizer } from "../../supabase/functions/sherlock-rollout-ingest/normalizer_postgres.ts";
import { PostgresFrameEvidenceProjector } from "./frame-projector.ts";
import { SupabaseRawStorage, TelemetryProcessor } from "./processor.ts";
import { ACTIVITY_VERSION } from "../../supabase/functions/sherlock-activity-reducer/reducer.ts";
import {
  MISSING_NORMALIZATION_BATCHES_SQL,
  proveAndActivateFrameProjection,
} from "../../scripts/backfill-frame-evidence.ts";
import {
  parseReplayArgs,
  replayCodexV3,
} from "../../scripts/replay-codex-v3.ts";
import {
  decodeSnapshotToken,
  DirectFlameSource,
} from "../../apps/dashboard/src/server/flame-source.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(operation: () => Promise<unknown>, expected: string) {
  try {
    await operation();
  } catch (error) {
    assert(String(error).includes(expected), `unexpected rejection: ${error}`);
    return;
  }
  throw new Error(`expected rejection: ${expected}`);
}

Deno.test("v3 replay requires an explicit finite workspace window", () => {
  for (
    const args of [[], ["--workspace", crypto.randomUUID()], [
      "--workspace",
      crypto.randomUUID(),
      "--start",
      "2026-09-15T00:00:00Z",
      "--end",
      "2026-09-14T00:00:00Z",
    ]]
  ) {
    let failed = false;
    try {
      parseReplayArgs(args);
    } catch {
      failed = true;
    }
    assert(failed, "unbounded or reversed replay accepted");
  }
});

const permission = await Deno.permissions.query({
  name: "env",
  variable: "SHERLOCK_TEST_DATABASE_URL",
});
const databaseUrl = permission.state === "granted"
  ? Deno.env.get("SHERLOCK_TEST_DATABASE_URL")
  : undefined;

Deno.test({
  name:
    "v3 replay preserves source history, gates activation, and corrects dashboard counts and evidence",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 3 });
    const normalizer = new PostgresBatchNormalizer(sql);
    const repository = new PostgresBatchRepository(sql);
    const projector = new PostgresFrameEvidenceProjector(sql);
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const attribution = {
      workspace_id: workspaceId,
      person_id: personId,
      collector_key: "v3-test",
    };
    const now = new Date();
    const at = new Date(
      Math.floor(now.getTime() / 600_000) * 600_000 - 1_200_000,
    );
    const start = new Date(at.getTime() - 3_600_000);
    const nativeSessionId = crypto.randomUUID();
    const goal =
      '<codex_internal_context source="goal">Continue the active goal.</codex_internal_context>';
    const human = "Please explain the runtime-context filter.";
    const idHex = at.getTime().toString(16).padStart(12, "0");
    const nativeId = `msg_${idHex.slice(0, 8)}-${
      idHex.slice(8)
    }-7000-8000-000000000001`;
    const records = [
      { type: "session_meta", payload: { id: nativeSessionId, source: "cli" } },
      { type: "event_msg", payload: { type: "user_message", message: goal } },
      {
        type: "response_item",
        payload: {
          type: "message",
          id: nativeId,
          role: "user",
          content: [{ type: "input_text", text: goal }],
        },
      },
      { type: "event_msg", payload: { type: "user_message", message: human } },
    ].map((record) => ({ ...record, timestamp: at.toISOString() }));
    const parts = records.map((record) =>
      new TextEncoder().encode(JSON.stringify(record) + "\n")
    );
    const source = new Uint8Array(
      parts.reduce((size, part) => size + part.length, 0),
    );
    let offset = 0;
    const locators: BatchManifest["records"] = [];
    for (const [index, part] of parts.entries()) {
      source.set(part, offset);
      locators.push({
        record_index: index,
        source_start_offset: offset,
        source_end_offset: offset + part.length,
        record_sha256: await sha256Hex(part),
        native_type: records[index].type,
        native_payload_type: records[index].payload.type ?? null,
        occurred_at: at.toISOString(),
        parse_status: "ok",
      });
      offset += part.length;
    }
    const hash = await sha256Hex(source);
    const manifest: BatchManifest = {
      contract_version: CONTRACT_VERSION,
      source_provider: "codex",
      source_kind: "rollout",
      source_stream_key: crypto.randomUUID(),
      generation_key: crypto.randomUUID(),
      generation_seq: 0,
      start_offset: 0,
      end_offset: source.length,
      source_byte_count: source.length,
      source_sha256: hash,
      storage_encoding: "gzip",
      stored_byte_count: source.length,
      stored_sha256: hash,
      record_count: records.length,
      records: locators,
      observed_native_session_id: nativeSessionId,
      observed_parent_native_session_id: null,
      first_occurred_at: at.toISOString(),
      last_occurred_at: at.toISOString(),
      codex_version: "test",
      source_version: "test",
      collector_version: "test",
    };
    const dashboard = new DirectFlameSource({
      databaseUrl,
      workspaceId,
      expectedEmailDomain: "e3group.ai",
    });
    try {
      await sql.unsafe(
        "insert into telemetry.workspaces (id,slug,name,created_at) values ($1::uuid,$1::text,'V3 test',$2)",
        [workspaceId, start],
      );
      await sql.unsafe(
        "insert into telemetry.people (id,workspace_id,identity_key,display_name,email) values ($1::uuid,$2,$1::text,'V3 test','v3-test@e3group.ai')",
        [personId, workspaceId],
      );
      const receipt = await repository.commit(
        attribution,
        manifest,
        storagePath(attribution, manifest),
        null,
      );
      const jobs = await sql.unsafe(
        "select normalizer_version from processing.telemetry_jobs where workspace_id=$1 order by normalizer_version",
        [workspaceId],
      );
      assert(
        jobs.length === 2 &&
          jobs.some((job) =>
            job.normalizer_version === "sherlock.codex-rollout.v3"
          ),
        "new batch must enqueue legacy and v3 jobs",
      );
      const legacy = await normalizer.normalize(
        receipt,
        manifest,
        source,
        undefined,
        undefined,
        "sherlock.codex-rollout.v2",
      );
      const sessionId = legacy.session_ids[0];
      const oldRows = await sql.unsafe(
        "select * from telemetry.events where workspace_id=$1 order by id",
        [workspaceId],
      );
      const rawRows = await sql.unsafe(
        "select * from telemetry.native_records where workspace_id=$1 order by id",
        [workspaceId],
      );
      const oldProject = await projector.projectSession({
        workspaceId,
        sessionId,
        frameVersion: "frame-evidence-v4",
        requestGeneration: 1n,
        now,
      });
      assert(oldProject.inserted_count > 0, "v4 must remain projectable");
      await sql.unsafe(
        "insert into analytics.frame_projection_activations(workspace_id,frame_version) values ($1,'frame-evidence-v4')",
        [workspaceId],
      );
      const before = await dashboard.fetchDay({ now });
      assert(
        Object(decodeSnapshotToken(before.snapshot)).frameVersion ===
          "frame-evidence-v4",
        "v4 fallback lost",
      );
      const beforePrompts = await dashboard.fetchPromptEvidence({
        personId,
        start: at.toISOString(),
        snapshot: before.snapshot,
        signal: undefined,
        now,
      });
      assert(
        beforePrompts.eligiblePromptCount > 1,
        "fixture must reproduce inflated old count",
      );
      const proof = {
        workspaceId,
        activate: true,
        windowStart: start,
        windowEnd: now,
      };
      await rejects(
        () => proveAndActivateFrameProjection(sql, proof),
        "without current normalization",
      );
      // A historical batch predating the v3 trigger has no v3 job. Removing this
      // unprocessed test job emulates that state; no production replay deletes jobs.
      await sql.unsafe(
        "delete from processing.telemetry_jobs where workspace_id=$1 and normalizer_version='sherlock.codex-rollout.v3'",
        [workspaceId],
      );
      const replay = {
        workspaceId,
        start: start.toISOString(),
        end: new Date().toISOString(),
        apply: false,
      };
      const preview = await replayCodexV3(sql, replay);
      assert(
        preview.missing_jobs === 1 && preview.enqueued === 0,
        "replay preview must not enqueue",
      );
      const applied = await replayCodexV3(sql, { ...replay, apply: true });
      assert(
        applied.enqueued === 1,
        "bounded replay must enqueue historical v3 job",
      );
      assert(
        (await replayCodexV3(sql, { ...replay, apply: true })).enqueued === 0,
        "replay enqueue is not idempotent",
      );
      assert(
        (await replayCodexV3(sql, {
          ...replay,
          workspaceId: crypto.randomUUID(),
          apply: true,
        })).enqueued === 0,
        "replay escaped workspace",
      );
      await normalizer.normalize(
        receipt,
        manifest,
        source,
        undefined,
        undefined,
        "sherlock.codex-rollout.v3",
      );
      await normalizer.normalize(
        receipt,
        manifest,
        source,
        undefined,
        undefined,
        "sherlock.codex-rollout.v3",
      );
      const current = await sql.unsafe(
        "select * from telemetry.events where workspace_id=$1 and normalizer_version='sherlock.codex-rollout.v3' order by id",
        [workspaceId],
      );
      assert(
        current.length === records.length,
        "v3 repeated normalization duplicated events",
      );
      assert(
        current.filter((event) => event.message_origin === "runtime_context")
          .length === 2,
        "both runtime representations must persist as runtime",
      );
      assert(
        JSON.stringify(oldRows) ===
          JSON.stringify(
            await sql.unsafe(
              "select * from telemetry.events where workspace_id=$1 and normalizer_version='sherlock.codex-rollout.v2' order by id",
              [workspaceId],
            ),
          ),
        "old events changed",
      );
      assert(
        JSON.stringify(rawRows) ===
          JSON.stringify(
            await sql.unsafe(
              "select * from telemetry.native_records where workspace_id=$1 order by id",
              [workspaceId],
            ),
          ),
        "native records changed",
      );
      await rejects(
        () => proveAndActivateFrameProjection(sql, proof),
        "snapshot is stale",
      );
      await projector.projectSession({
        workspaceId,
        sessionId,
        requestGeneration: 2n,
        now: new Date(now.getTime() - 1000),
      });
      await rejects(
        () => proveAndActivateFrameProjection(sql, proof),
        "snapshot is stale",
      );
      await projector.projectSession({
        workspaceId,
        sessionId,
        requestGeneration: 3n,
        now,
      });
      await proveAndActivateFrameProjection(sql, proof);
      const after = await dashboard.fetchDay({ now });
      assert(
        Object(decodeSnapshotToken(after.snapshot)).frameVersion ===
          "frame-evidence-v5",
        "complete v5 must take precedence",
      );
      const prompts = await dashboard.fetchPromptEvidence({
        personId,
        start: at.toISOString(),
        snapshot: after.snapshot,
        signal: undefined,
        now,
      });
      assert(
        prompts.eligiblePromptCount === 1 &&
          prompts.prompts[0].excerpt === human,
        "corrected evidence must contain only the human prompt",
      );
      assert(
        after.people[0].buckets.reduce(
          (sum: number, bucket: number[]) => sum + bucket[3],
          0,
        ) === 1,
        "dashboard aggregate disagrees with evidence",
      );
      const interval = await dashboard.fetchInterval({
        personId,
        start: at.toISOString(),
        snapshot: after.snapshot,
        signal: undefined,
        now,
      });
      assert(
        interval.prompts.length === 1,
        "interval summary includes runtime prompt",
      );
      const runtimeActivity = await sql.unsafe(
        "select count(*)::int n from analytics.frame_evidence_revisions where workspace_id=$1 and frame_version='frame-evidence-v5' and evidence_kind='activity' and message_origin='runtime_context'",
        [workspaceId],
      );
      assert(runtimeActivity[0].n > 0, "runtime activity must remain visible");
      const pinned = await dashboard.fetchPromptEvidence({
        personId,
        start: at.toISOString(),
        snapshot: before.snapshot,
        signal: undefined,
        now,
      });
      assert(
        pinned.eligiblePromptCount === beforePrompts.eligiblePromptCount,
        "v4 snapshot was reinterpreted",
      );
      const processor = new TelemetryProcessor(
        databaseUrl!,
        new SupabaseRawStorage("http://unused.invalid", "unused"),
      );
      try {
        await processor.reduce({
          id: 1n,
          workspace_id: workspaceId,
          workload_class: "backfill",
          attempt_count: 1,
          attempt_limit: 3,
          lease_token: crypto.randomUUID(),
          job_kind: "reduce",
          session_id: sessionId,
          normalizer_version: "sherlock.codex-rollout.v3",
          activity_version: ACTIVITY_VERSION,
          target_event_id: BigInt(current.at(-1)!.id),
          request_generation: 10n,
        }, 30_000);
        const versions = await sql.unsafe(
          "select distinct frame_version from analytics.frame_projection_receipts where workspace_id=$1 and request_generation=10",
          [workspaceId],
        );
        assert(
          versions.length === 2,
          "worker reduction must refresh v4 and v5",
        );
      } finally {
        await processor.close();
      }

      // A copied native item's creation time can be recent even when the whole
      // batch's envelope and commit times are old. The replay/gate must find it.
      const oldBatchId = crypto.randomUUID();
      const oldAt = new Date(start.getTime() - 86_400_000).toISOString();
      await sql.unsafe(
        `insert into telemetry.ingest_batches (
        id,workspace_id,person_id,collector_key,source_kind,source_stream_key,
        generation_key,generation_seq,start_offset,end_offset,source_byte_count,
        source_sha256,storage_path,storage_encoding,stored_byte_count,stored_sha256,
        record_count,contract_version,first_occurred_at,last_occurred_at,committed_at
      ) values ($1::uuid,$2,$3,'v3-test','rollout',$1::text,$1::text,0,0,2,2,$4,$1::text,'gzip',2,$4,1,$5,$6,$6,$6)`,
        [
          oldBatchId,
          workspaceId,
          personId,
          "c".repeat(64),
          CONTRACT_VERSION,
          oldAt,
        ],
      );
      const [native] = await sql.unsafe(
        `insert into telemetry.native_records (
        workspace_id,batch_id,record_index,source_start_offset,source_end_offset,record_sha256,
        native_type,native_payload_type,occurred_at,parse_status
      ) values ($1,$2,0,0,2,$3,'response_item','message',$4,'ok') returning id`,
        [workspaceId, oldBatchId, "c".repeat(64), oldAt],
      );
      await sql.unsafe(
        `insert into telemetry.events (
        workspace_id,session_id,source_record_id,normalizer_version,projection_index,source_priority,
        event_kind,event_subtype,actor_role,occurred_at,server_received_at,native_item_id
      ) values ($1,$2,$3,'sherlock.codex-rollout.v2',0,50,'message','message','primary',$4,$4,$5)`,
        [workspaceId, sessionId, native.id, oldAt, nativeId],
      );
      const missing = await sql.unsafe(MISSING_NORMALIZATION_BATCHES_SQL, [
        workspaceId,
        start.toISOString(),
        6,
      ]);
      assert(
        missing.some((batch) => batch.batch_id === oldBatchId),
        "native-time batch escaped normalization proof",
      );
      assert(
        (await replayCodexV3(sql, { ...replay, end: new Date().toISOString() }))
          .candidates === 2,
        "native-time batch escaped bounded replay",
      );
    } finally {
      await dashboard.close();
      for (
        const table of [
          "analytics.activity_spans",
          "processing.telemetry_jobs",
          "analytics.frame_projection_activations",
          "analytics.frame_evidence_revisions",
          "analytics.frame_projection_receipts",
          "telemetry.events",
          "telemetry.session_scm",
          "telemetry.native_records",
          "telemetry.ingest_batches",
          "telemetry.sessions",
          "telemetry.people",
        ]
      ) {
        await sql.unsafe(`delete from ${table} where workspace_id=$1`, [
          workspaceId,
        ]);
      }
      await sql.unsafe("delete from telemetry.workspaces where id=$1", [
        workspaceId,
      ]);
      await sql.end();
    }
  },
});
