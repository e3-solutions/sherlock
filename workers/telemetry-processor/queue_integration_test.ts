import postgres from "npm:postgres@3.4.7";
import { PostgresJobQueue } from "./queue.ts";

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

async function insertQueueBatch(
  sql: ReturnType<typeof postgres>,
  input: {
    id: string;
    workspaceId: string;
    personId: string;
    sourceKind: "rollout" | "transcript" | "hook";
    streamKey: string;
    generationKey: string;
    startOffset: number;
  },
): Promise<void> {
  await sql.unsafe(
    `insert into telemetry.ingest_batches (
       id, workspace_id, person_id, collector_key, source_provider,
       source_kind, source_stream_key, generation_key, generation_seq,
       start_offset, end_offset, source_byte_count, source_sha256,
       storage_path, storage_encoding, stored_byte_count, stored_sha256,
       record_count, contract_version, first_occurred_at, last_occurred_at,
       processing_class_hint
     ) values (
       $1, $2, $3, 'queue-collector', $4, $5, $6, $7, 0,
       $8::bigint, $8::bigint + 1, 1, $9, $10, 'gzip', 1, $11, 1,
       'sherlock.rollout-batch.v1', now(), now(), 'backfill'
     )`,
    [
      input.id,
      input.workspaceId,
      input.personId,
      input.sourceKind === "rollout" ? "codex" : "claude_code",
      input.sourceKind,
      input.streamKey,
      input.generationKey,
      input.startOffset,
      "d".repeat(64),
      `queue-tests/${input.id}.jsonl.gz`,
      "e".repeat(64),
    ],
  );
}

Deno.test({
  name:
    "queue claims are durable, fenced, retryable, and terminally inspectable",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 4 });
    const queue = PostgresJobQueue.connect(databaseUrl!, 4);
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(
          `insert into telemetry.workspaces (id, slug, name)
           values ($1, $2, 'Queue integration test')`,
          [workspaceId, `queue-${workspaceId}`],
        );
        await tx.unsafe(
          `insert into telemetry.people (
             id, workspace_id, identity_key, email
           ) values ($1, $2, 'queue-person', 'queue@example.com')`,
          [personId, workspaceId],
        );
        await tx.unsafe(
          `insert into telemetry.sessions (
             id, workspace_id, person_id, collector_key, native_session_id,
             actor_role, role_version, started_at
           ) values ($1, $2, $3, 'queue-collector', 'queue-session',
                     'primary', 'test.v1', now())`,
          [sessionId, workspaceId, personId],
        );
        await tx.unsafe(
          `insert into telemetry.ingest_batches (
             id, workspace_id, person_id, collector_key,
             source_kind, source_stream_key, generation_key, generation_seq,
             start_offset, end_offset, source_byte_count, source_sha256,
             storage_path, storage_encoding, stored_byte_count, stored_sha256,
             record_count, contract_version,
             first_occurred_at, last_occurred_at
           ) values (
             $1, $2, $3, 'queue-collector', 'rollout', 'queue-stream',
             'queue-generation', 0, 0, 1, 1, $4,
             $5, 'gzip', 1, $6, 1, 'sherlock.rollout-batch.v1', now(), now()
           )`,
          [
            batchId,
            workspaceId,
            personId,
            "a".repeat(64),
            `queue-tests/${batchId}.jsonl.gz`,
            "b".repeat(64),
          ],
        );
      });
      await sql.unsafe(
        `insert into processing.telemetry_jobs (
           workspace_id, job_kind, batch_id, workload_class
         ) values ($1, 'normalize', $2, 'live')
         on conflict (workspace_id, batch_id)
           where job_kind = 'normalize' do nothing`,
        [workspaceId, batchId],
      );
      const count = await sql.unsafe(
        `select count(*)::int as count
           from processing.telemetry_jobs
          where workspace_id = $1 and batch_id = $2`,
        [workspaceId, batchId],
      );
      assert(Number(count[0].count) === 1, "duplicate enqueue must converge");

      const [first, overlapping] = await Promise.all([
        queue.claim("live", "worker-a", 60),
        queue.claim("live", "worker-b", 60),
      ]);
      const claimed = first ?? overlapping;
      assert(claimed !== null, "one worker must claim the job");
      assert(
        (first === null) !== (overlapping === null),
        "SKIP LOCKED must produce exactly one active lease",
      );
      await sql.unsafe(
        `update processing.telemetry_jobs
            set lease_expires_at = now() - interval '1 second'
          where id = $1`,
        [claimed.id.toString()],
      );
      const recovered = await queue.claim("live", "worker-c", 60);
      assert(recovered !== null, "expired leases must be recoverable");
      assert(
        (await queue.complete(claimed)) === "fenced",
        "an expired lease token must not acknowledge reclaimed work",
      );
      assert(
        await queue.retry(recovered, 0, "transient", "retry once"),
        "the active lease must schedule a retry",
      );
      const terminal = await queue.claim("live", "worker-d", 60);
      assert(terminal !== null, "retried work must become claimable");
      await sql.unsafe(
        `update processing.telemetry_jobs
            set attempt_count = attempt_limit,
                lease_expires_at = now() - interval '1 second'
          where id = $1`,
        [terminal.id.toString()],
      );
      assert(
        await queue.terminalizeExpired() === 1,
        "a terminal crash must become an inspectable failure",
      );
      const state = await sql.unsafe(
        `select status, last_error_code, attempt_count, completed_at
           from processing.telemetry_jobs where id = $1`,
        [terminal.id.toString()],
      );
      assert(state[0].status === "failed");
      assert(state[0].last_error_code === "transient");
      assert(state[0].completed_at !== null);

      const orderedFirstId = crypto.randomUUID();
      const orderedSecondId = crypto.randomUUID();
      const independentId = crypto.randomUUID();
      const hookId = crypto.randomUUID();
      await insertQueueBatch(sql, {
        id: orderedFirstId,
        workspaceId,
        personId,
        sourceKind: "transcript",
        streamKey: "ordered-transcript",
        generationKey: "ordered-generation",
        startOffset: 0,
      });
      await insertQueueBatch(sql, {
        id: orderedSecondId,
        workspaceId,
        personId,
        sourceKind: "transcript",
        streamKey: "ordered-transcript",
        generationKey: "ordered-generation",
        startOffset: 1,
      });
      await insertQueueBatch(sql, {
        id: independentId,
        workspaceId,
        personId,
        sourceKind: "rollout",
        streamKey: "independent-codex",
        generationKey: "independent-generation",
        startOffset: 0,
      });
      await insertQueueBatch(sql, {
        id: hookId,
        workspaceId,
        personId,
        sourceKind: "hook",
        streamKey: "independent-hook",
        generationKey: "hook-generation",
        startOffset: 0,
      });
      await sql.unsafe(
        `update processing.telemetry_jobs
            set available_at = case batch_id
              when $2 then now() - interval '4 minutes'
              when $1 then now() - interval '3 minutes'
              when $3 then now() - interval '2 minutes'
              when $4 then now() - interval '1 minute'
              else available_at
            end
          where workspace_id = $5 and batch_id = any($6::uuid[])`,
        [
          orderedFirstId,
          orderedSecondId,
          independentId,
          hookId,
          workspaceId,
          [orderedFirstId, orderedSecondId, independentId, hookId],
        ],
      );

      const orderedFirst = await queue.claim("backfill", "ordered-first", 60);
      assert(
        orderedFirst?.job_kind === "normalize" &&
          orderedFirst.batch_id === orderedFirstId,
        "a later transcript range must not become eligible before its predecessor",
      );
      const independent = await queue.claim("backfill", "independent", 60);
      assert(
        independent?.job_kind === "normalize" &&
          independent.batch_id === independentId,
        "another provider stream must remain concurrently eligible",
      );
      const hook = await queue.claim("backfill", "hook", 60);
      assert(
        hook?.job_kind === "normalize" && hook.batch_id === hookId,
        "a separate hook stream must not wait for transcript normalization",
      );
      assert(
        await queue.retry(
          orderedFirst,
          60,
          "transient_predecessor",
          "retry remains ordered",
        ),
      );
      assert(
        await queue.claim("backfill", "blocked-by-retry", 60) === null,
        "a queued predecessor retry must continue to block later ranges",
      );
      await sql.unsafe(
        `update processing.telemetry_jobs set available_at = now()
          where workspace_id = $1 and batch_id = $2`,
        [workspaceId, orderedFirstId],
      );
      const retriedFirst = await queue.claim("backfill", "retried-first", 60);
      assert(
        retriedFirst?.job_kind === "normalize" &&
          retriedFirst.batch_id === orderedFirstId,
      );
      assert(await queue.complete(retriedFirst) === "succeeded");
      const orderedSecond = await queue.claim("backfill", "ordered-second", 60);
      assert(
        orderedSecond?.job_kind === "normalize" &&
          orderedSecond.batch_id === orderedSecondId,
        "the next transcript range must become eligible after its predecessor",
      );
      const orderedThirdId = crypto.randomUUID();
      await insertQueueBatch(sql, {
        id: orderedThirdId,
        workspaceId,
        personId,
        sourceKind: "transcript",
        streamKey: "ordered-transcript",
        generationKey: "ordered-generation",
        startOffset: 2,
      });
      assert(
        await queue.fail(
          orderedSecond,
          "permanent_source_gap",
          "the predecessor remains auditable",
        ),
      );
      const orderedThird = await queue.claim("backfill", "ordered-third", 60);
      assert(
        orderedThird?.job_kind === "normalize" &&
          orderedThird.batch_id === orderedThirdId,
        "a terminally failed predecessor must not suppress later evidence",
      );
      const failedPredecessor = await sql.unsafe(
        `select status, last_error_code
           from processing.telemetry_jobs
          where workspace_id = $1 and batch_id = $2`,
        [workspaceId, orderedSecondId],
      );
      assert(
        failedPredecessor[0].status === "failed" &&
          failedPredecessor[0].last_error_code === "permanent_source_gap",
        "the released ordering gap must remain explicit and auditable",
      );
      assert(await queue.complete(orderedThird) === "succeeded");
      assert(await queue.complete(independent) === "succeeded");
      assert(await queue.complete(hook) === "succeeded");
      const immutable = await sql.unsafe(
        `select source_sha256, count(*) over ()::int as count
           from telemetry.ingest_batches
          where workspace_id = $1 and id = $2`,
        [workspaceId, batchId],
      );
      assert(immutable.length === 1 && Number(immutable[0].count) === 1);
      assert(immutable[0].source_sha256 === "a".repeat(64));

      let rawMutationRejected = false;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe("set local role sherlock_processor");
          await tx.unsafe(
            "update telemetry.ingest_batches set source_sha256 = $1 where id = $2",
            ["c".repeat(64), batchId],
          );
        });
      } catch {
        rawMutationRejected = true;
      }
      assert(rawMutationRejected, "worker role must not mutate raw facts");

      await queue.enqueueReduction({
        workspaceId,
        sessionId,
        normalizerVersion: "test.normalizer.v1",
        activityVersion: "test.activity.v1",
        targetEventId: 10n,
        workloadClass: "backfill",
      });
      await queue.enqueueReduction({
        workspaceId,
        sessionId,
        normalizerVersion: "test.normalizer.v1",
        activityVersion: "test.activity.v1",
        targetEventId: 20n,
        workloadClass: "live",
      });
      await sql.unsafe(
        `update processing.telemetry_jobs set available_at = now()
          where workspace_id = $1 and session_id = $2`,
        [workspaceId, sessionId],
      );
      const reductions = await sql.unsafe(
        `select count(*)::int as count, max(target_event_id)::text as target,
                min(workload_class) as workload_class
           from processing.telemetry_jobs
          where workspace_id = $1 and session_id = $2`,
        [workspaceId, sessionId],
      );
      assert(Number(reductions[0].count) === 1);
      assert(reductions[0].target === "20");
      assert(reductions[0].workload_class === "live");
      const reduction = await queue.claim("live", "worker-reducer", 60);
      assert(reduction?.job_kind === "reduce");
      await queue.enqueueReduction({
        workspaceId,
        sessionId,
        normalizerVersion: "test.normalizer.v1",
        activityVersion: "test.activity.v1",
        targetEventId: 20n,
        workloadClass: "live",
      });
      assert(
        await queue.complete(reduction) === "requeued",
        "a same-cutoff late-visible event must survive an in-flight completion",
      );
      const sameCutoff = await queue.claim("live", "worker-reducer-2", 60);
      assert(sameCutoff?.job_kind === "reduce");
      assert(sameCutoff.target_event_id === 20n);
      await queue.enqueueReduction({
        workspaceId,
        sessionId,
        normalizerVersion: "test.normalizer.v1",
        activityVersion: "test.activity.v1",
        targetEventId: 30n,
        workloadClass: "live",
      });
      assert(await queue.complete(sameCutoff) === "requeued");
      const newest = await queue.claim("live", "worker-reducer-3", 60);
      assert(newest?.job_kind === "reduce");
      assert(newest.target_event_id === 30n);
      assert(await queue.complete(newest) === "succeeded");
    } finally {
      await sql.unsafe(
        "delete from processing.telemetry_jobs where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from telemetry.ingest_batches where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from telemetry.sessions where workspace_id = $1",
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
      await Promise.allSettled([queue.close(), sql.end()]);
    }
  },
});
