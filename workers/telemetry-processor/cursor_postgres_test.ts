import postgres from "./postgres.ts";
import { cursorFixture } from "../../supabase/functions/sherlock-rollout-ingest/cursor_test_fixture.ts";
import { IngestService } from "../../supabase/functions/sherlock-rollout-ingest/service.ts";
import { PostgresBatchRepository } from "../../supabase/functions/sherlock-rollout-ingest/postgres.ts";
import { PostgresBatchNormalizer } from "../../supabase/functions/sherlock-rollout-ingest/normalizer_postgres.ts";
import { PostgresFrameEvidenceProjector } from "./frame-projector.ts";
import { proveAndActivateFrameProjection } from "../../scripts/backfill-frame-evidence.ts";
import {
  decodeSnapshotToken,
  DirectFlameSource,
} from "../../apps/dashboard/src/server/flame-source.js";
import { createSherlockQuerySource } from "../../apps/dashboard/src/server/mcp-query-source.js";
import { FRAME_VERSION } from "../../packages/frame-evidence/constants.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
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
    "Cursor receipt queues one job, normalizes idempotently and reaches dashboard and MCP",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 3 });
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const attribution = {
      workspace_id: workspaceId,
      person_id: personId,
      collector_key: "cursor-test",
    };
    const repository = new PostgresBatchRepository(sql);
    const normalizer = new PostgresBatchNormalizer(sql);
    const projector = new PostgresFrameEvidenceProjector(sql);
    const dashboard = new DirectFlameSource({
      databaseUrl,
      workspaceId,
      expectedEmailDomain: "e3group.ai",
    });
    const now = new Date();
    const at = new Date(Math.floor(now.getTime() / 600000) * 600000 - 1200000);
    try {
      await sql.unsafe(
        "insert into telemetry.workspaces(id,slug,name,created_at) values($1::uuid,$1::text,'Cursor test',$2)",
        [workspaceId, new Date(now.getTime() - 3600000)],
      );
      await sql.unsafe(
        "insert into telemetry.people(id,workspace_id,identity_key,display_name,email) values($1::uuid,$2,$1::text,'Cursor test','cursor@e3group.ai')",
        [personId, workspaceId],
      );
      const batch = await cursorFixture("afterAgentResponse", {
        text: "Cursor observed response",
        model: "test-model",
      }, at.toISOString());
      let storedObjects = 0;
      const ingest = new IngestService({
        ensure(_path, stored) {
          assert(stored.length > 0, "empty stored object");
          storedObjects++;
          return Promise.resolve();
        },
      }, repository);
      const receipt = await ingest.ingest(
        attribution,
        batch.manifest,
        batch.stored,
        "live",
      );
      await ingest.ingest(attribution, batch.manifest, batch.stored, "live");
      assert(storedObjects === 1, "retry wrote a second raw object");
      const jobs = await sql.unsafe(
        "select normalizer_version from processing.telemetry_jobs where workspace_id=$1",
        [workspaceId],
      );
      assert(
        jobs.length === 1 &&
          jobs[0].normalizer_version === "sherlock.cursor-hook.v1",
        "Cursor must have one provider-specific job",
      );
      const result = await normalizer.normalize(
        receipt,
        batch.manifest,
        batch.source,
      );
      await normalizer.normalize(receipt, batch.manifest, batch.source);
      const facts = await sql.unsafe(
        "select count(*)::int count from telemetry.events where workspace_id=$1",
        [workspaceId],
      );
      assert(facts[0].count === 1, "normalization retry duplicated evidence");
      const attempt = await cursorFixture("beforeSubmitPrompt", {
        prompt: "Potentially rejected",
      }, at.toISOString());
      const attemptReceipt = await ingest.ingest(
        attribution,
        attempt.manifest,
        attempt.stored,
        "live",
      );
      await normalizer.normalize(
        attemptReceipt,
        attempt.manifest,
        attempt.source,
      );
      const sessionId = result.session_ids[0];
      await projector.projectSession({
        workspaceId,
        sessionId,
        requestGeneration: 1n,
        now,
      });
      await proveAndActivateFrameProjection(sql, {
        workspaceId,
        activate: true,
        windowEnd: now,
      });
      const day = await dashboard.fetchDay({ now });
      assert(
        Object(decodeSnapshotToken(day.snapshot)).frameVersion ===
          FRAME_VERSION,
        "new frame not active",
      );
      const detail = await dashboard.fetchInterval({
        personId,
        start: at.toISOString(),
        snapshot: day.snapshot,
        signal: undefined,
        now,
      });
      assert(
        JSON.stringify(detail).includes(sessionId),
        "Cursor missing from timeline details",
      );
      const prompts = await dashboard.fetchPromptEvidence({
        personId,
        start: at.toISOString(),
        snapshot: day.snapshot,
        signal: undefined,
        now,
      });
      assert(
        prompts.eligiblePromptCount === 0,
        "attempt incorrectly counted as submitted",
      );
      const work = await dashboard.fetchWork({
        personId,
        sessionId,
        role: "agent",
        start: at.toISOString(),
        snapshot: day.snapshot,
        cursor: undefined,
        limit: undefined,
        signal: undefined,
        now,
      });
      assert(
        JSON.stringify(work).includes("Cursor observed response"),
        "response excerpt missing from work detail",
      );
      const query = createSherlockQuerySource(dashboard);
      const session = await query.fetchSession({ sessionId });
      assert(session.session.provider === "cursor", "MCP mislabeled Cursor");
      assert(
        session.observedEventCounts.messages === 2,
        "MCP missing Cursor response",
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
          "analytics.normalizer_cutovers",
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
      await sql.end({ timeout: 5 });
    }
  },
});
