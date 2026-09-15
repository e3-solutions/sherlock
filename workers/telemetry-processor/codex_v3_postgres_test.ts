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
import { proveAndActivateFrameProjection } from "../../scripts/backfill-frame-evidence.ts";
import { createSherlockQuerySource } from "../../apps/dashboard/src/server/mcp-query-source.js";
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
const permission = await Deno.permissions.query({
  name: "env",
  variable: "SHERLOCK_TEST_DATABASE_URL",
});
const databaseUrl = permission.state === "granted"
  ? Deno.env.get("SHERLOCK_TEST_DATABASE_URL")
  : undefined;
Deno.test({
  name:
    "new uploads use one v3 interpretation in continuing sessions and retain old history",
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
    async function upload(
      messages: Array<{ type: string; payload: Record<string, unknown> }>,
    ) {
      const records = [{
        type: "session_meta",
        payload: { id: nativeSessionId, source: "cli" },
      }, ...messages]
        .map((record) => ({ ...record, timestamp: at.toISOString() }));
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
          native_payload_type: typeof records[index].payload.type === "string"
            ? String(records[index].payload.type)
            : null,
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
      const receipt = await repository.commit(
        attribution,
        manifest,
        storagePath(attribution, manifest),
        null,
      );
      return { receipt, manifest, source };
    }
    const dashboard = new DirectFlameSource({
      databaseUrl,
      workspaceId,
      expectedEmailDomain: "e3group.ai",
    });
    const rawDashboard = new DirectFlameSource({
      databaseUrl,
      workspaceId,
      expectedEmailDomain: "e3group.ai",
      projectionEnabled: false,
    });
    try {
      await sql.unsafe(
        "insert into telemetry.workspaces(id,slug,name,created_at) values ($1::uuid,$1::text,'Forward test',$2)",
        [workspaceId, start],
      );
      await sql.unsafe(
        "insert into telemetry.people(id,workspace_id,identity_key,display_name,email) values($1::uuid,$2,$1::text,'Forward test','forward@e3group.ai')",
        [personId, workspaceId],
      );
      // Seed an existing immutable v2 batch, as if it completed before deployment.
      const prior = await upload([{
        type: "event_msg",
        payload: { type: "user_message", message: "Historical human prompt" },
      }, {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Cross-cutover human",
          turn_id: "cross-turn",
        },
      }]);
      await sql.unsafe(
        "update processing.telemetry_jobs set normalizer_version='sherlock.codex-rollout.v2' where workspace_id=$1 and batch_id=$2",
        [workspaceId, prior.receipt.batch_id],
      );
      const historical = await normalizer.normalize(
        prior.receipt,
        prior.manifest,
        prior.source,
        undefined,
        undefined,
        "sherlock.codex-rollout.v2",
      );
      const sessionId = historical.session_ids[0];
      const oldRows = await sql.unsafe(
        "select * from telemetry.events where workspace_id=$1 order by id",
        [workspaceId],
      );
      const rawRows = await sql.unsafe(
        "select * from telemetry.native_records where workspace_id=$1 order by id",
        [workspaceId],
      );
      const pinnedRaw = await rawDashboard.fetchDay({ now });
      const next = await upload([
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
        {
          type: "event_msg",
          payload: { type: "user_message", message: human },
        },
      ]);
      // A native representation of the prior human submission arrives after cutover.
      const cross = await upload([{
        type: "response_item",
        payload: {
          type: "message",
          id: nativeId.replace(/1$/, "2"),
          turn_id: "cross-turn",
          role: "user",
          content: [{ type: "input_text", text: "Cross-cutover human" }],
        },
      }]);
      const jobs = await sql.unsafe(
        "select normalizer_version from processing.telemetry_jobs where workspace_id=$1 and batch_id=$2",
        [workspaceId, next.receipt.batch_id],
      );
      assert(
        jobs.length === 1 &&
          jobs[0].normalizer_version === "sherlock.codex-rollout.v3",
        "continuing session must enqueue exactly one corrected job",
      );
      // Even sessions predating the original v2 session cutover now route new uploads to v3.
      await sql.unsafe(
        "update telemetry.sessions set started_at=$3 where workspace_id=$1 and id=$2",
        [workspaceId, sessionId, new Date(start.getTime() - 3600000)],
      );
      const continued = await upload([]);
      const continuedJobs = await sql.unsafe(
        "select normalizer_version from processing.telemetry_jobs where workspace_id=$1 and batch_id=$2",
        [workspaceId, continued.receipt.batch_id],
      );
      assert(
        continuedJobs.length === 1 &&
          continuedJobs[0].normalizer_version === "sherlock.codex-rollout.v3",
        "pre-cutover session received legacy or duplicate work",
      );
      // Restore the fixture's original source selection for its historical v2 fact.
      await sql.unsafe(
        "update telemetry.sessions set started_at=$3 where workspace_id=$1 and id=$2",
        [workspaceId, sessionId, at],
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
      for (const batch of [next, next, continued, cross]) {
        await normalizer.normalize(
          batch.receipt,
          batch.manifest,
          batch.source,
          undefined,
          undefined,
          "sherlock.codex-rollout.v3",
        );
      }
      const current = await sql.unsafe(
        "select * from telemetry.events where workspace_id=$1 and normalizer_version='sherlock.codex-rollout.v3'",
        [workspaceId],
      );
      assert(
        current.length ===
          next.manifest.record_count + continued.manifest.record_count +
            cross.manifest.record_count,
        "repeated normalization duplicated facts",
      );
      assert(
        current.filter((e) => e.message_origin === "runtime_context").length ===
          2,
        "both runtime formats must be classified",
      );
      assert(
        JSON.stringify(oldRows) ===
          JSON.stringify(
            await sql.unsafe(
              "select * from telemetry.events where workspace_id=$1 and normalizer_version='sherlock.codex-rollout.v2' order by id",
              [workspaceId],
            ),
          ),
        "legacy facts changed",
      );
      assert(
        JSON.stringify(rawRows) ===
          JSON.stringify(
            await sql.unsafe(
              "select * from telemetry.native_records where workspace_id=$1 and batch_id=$2 order by id",
              [workspaceId, prior.receipt.batch_id],
            ),
          ),
        "old raw records changed",
      );
      await rejects(
        () => proveAndActivateFrameProjection(sql, proof),
        "snapshot is stale",
      );
      const processor = new TelemetryProcessor(
        databaseUrl!,
        new SupabaseRawStorage("http://unused.invalid", "unused"),
      );
      await processor.reduce(
        {
          id: 0n,
          workspace_id: workspaceId,
          session_id: sessionId,
          normalizer_version: "sherlock.codex-rollout.v3",
          activity_version: ACTIVITY_VERSION,
          request_generation: 1n,
          job_kind: "reduce",
          target_event_id: current.reduce(
            (max, e) => BigInt(e.id) > max ? BigInt(e.id) : max,
            0n,
          ),
          attempt_count: 1,
          attempt_limit: 3,
          lease_token: crypto.randomUUID(),
          workload_class: "live",
        },
        30000,
      );
      await processor.close();
      const versions = await sql.unsafe(
        "select distinct frame_version from analytics.frame_projection_receipts where workspace_id=$1",
        [workspaceId],
      );
      assert(
        versions.length === 1 &&
          versions[0].frame_version === "frame-evidence-v5",
        "worker must project only one frame version",
      );
      await projector.projectSession({
        workspaceId,
        sessionId,
        requestGeneration: 2n,
        now,
      });
      await proveAndActivateFrameProjection(sql, proof);
      // A rolling worker may publish a newer 26-hour receipt during the handoff.
      // It still fully covers the required 25-hour activation window.
      await projector.projectSession({
        workspaceId,
        sessionId,
        requestGeneration: 3n,
        now: new Date(now.getTime() + 60_000),
      });
      await proveAndActivateFrameProjection(sql, {
        workspaceId,
        activate: false,
        windowEnd: now,
      });
      const day = await dashboard.fetchDay({ now });
      assert(
        Object(decodeSnapshotToken(day.snapshot)).frameVersion ===
          "frame-evidence-v5",
        "v5 not selected after handoff",
      );
      const evidence = await dashboard.fetchPromptEvidence({
        personId,
        start: at.toISOString(),
        snapshot: day.snapshot,
        signal: undefined,
        now,
      });
      assert(
        evidence.eligiblePromptCount === 3,
        "historical, cross-cutover and new human prompts should each count once",
      );
      assert(
        evidence.prompts.every((p: { excerpt: string }) =>
          !p.excerpt.includes("codex_internal_context")
        ),
        "new runtime context leaked into prompt evidence",
      );
      const rawDay = await rawDashboard.fetchDay({ now });
      const rawEvidence = await rawDashboard.fetchPromptEvidence({
        personId,
        start: at.toISOString(),
        snapshot: rawDay.snapshot,
        signal: undefined,
        now,
      });
      assert(
        rawEvidence.eligiblePromptCount === 3,
        "raw reader double counted the cross-version prompt or missed new data",
      );
      const pinnedEvidence = await rawDashboard.fetchPromptEvidence({
        personId,
        start: at.toISOString(),
        snapshot: pinnedRaw.snapshot,
        signal: undefined,
        now,
      });
      assert(
        pinnedEvidence.eligiblePromptCount === 2,
        "pinned pre-upload snapshot changed",
      );
      const query = createSherlockQuerySource(dashboard);
      const session = await query.fetchSession({ sessionId });
      assert(
        session.observedEventCounts.messages === 5,
        "MCP must include corrected messages and deduplicate the cross-version human",
      );
      assert(
        session.session.provider === "codex",
        "MCP provider missing for corrected data",
      );
    } finally {
      await rawDashboard.close();
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
