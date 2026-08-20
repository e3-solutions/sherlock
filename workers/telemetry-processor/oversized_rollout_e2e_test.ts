import postgres from "npm:postgres@3.4.7";
import { handler as ingestHandler } from "../../supabase/functions/sherlock-rollout-ingest/index.ts";
import {
  type BatchManifest,
  type CommittedReceipt,
  FRAGMENT_SOURCE_BYTES,
  sha256Hex,
} from "../../supabase/functions/sherlock-rollout-ingest/contract.ts";
import { validateStoredBatch } from "../../supabase/functions/sherlock-rollout-ingest/service.ts";
import { PostgresJobQueue } from "./queue.ts";
import { SupabaseRawStorage, TelemetryProcessor } from "./processor.ts";

const permissions = await Promise.all([
  Deno.permissions.query({
    name: "env",
    variable: "SHERLOCK_TEST_DATABASE_URL",
  }),
  Deno.permissions.query({
    name: "env",
    variable: "SHERLOCK_TEST_SUPABASE_URL",
  }),
  Deno.permissions.query({
    name: "env",
    variable: "SHERLOCK_TEST_SERVICE_ROLE_KEY",
  }),
]);
const databaseUrl = permissions[0].state === "granted"
  ? Deno.env.get("SHERLOCK_TEST_DATABASE_URL")
  : null;
const supabaseUrl = permissions[1].state === "granted"
  ? Deno.env.get("SHERLOCK_TEST_SUPABASE_URL")
  : null;
const serviceRoleKey = permissions[2].state === "granted"
  ? Deno.env.get("SHERLOCK_TEST_SERVICE_ROLE_KEY")
  : null;
const enabled = Boolean(databaseUrl && supabaseUrl && serviceRoleKey);
const MEASURED_MAXIMUM_RECORD_BYTES = 72_591_045;

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

interface CollectorFixture {
  rollout_path: string;
  spool_path: string;
  session_id: string;
  turn_id: string;
  oversized_bytes: number;
  oversized_sha256: string;
  ordinary_bytes: number;
  fragment_count: number;
  total_bytes: number;
}

interface SpoolEnvelope {
  spool_version: string;
  manifest: BatchManifest;
  stored_payload_base64: string;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function collectorFixture(root: string): Promise<CollectorFixture> {
  const command = new Deno.Command("python3", {
    args: ["tests/collector/build_oversized_e2e_fixture.py", root],
    clearEnv: true,
    env: {
      PYTHONPATH: "packages/telemetry-collector/src",
    },
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(
      `collector fixture failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  return JSON.parse(
    new TextDecoder().decode(output.stdout),
  ) as CollectorFixture;
}

async function loadSpool(path: string): Promise<SpoolEnvelope[]> {
  const pending = `${path}/pending`;
  const envelopes: SpoolEnvelope[] = [];
  for await (const entry of Deno.readDir(pending)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    envelopes.push(
      JSON.parse(
        await Deno.readTextFile(`${pending}/${entry.name}`),
      ) as SpoolEnvelope,
    );
  }
  return envelopes.sort((left, right) =>
    left.manifest.start_offset - right.manifest.start_offset
  );
}

async function uploadEnvelope(
  envelope: SpoolEnvelope,
  collector: Record<string, string>,
): Promise<CommittedReceipt> {
  const response = await ingestHandler(
    new Request("http://local.test/functions/v1/sherlock-rollout-ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        collector,
        manifest: envelope.manifest,
        stored_payload_base64: envelope.stored_payload_base64,
      }),
    }),
  );
  const body = await response.json();
  assert(
    response.status === 200,
    `ingest failed (${response.status}): ${JSON.stringify(body)}`,
  );
  return body as CommittedReceipt;
}

async function processAllJobs(
  sql: ReturnType<typeof postgres>,
  workspaceId: string,
  queue: PostgresJobQueue,
  processor: TelemetryProcessor,
): Promise<void> {
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const job = await queue.claim("live", "oversized-e2e-worker", 60);
    if (job) {
      if (job.job_kind === "normalize") {
        const targets = await processor.normalize(job);
        for (const target of targets) {
          await queue.enqueueReduction({
            workspaceId: target.workspace_id,
            sessionId: target.session_id,
            normalizerVersion: target.normalizer_version,
            activityVersion: target.activity_version,
            targetEventId: target.target_event_id,
            workloadClass: target.workload_class,
          });
        }
      } else {
        await processor.reduce(job, 60_000);
      }
      assert(await queue.complete(job) !== "fenced", "active job was fenced");
      continue;
    }
    const unfinished = await sql.unsafe(
      `select count(*)::int as count
         from processing.telemetry_jobs
        where workspace_id = $1 and status in ('queued', 'leased')`,
      [workspaceId],
    );
    if (Number(unfinished[0].count) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("worker did not drain the oversized E2E queue");
}

async function deleteStorageObjects(
  baseUrl: string,
  key: string,
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    await fetch(`${baseUrl}/storage/v1/object/telemetry-raw/${encoded}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    }).catch(() => undefined);
  }
}

Deno.test({
  name:
    "72,591,045-byte rollout survives collector, Storage, Postgres, worker, and reduction",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 6 });
    const queue = PostgresJobQueue.connect(databaseUrl!, 4);
    const storage = new SupabaseRawStorage(supabaseUrl!, serviceRoleKey!);
    const processor = new TelemetryProcessor(databaseUrl!, storage);
    const temporary = await Deno.makeTempDir({
      prefix: "sherlock-oversized-e2e-",
    });
    const workspaceId = crypto.randomUUID();
    const workspaceSlug = `oversized-e2e-${workspaceId}`;
    const collector = {
      name: "Oversized E2E",
      github_id: `oversized-${workspaceId.slice(0, 24)}`,
      email: `oversized-${workspaceId}@example.com`,
      installation_id: crypto.randomUUID(),
    };
    const storagePaths: string[] = [];
    const previousEnvironment = new Map<string, string | undefined>();
    for (
      const [name, value] of Object.entries({
        SUPABASE_DB_URL: databaseUrl!,
        SUPABASE_URL: supabaseUrl!,
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey!,
        SHERLOCK_WORKSPACE_ID: workspaceId,
      })
    ) {
      previousEnvironment.set(name, Deno.env.get(name));
      Deno.env.set(name, value);
    }
    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name)
         values ($1, $2, 'Oversized rollout E2E')`,
        [workspaceId, workspaceSlug],
      );
      const fixture = await collectorFixture(temporary);
      const rollout = await Deno.stat(fixture.rollout_path);
      const envelopes = await loadSpool(fixture.spool_path);
      assert(fixture.oversized_bytes === MEASURED_MAXIMUM_RECORD_BYTES);
      assert(
        fixture.fragment_count ===
          Math.ceil(MEASURED_MAXIMUM_RECORD_BYTES / FRAGMENT_SOURCE_BYTES),
      );
      assert(envelopes.length === fixture.fragment_count + 1);
      assert(rollout.size === fixture.total_bytes);

      const receipts: CommittedReceipt[] = [];
      for (const envelope of envelopes) {
        const receipt = await uploadEnvelope(envelope, collector);
        receipts.push(receipt);
        storagePaths.push(receipt.storage_path);
      }
      const retry = await uploadEnvelope(envelopes[0], collector);
      assert(retry.batch_id === receipts[0].batch_id, "retry changed batch ID");

      const fragmentEnvelopes = envelopes.filter((envelope) =>
        envelope.manifest.records[0].parse_status === "fragment"
      ).sort((left, right) =>
        (left.manifest.records[0].fragment_index ?? -1) -
        (right.manifest.records[0].fragment_index ?? -1)
      );
      assert(fragmentEnvelopes.length === fixture.fragment_count);
      const reconstructed: Uint8Array[] = [];
      for (let index = 0; index < fragmentEnvelopes.length; index += 1) {
        const envelope = fragmentEnvelopes[index];
        const locator = envelope.manifest.records[0];
        assert(locator.fragment_index === index);
        assert(locator.fragment_count === fixture.fragment_count);
        assert(locator.native_record_start_offset === 0);
        assert(locator.native_record_end_offset === fixture.oversized_bytes);
        assert(locator.native_record_sha256 === fixture.oversized_sha256);
        assert(
          locator.source_start_offset === index * FRAGMENT_SOURCE_BYTES,
        );
        assert(
          locator.source_end_offset === Math.min(
            (index + 1) * FRAGMENT_SOURCE_BYTES,
            fixture.oversized_bytes,
          ),
        );
        const receipt = receipts.find((candidate) =>
          candidate.start_offset === envelope.manifest.start_offset
        );
        assert(receipt, "fragment receipt is missing");
        const stored = await storage.download(
          receipt.storage_path,
          receipt.stored_byte_count,
        );
        reconstructed.push(
          await validateStoredBatch(envelope.manifest, stored),
        );
      }
      const oversized = concatBytes(reconstructed);
      assert(oversized.byteLength === fixture.oversized_bytes);
      assert(await sha256Hex(oversized) === fixture.oversized_sha256);

      const rawRows = await sql.unsafe(
        `select b.start_offset, b.end_offset, r.parse_status,
                r.native_record_start_offset, r.native_record_end_offset,
                r.native_record_sha256, r.fragment_index, r.fragment_count
           from telemetry.ingest_batches b
           join telemetry.native_records r
             on r.workspace_id = b.workspace_id and r.batch_id = b.id
          where b.workspace_id = $1
          order by b.start_offset, r.record_index`,
        [workspaceId],
      );
      assert(
        rawRows.filter((row) => row.parse_status === "fragment").length ===
          fixture.fragment_count,
        "Postgres did not retain every fragment fact",
      );
      assert(
        Number(rawRows.at(-1)?.end_offset) === fixture.total_bytes,
        "the later ordinary batch did not commit",
      );

      await processAllJobs(sql, workspaceId, queue, processor);
      const coverage = await sql.unsafe(
        `select count(*) filter (
                  where e.event_kind = 'unknown'
                    and e.error_code = 'native_fragment'
                )::int as fragments,
                count(*) filter (
                  where e.event_kind = 'agent_message'
                    and e.content_excerpt = 'activity after the oversized record'
                )::int as later_activity
           from telemetry.events e
          where e.workspace_id = $1`,
        [workspaceId],
      );
      assert(Number(coverage[0].fragments) === fixture.fragment_count);
      assert(Number(coverage[0].later_activity) === 1);
      const spans = await sql.unsafe(
        `select count(*)::int as count
           from analytics.activity_spans
          where workspace_id = $1 and is_tombstone = false`,
        [workspaceId],
      );
      assert(Number(spans[0].count) >= 1, "later activity was not reduced");
      const jobs = await sql.unsafe(
        `select count(*) filter (where status <> 'succeeded')::int as failed
           from processing.telemetry_jobs where workspace_id = $1`,
        [workspaceId],
      );
      assert(Number(jobs[0].failed) === 0, "an E2E job did not succeed");
    } finally {
      await deleteStorageObjects(supabaseUrl!, serviceRoleKey!, storagePaths);
      await sql.unsafe(
        "delete from processing.telemetry_jobs where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from analytics.activity_spans where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from telemetry.events where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from telemetry.sessions where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from telemetry.ingest_batches where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from telemetry.people where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from telemetry.workspaces where id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await Promise.allSettled([processor.close(), queue.close(), sql.end()]);
      await Deno.remove(temporary, { recursive: true }).catch(() => undefined);
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    }
  },
});
