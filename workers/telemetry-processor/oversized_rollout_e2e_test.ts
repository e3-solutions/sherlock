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
  provider: "codex" | "claude_code";
  rollout_path: string;
  subagent_path?: string;
  spool_path: string;
  session_id: string;
  subagent_session_id?: string;
  prompt_id?: string;
  turn_id: string;
  oversized_bytes: number;
  oversized_sha256: string;
  ordinary_bytes: number;
  fragment_count: number;
  total_bytes: number;
  primary_bytes?: number;
  subagent_bytes?: number;
  source_file_count: number;
}

interface SpoolEnvelope {
  spool_version: string;
  manifest: BatchManifest;
  stored_payload_base64: string;
  metadata: Record<string, unknown>;
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

async function collectorFixture(
  root: string,
  provider: "codex" | "claude_code",
): Promise<CollectorFixture> {
  const command = new Deno.Command("python3", {
    args: ["tests/collector/build_oversized_e2e_fixture.py", root, provider],
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

async function assertClaudeDashboard(
  databaseUrl: string,
  workspaceId: string,
): Promise<void> {
  const command = new Deno.Command("node", {
    args: [
      "tests/end-to-end/assert_oversized_claude_dashboard.mjs",
      databaseUrl,
      workspaceId,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(
      `dashboard assertion failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  const receipt = JSON.parse(
    new TextDecoder().decode(output.stdout),
  ) as { roles: string[]; promptCount: number; detailCount: number };
  assert(receipt.roles.join(",") === "agent,subagent");
  assert(receipt.promptCount >= 1);
  assert(receipt.detailCount >= 2);
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
  return envelopes.sort((left, right) => {
    const stream = left.manifest.source_stream_key.localeCompare(
      right.manifest.source_stream_key,
    );
    return stream === 0
      ? left.manifest.start_offset - right.manifest.start_offset
      : stream;
  });
}

function manifestIdentity(manifest: BatchManifest): string {
  return [
    manifest.source_kind,
    manifest.source_stream_key,
    manifest.generation_key,
    manifest.generation_seq,
    manifest.start_offset,
    manifest.end_offset,
    manifest.source_sha256,
  ].join(":");
}

async function uploadEnvelope(
  envelope: SpoolEnvelope,
  collector: Record<string, string>,
): Promise<CommittedReceipt> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const workloadClass = envelope.metadata.workload_class;
  if (workloadClass === "live" || workloadClass === "backfill") {
    headers.set(
      "x-sherlock-workload-class",
      workloadClass,
    );
  }
  const response = await ingestHandler(
    new Request("http://local.test/functions/v1/sherlock-rollout-ingest", {
      method: "POST",
      headers,
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
): Promise<string[]> {
  const normalizedBatchIds: string[] = [];
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const job = await queue.claim("live", "oversized-e2e-worker", 60) ??
      await queue.claim("backfill", "oversized-e2e-worker", 60);
    if (job) {
      if (job.job_kind === "normalize") {
        assert(job.batch_id, "normalize job is missing its batch ID");
        normalizedBatchIds.push(job.batch_id);
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
    if (Number(unfinished[0].count) === 0) return normalizedBatchIds;
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

async function runOversizedE2E(
  provider: "codex" | "claude_code",
): Promise<void> {
  const sql = postgres(databaseUrl!, { prepare: false, max: 6 });
  const queue = PostgresJobQueue.connect(databaseUrl!, 4);
  const storage = new SupabaseRawStorage(supabaseUrl!, serviceRoleKey!);
  const processor = new TelemetryProcessor(databaseUrl!, storage);
  const temporary = await Deno.makeTempDir({
    prefix: `sherlock-oversized-${provider}-e2e-`,
  });
  const workspaceId = crypto.randomUUID();
  const workspaceSlug = `oversized-e2e-${workspaceId}`;
  const collector = {
    name: provider === "claude_code" ? "Oversized Claude E2E" : "Oversized E2E",
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
    const fixture = await collectorFixture(temporary, provider);
    const rollout = await Deno.stat(fixture.rollout_path);
    const envelopes = await loadSpool(fixture.spool_path);
    assert(fixture.oversized_bytes === MEASURED_MAXIMUM_RECORD_BYTES);
    assert(
      fixture.fragment_count ===
        Math.ceil(MEASURED_MAXIMUM_RECORD_BYTES / FRAGMENT_SOURCE_BYTES),
    );
    assert(fixture.fragment_count === 18);
    assert(
      envelopes.length === fixture.fragment_count + fixture.source_file_count,
    );
    assert(rollout.size === (fixture.primary_bytes ?? fixture.total_bytes));
    for (const envelope of envelopes) {
      assert(envelope.manifest.source_provider === provider);
      assert(
        envelope.manifest.source_kind ===
          (provider === "claude_code" ? "transcript" : "rollout"),
      );
    }

    const receiptByManifest = new Map<string, CommittedReceipt>();
    for (const envelope of [...envelopes].reverse()) {
      const receipt = await uploadEnvelope(envelope, collector);
      receiptByManifest.set(manifestIdentity(envelope.manifest), receipt);
      storagePaths.push(receipt.storage_path);
    }
    const retryEnvelope = envelopes.find((envelope) =>
      envelope.manifest.records[0].parse_status === "fragment" &&
      envelope.manifest.records[0].fragment_index === 0
    );
    assert(retryEnvelope, "fragment zero is missing");
    const original = receiptByManifest.get(
      manifestIdentity(retryEnvelope.manifest),
    );
    assert(original, "fragment zero receipt is missing");
    const retry = await uploadEnvelope(retryEnvelope, collector);
    assert(
      JSON.stringify(retry) === JSON.stringify(original),
      "retry changed the committed receipt identity",
    );

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
      assert(envelope.manifest.source_provider === provider);
      assert(
        envelope.manifest.observed_native_session_id === fixture.session_id,
      );
      assert(
        envelope.manifest.observed_parent_native_session_id === null,
      );
      assert(
        envelope.manifest.source_byte_count ===
          (index < fixture.fragment_count - 1
            ? FRAGMENT_SOURCE_BYTES
            : 1_287_877),
      );
      if (provider === "claude_code") {
        assert(envelope.metadata.workload_class === "live");
      }
      assert(
        locator.source_start_offset === index * FRAGMENT_SOURCE_BYTES,
      );
      assert(
        locator.source_end_offset === Math.min(
          (index + 1) * FRAGMENT_SOURCE_BYTES,
          fixture.oversized_bytes,
        ),
      );
      const receipt = receiptByManifest.get(
        manifestIdentity(envelope.manifest),
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
      `select b.id::text batch_id, b.source_provider, b.source_kind,
                b.source_stream_key, b.start_offset, b.end_offset,
                b.processing_class_hint,
                b.observed_native_session_id,
                b.observed_parent_native_session_id, r.parse_status,
                r.native_record_start_offset, r.native_record_end_offset,
                r.native_record_sha256, r.fragment_index, r.fragment_count
           from telemetry.ingest_batches b
           join telemetry.native_records r
             on r.workspace_id = b.workspace_id and r.batch_id = b.id
          where b.workspace_id = $1
          order by b.source_stream_key, b.start_offset, r.record_index`,
      [workspaceId],
    );
    assert(
      rawRows.filter((row) => row.parse_status === "fragment").length ===
        fixture.fragment_count,
      "Postgres did not retain every fragment fact",
    );
    assert(rawRows.every((row) => row.source_provider === provider));
    assert(
      new Set(rawRows.map((row) => row.source_stream_key)).size ===
        fixture.source_file_count,
    );
    const primaryRows = rawRows.filter((row) =>
      row.observed_native_session_id === fixture.session_id
    );
    assert(
      Math.max(...primaryRows.map((row) => Number(row.end_offset))) ===
        (fixture.primary_bytes ?? fixture.total_bytes),
      "the later primary batch did not commit",
    );
    if (provider === "claude_code") {
      assert(
        primaryRows.every((row) => row.processing_class_hint === "live"),
        "Claude primary batches lost their live workload class",
      );
      const subagentRows = rawRows.filter((row) =>
        row.observed_native_session_id === fixture.subagent_session_id
      );
      assert(subagentRows.length >= 1);
      assert(
        subagentRows.every((row) => row.processing_class_hint === "backfill"),
      );
      assert(
        subagentRows.every((row) =>
          row.observed_parent_native_session_id === fixture.session_id
        ),
      );
      assert(
        Math.max(...subagentRows.map((row) => Number(row.end_offset))) ===
          fixture.subagent_bytes,
      );
      const subagentEnvelope = envelopes.find((envelope) =>
        envelope.manifest.observed_native_session_id ===
          fixture.subagent_session_id
      );
      assert(subagentEnvelope?.metadata.workload_class === "backfill");
    }

    const normalizedBatchIds = await processAllJobs(
      sql,
      workspaceId,
      queue,
      processor,
    );
    const normalizedOrder = normalizedBatchIds.map((batchId) => {
      const row = rawRows.find((candidate) => candidate.batch_id === batchId);
      assert(row, `normalized batch ${batchId} is missing`);
      return row;
    });
    const positions = new Map<string, number>();
    for (const row of normalizedOrder) {
      const previous = positions.get(row.source_stream_key) ?? -1;
      assert(
        Number(row.start_offset) > previous,
        "same-stream normalization was not source-offset ordered",
      );
      positions.set(row.source_stream_key, Number(row.start_offset));
    }
    const coverage = await sql.unsafe(
      `select count(*) filter (
                  where e.event_kind = 'unknown'
                    and e.error_code = 'native_fragment'
                )::int as fragments,
                count(*) filter (
                  where e.error_code = 'native_fragment'
                    and (
                      e.event_kind <> 'unknown' or
                      e.event_subtype is not null or
                      e.native_item_id is not null or
                      e.message_role is not null or
                      e.message_origin is not null or
                      e.tool_name is not null or
                      e.tool_status is not null or
                      e.model is not null or
                      e.project_key is not null or
                      e.repo_remote is not null or
                      e.branch is not null or
                      e.cwd is not null or
                      e.usage_stream_key is not null or
                      e.usage_scope is not null or
                      e.usage_is_cumulative is not null or
                      e.content_sha256 is not null or
                      e.content_byte_size is not null or
                      e.content_excerpt is not null or
                      e.turn_id is not null or
                      e.input_tokens is not null or
                      e.cached_input_tokens is not null or
                      e.output_tokens is not null or
                      e.reasoning_tokens is not null or
                      e.total_tokens is not null or
                      e.attributes is not null
                    )
                )::int as unsafe_fragment_projections,
                count(*) filter (
                  where (
                    $2 = 'codex' and e.event_kind = 'agent_message'
                    and e.content_excerpt = 'activity after the oversized record'
                  ) or (
                    $2 = 'claude_code' and e.event_kind = 'message'
                    and e.message_role = 'user'
                    and e.content_excerpt =
                      'activity after the oversized Claude record'
                  )
                )::int as later_activity
           from telemetry.events e
          where e.workspace_id = $1`,
      [workspaceId, provider],
    );
    assert(Number(coverage[0].fragments) === fixture.fragment_count);
    assert(Number(coverage[0].unsafe_fragment_projections) === 0);
    assert(Number(coverage[0].later_activity) === 1);
    if (provider === "claude_code") {
      const subagentSessionId = fixture.subagent_session_id;
      assert(subagentSessionId, "Claude fixture is missing its subagent ID");
      const sessions = await sql.unsafe(
        `select native_session_id, parent_native_session_id,
                  parent_session_id::text parent_session_id, actor_role,
                  title, branch, cwd, model
             from telemetry.sessions
            where workspace_id = $1
              and native_session_id in ($2, $3)
            order by native_session_id`,
        [workspaceId, fixture.session_id, subagentSessionId],
      );
      const primary = sessions.find((row) =>
        row.native_session_id === fixture.session_id
      );
      const subagent = sessions.find((row) =>
        row.native_session_id === subagentSessionId
      );
      assert(primary?.actor_role === "primary");
      assert(primary.title === null);
      assert(primary.branch === null);
      assert(primary.cwd === null);
      assert(primary.model === "claude-sonnet-4");
      assert(subagent?.actor_role === "worker");
      assert(subagent.parent_native_session_id === fixture.session_id);
      assert(subagent.parent_session_id, "subagent database parent is missing");
      const turnCoverage = await sql.unsafe(
        `select count(*) filter (
                    where turn_id = $2 and event_kind = 'message'
                      and message_role = 'user'
                  )::int as user_messages,
                  count(*) filter (
                    where turn_id = $2 and event_kind = 'message'
                      and message_role = 'assistant'
                  )::int as assistant_messages,
                  count(*) filter (
                    where turn_id = $2 and event_kind = 'tool_call'
                  )::int as tool_calls,
                  count(*) filter (
                    where turn_id = $2 and event_kind = 'tool_result'
                  )::int as tool_results
             from telemetry.events
            where workspace_id = $1`,
        [workspaceId, fixture.turn_id],
      );
      assert(Number(turnCoverage[0].user_messages) === 1);
      assert(Number(turnCoverage[0].assistant_messages) === 1);
      assert(Number(turnCoverage[0].tool_calls) === 1);
      assert(Number(turnCoverage[0].tool_results) === 1);
    }
    const spans = await sql.unsafe(
      `select count(*)::int as count,
                count(*) filter (where activity_kind = 'tool')::int as tools
           from analytics.activity_spans
          where workspace_id = $1 and is_tombstone = false`,
      [workspaceId],
    );
    assert(Number(spans[0].count) >= 1, "later activity was not reduced");
    if (provider === "claude_code") {
      assert(Number(spans[0].tools) >= 1, "later Claude tool was not reduced");
      await sql.unsafe("grant sherlock_reader to postgres");
      await assertClaudeDashboard(databaseUrl!, workspaceId);
    }
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
}

Deno.test({
  name:
    "72,591,045-byte rollout survives collector, Storage, Postgres, worker, and reduction",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => runOversizedE2E("codex"),
});

Deno.test({
  name:
    "72,591,045-byte Claude transcript preserves provider topology and later activity end to end",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => runOversizedE2E("claude_code"),
});
