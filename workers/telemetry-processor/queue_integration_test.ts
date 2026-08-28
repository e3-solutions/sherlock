import postgres from "./postgres.ts";
import {
  ADMISSION_HEADROOM_SQL,
  GITHUB_PENDING_QUERY_TIMEOUT_MILLISECONDS,
  PostgresJobQueue,
} from "./queue.ts";

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

function explainPlanNodes(value: unknown): Record<string, unknown>[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const nodes: Record<string, unknown>[] = [];
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child);
    } else if (candidate !== null && typeof candidate === "object") {
      const node = candidate as Record<string, unknown>;
      if ("Node Type" in node) nodes.push(node);
      for (const child of Object.values(node)) visit(child);
    }
  };
  visit(parsed);
  return nodes;
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
    workloadClass?: "live" | "backfill";
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
       'sherlock.rollout-batch.v1', now(), now(), $12
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
      input.workloadClass ?? "backfill",
    ],
  );
}

function job(
  workspaceId: string,
  sessionId: string,
  targetEventId: bigint,
  workloadClass: "live" | "backfill",
) {
  return {
    workspaceId,
    sessionId,
    normalizerVersion: "test.normalizer.v1",
    activityVersion: "test.activity.v1",
    targetEventId,
    workloadClass,
  };
}

async function reductionState(
  sql: Sql,
  workspace: string,
  session: string,
) {
  const [row] = await sql.unsafe(
    `select status, attempt_count, requeue_count, completed_at,
            request_generation::text as request_generation, workload_class
       from processing.telemetry_jobs
      where workspace_id = $1 and session_id = $2`,
    [workspace, session],
  );
  return row;
}

async function insertQueueFixture(
  sql: ReturnType<typeof postgres>,
  label: string,
): Promise<{ workspaceId: string; personId: string }> {
  const workspaceId = crypto.randomUUID();
  const personId = crypto.randomUUID();
  await sql.unsafe(
    `insert into telemetry.workspaces (id, slug, name)
     values ($1, $2, 'Queue mixed-lane integration test')`,
    [workspaceId, `${label}-${workspaceId}`],
  );
  await sql.unsafe(
    `insert into telemetry.people (id, workspace_id, identity_key, email)
     values ($1, $2, $3, $4)`,
    [
      personId,
      workspaceId,
      `${label}-person`,
      `${label}-${workspaceId}@example.com`,
    ],
  );
  return { workspaceId, personId };
}

async function deleteQueueFixture(
  sql: ReturnType<typeof postgres>,
  workspaceId: string,
): Promise<void> {
  await sql.unsafe(
    "delete from processing.telemetry_jobs where workspace_id = $1",
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
}

async function insertGithubFact(
  sql: Sql,
  input: {
    workspaceId: string;
    personId: string;
    label: string;
    commitSha: string;
    createdAt: string;
    recentEvent: "live" | "replay" | null;
  },
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  await sql.unsafe(
    `insert into telemetry.sessions (
       id, workspace_id, person_id, collector_key, native_session_id,
       actor_role, role_version, started_at
     ) values ($1, $2, $3, 'github-query-test', $4,
               'primary', 'test.v1', now())`,
    [sessionId, input.workspaceId, input.personId, input.label],
  );
  await insertQueueBatch(sql, {
    id: batchId,
    workspaceId: input.workspaceId,
    personId: input.personId,
    sourceKind: "rollout",
    streamKey: input.label,
    generationKey: input.label,
    startOffset: 0,
  });
  const [record] = await sql.unsafe(
    `insert into telemetry.native_records (
       workspace_id, batch_id, record_index, source_start_offset,
       source_end_offset, record_sha256, native_type, occurred_at,
       parse_status
     ) values ($1, $2, 0, 0, 1, repeat('a', 64), 'session_meta',
               now(), 'ok')
     returning id`,
    [input.workspaceId, batchId],
  );
  await sql.unsafe(
    `insert into telemetry.session_scm (
       workspace_id, source_record_id, session_id, source_version,
       repository_full_name, commit_sha, observed_at, server_received_at,
       created_at
     ) values ($1, $2, $3, 'sherlock.github-scm.v1', $4, $5,
               now(), now(), $6)`,
    [
      input.workspaceId,
      record.id,
      sessionId,
      `e3-solutions/${input.label}`,
      input.commitSha,
      input.createdAt,
    ],
  );
  if (input.recentEvent !== null) {
    await sql.unsafe(
      `insert into telemetry.events (
         workspace_id, session_id, source_record_id, normalizer_version,
         projection_index, source_priority, is_replay, event_kind,
         occurred_at, server_received_at
       ) values ($1, $2, $3, 'queue.github-query-test.v1', 0, 0, $4,
                 'lifecycle', now(), now())`,
      [
        input.workspaceId,
        sessionId,
        record.id,
        input.recentEvent === "replay",
      ],
    );
  }
}

async function deleteGithubFixture(sql: Sql, workspaceId: string) {
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
    "delete from telemetry.sessions where workspace_id = $1",
    [workspaceId],
  ).catch(() => undefined);
  await deleteQueueFixture(sql, workspaceId);
}

Deno.test({
  name:
    "queue claims are durable, fenced, retryable, and terminally inspectable",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 4 });
    const conflictingDatabaseUrl = new URL(databaseUrl!);
    conflictingDatabaseUrl.searchParams.set("application_name", "railway");
    const queue = PostgresJobQueue.connect(
      conflictingDatabaseUrl.toString(),
      4,
    );
    const replacementQueue = PostgresJobQueue.connect(databaseUrl!, 4);
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    try {
      const handoffKey = `queue-test-${workspaceId}`;
      assert(await queue.tryAcquireHandoff(handoffKey));
      const controlSessions = await sql.unsafe(
        `select count(*)::integer as connections
           from pg_stat_activity
          where application_name = 'sherlock-worker-control'`,
      );
      assert(
        controlSessions[0].connections >= 1,
        "the worker control label must override a conflicting URL parameter",
      );
      assert(
        await queue.hasAdmissionHeadroom(0, 11),
        "an unconstrained admission must see ordinary local database headroom",
      );
      assert(
        !(await queue.hasAdmissionHeadroom(1_000_000, 11)),
        "admission must stop when the requested reader reserve cannot fit",
      );
      assert(
        !(await replacementQueue.tryAcquireHandoff(handoffKey)),
        "a replacement must wait with one control session",
      );
      await queue.releaseHandoff();
      assert(
        await replacementQueue.tryAcquireHandoff(handoffKey),
        "a replacement must acquire after the owner releases",
      );
      await replacementQueue.releaseHandoff();

      const schedulerIndexes = await sql.unsafe(
        `select indexname from pg_indexes
          where schemaname = 'processing'
            and indexname = any($1::text[])`,
        [[
          "telemetry_jobs_kind_claim_idx",
          "telemetry_jobs_kind_expired_lease_idx",
          "telemetry_jobs_live_normalize_age_idx",
        ]],
      );
      assert(
        schedulerIndexes.length === 3,
        "scheduler claim indexes must be installed",
      );
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
        await tx.unsafe(
          `with record as (
             insert into telemetry.native_records (
               workspace_id, batch_id, record_index, source_start_offset,
               source_end_offset, record_sha256, native_type, occurred_at,
               parse_status
             ) values ($1, $2, 0, 0, 1, repeat('c', 64), 'session_meta',
                       now(), 'ok')
             returning id
           ), scm as (
             insert into telemetry.session_scm (
             workspace_id, source_record_id, session_id, source_version,
             repository_full_name, commit_sha, observed_at, server_received_at,
             created_at
           )
           select $1, id, $3, 'sherlock.github-scm.v1',
                  'e3-solutions/sherlock', repeat('a', 40), now(), now(),
                  now() - interval '27 hours'
             from record
           returning source_record_id
           )
           insert into telemetry.events (
             workspace_id, session_id, source_record_id, normalizer_version,
             projection_index, source_priority, is_replay, event_kind,
             occurred_at, server_received_at
           )
           select $1, $3, source_record_id, 'queue.github-test.v1', 0, 0,
                  false, 'lifecycle', now(), now()
             from scm`,
          [workspaceId, batchId, sessionId],
        );
      });
      assert(
        (await queue.pendingGithubCommitPairs(1, [crypto.randomUUID()]))
          .length === 0,
        "GitHub sync must exclude workspaces outside its allowlist",
      );
      const githubPairs = await queue.pendingGithubCommitPairs(1, [
        workspaceId,
      ]);
      assert(
        githubPairs.length === 1 &&
          githubPairs[0].workspaceId === workspaceId,
        "GitHub sync must select an allowed old SCM fact with a recent event",
      );
      await sql.unsafe(
        `insert into processing.telemetry_jobs (
           workspace_id, job_kind, batch_id, normalizer_version, workload_class
         ) values ($1, 'normalize', $2, 'sherlock.codex-rollout.v2', 'live')
         on conflict (workspace_id, batch_id, normalizer_version)
           where job_kind = 'normalize' do nothing`,
        [workspaceId, batchId],
      );

      // Exercise stream-order planning with enough immutable ranges that a
      // correlated predecessor probe becomes visible in the analyzed plan.
      await sql.unsafe(
        `insert into telemetry.ingest_batches (
           id, workspace_id, person_id, collector_key, source_provider,
           source_kind, source_stream_key, generation_key, generation_seq,
           start_offset, end_offset, source_byte_count, source_sha256,
           storage_path, storage_encoding, stored_byte_count, stored_sha256,
           record_count, contract_version, first_occurred_at, last_occurred_at,
           processing_class_hint
         )
         select gen_random_uuid(), $1::uuid, $2::uuid, 'queue-plan-collector', 'claude_code',
                'transcript', 'queue-plan-stream', 'queue-plan-generation', 0,
                offset_value, offset_value + 1, 1, repeat('f', 64),
                'queue-plan/' || ($1::uuid)::text || '/' || offset_value || '.jsonl.gz',
                'gzip', 1, repeat('0', 64), 1,
                'sherlock.transcript-batch.v1', now(), now(), 'backfill'
           from generate_series(0, 1999) offset_value`,
        [workspaceId, personId],
      );
      await sql.unsafe(
        `insert into telemetry.ingest_batches (
           id, workspace_id, person_id, collector_key, source_provider,
           source_kind, source_stream_key, generation_key, generation_seq,
           start_offset, end_offset, source_byte_count, source_sha256,
           storage_path, storage_encoding, stored_byte_count, stored_sha256,
           record_count, contract_version, first_occurred_at, last_occurred_at,
           processing_class_hint
         ) values (
           gen_random_uuid(), $1, $2, 'queue-plan-collector', 'claude_code',
           'transcript', 'queue-plan-stream', 'queue-plan-generation', 0,
           0, 2, 2, repeat('f', 64),
           'queue-plan/' || ($1::uuid)::text || '/same-offset.jsonl.gz',
           'gzip', 1, repeat('0', 64), 1,
           'sherlock.transcript-batch.v1', now(), now(), 'backfill'
         )`,
        [workspaceId, personId],
      );
      await sql.unsafe(
        `update processing.telemetry_jobs job
            set available_at = case when batch.start_offset = 0
                  then now() - interval '2 minutes'
                  else now() - interval '1 minute' end,
                status = case when batch.start_offset = 0
                  then 'leased' else job.status end,
                attempt_count = case when batch.start_offset = 0
                  then 1 else job.attempt_count end,
                lease_token = case when batch.start_offset = 0
                  then gen_random_uuid() else job.lease_token end,
                lease_owner = case when batch.start_offset = 0
                  then 'expired-plan-test' else job.lease_owner end,
                lease_started_at = case when batch.start_offset = 0
                  then now() - interval '2 minutes' else job.lease_started_at end,
                lease_expires_at = case when batch.start_offset = 0
                  then now() - interval '1 minute' else job.lease_expires_at end
           from telemetry.ingest_batches batch
          where job.workspace_id = $1 and job.batch_id = batch.id
            and batch.collector_key = 'queue-plan-collector'`,
        [workspaceId],
      );
      const eligibleOffsets = await sql.unsafe(
        `with pending_normalize as (
           select pending_job.id,
                  min(pending_batch.start_offset) over (
                    partition by pending_batch.workspace_id,
                                 pending_batch.collector_key,
                                 pending_batch.source_kind,
                                 pending_batch.source_stream_key,
                                 pending_batch.generation_seq,
                                 pending_batch.generation_key
                  ) as earliest_start
             from processing.telemetry_jobs pending_job
             join telemetry.ingest_batches pending_batch
               on pending_batch.workspace_id = pending_job.workspace_id
              and pending_batch.id = pending_job.batch_id
            where pending_job.job_kind = 'normalize'
              and pending_job.status in ('queued', 'leased')
         )
         select count(*)::int as count,
                count(distinct batch.start_offset)::int as offsets,
                count(*) filter (where job.status = 'leased')::int as leased
           from processing.telemetry_jobs job
           join telemetry.ingest_batches batch
             on batch.workspace_id = job.workspace_id and batch.id = job.batch_id
           join pending_normalize pending on pending.id = job.id
          where job.workspace_id = $1
            and job.workload_class = 'backfill'
            and job.job_kind = 'normalize'
            and job.attempt_count < job.attempt_limit
            and (
              (job.status = 'queued' and job.available_at <= now()) or
              (job.status = 'leased' and job.lease_expires_at <= now())
            )
            and batch.start_offset = pending.earliest_start`,
        [workspaceId],
      );
      assert(
        Number(eligibleOffsets[0].count) === 2 &&
          Number(eligibleOffsets[0].offsets) === 1 &&
          Number(eligibleOffsets[0].leased) === 2,
        "same-offset expired leases must remain concurrently eligible",
      );
      const explained = await sql.unsafe(
        `explain (analyze, buffers, format json)
         with pending_normalize as (
           select pending_job.id,
                  min(pending_batch.start_offset) over (
                    partition by pending_batch.workspace_id,
                                 pending_batch.collector_key,
                                 pending_batch.source_kind,
                                 pending_batch.source_stream_key,
                                 pending_batch.generation_seq,
                                 pending_batch.generation_key
                  ) as earliest_start
             from processing.telemetry_jobs pending_job
             join telemetry.ingest_batches pending_batch
               on pending_batch.workspace_id = pending_job.workspace_id
              and pending_batch.id = pending_job.batch_id
            where pending_job.job_kind = 'normalize'
              and pending_job.status in ('queued', 'leased')
         )
         select job.id
           from processing.telemetry_jobs job
           left join telemetry.ingest_batches batch
             on job.job_kind = 'normalize'
            and batch.workspace_id = job.workspace_id
            and batch.id = job.batch_id
           left join pending_normalize pending on pending.id = job.id
          where job.workload_class = 'backfill'
            and job.job_kind = 'normalize'
            and job.attempt_count < job.attempt_limit
            and (
              (job.status = 'queued' and job.available_at <= now()) or
              (job.status = 'leased' and job.lease_expires_at <= now())
            )
            and (batch.id is null or batch.start_offset = pending.earliest_start)
          order by case when job.status = 'queued' then job.available_at
                        else job.lease_expires_at end,
                   job.id
          for update of job skip locked limit 1`,
      );
      const planNodes = explainPlanNodes(Object.values(explained[0])[0]);
      assert(
        planNodes.some((node) => node["Node Type"] === "WindowAgg"),
        "claim planning must rank pending stream offsets once",
      );
      assert(
        !planNodes.some((node) =>
          node["Index Name"] === "telemetry_jobs_batch_key" &&
          Number(node["Actual Loops"] ?? 0) > 64
        ),
        "claim planning must not probe queue state once per earlier range",
      );
      await sql.unsafe(
        `delete from processing.telemetry_jobs job
          using telemetry.ingest_batches batch
          where job.workspace_id = $1 and job.batch_id = batch.id
            and batch.collector_key = 'queue-plan-collector'`,
        [workspaceId],
      );
      await sql.unsafe(
        `delete from telemetry.ingest_batches
          where workspace_id = $1 and collector_key = 'queue-plan-collector'`,
        [workspaceId],
      );
      const count = await sql.unsafe(
        `select count(*)::int as count
           from processing.telemetry_jobs
          where workspace_id = $1 and batch_id = $2`,
        [workspaceId, batchId],
      );
      assert(Number(count[0].count) === 1, "duplicate enqueue must converge");
      assert(
        await queue.claim("live", "wrong-kind", 60, "reduce") === null,
        "job-kind reservations must not consume normalization work",
      );
      const oldestLiveNormalize = await queue
        .oldestLiveNormalizationAgeSeconds();
      assert(
        oldestLiveNormalize !== null && oldestLiveNormalize >= 0,
        "overload age must observe queued live normalization",
      );

      const [first, overlapping] = await Promise.all([
        queue.claim("live", "worker-a", 60),
        queue.claim("live", "worker-b", 60),
      ]);
      const claimed = first ?? overlapping;
      assert(claimed !== null, "one worker must claim the job");
      assert(
        claimed.job_kind === "normalize" &&
          claimed.normalizer_version === "sherlock.codex-rollout.v2",
        "claims must preserve the versioned provider normalization target",
      );
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

      await queue.enqueueReduction(
        job(workspaceId, sessionId, 10n, "backfill"),
      );
      await queue.enqueueReduction(job(workspaceId, sessionId, 20n, "live"));
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
      await queue.enqueueReduction(job(workspaceId, sessionId, 20n, "live"));
      assert(
        await queue.complete(reduction) === "requeued",
        "a same-cutoff late-visible event must survive an in-flight completion",
      );
      const sameCutoff = await queue.claim("live", "worker-reducer-2", 60);
      assert(sameCutoff?.job_kind === "reduce");
      assert(sameCutoff.target_event_id === 20n);
      await queue.enqueueReduction(job(workspaceId, sessionId, 30n, "live"));
      assert(await queue.complete(sameCutoff) === "requeued");
      const newest = await queue.claim("live", "worker-reducer-3", 60);
      assert(newest?.job_kind === "reduce");
      assert(newest.target_event_id === 30n);
      assert(await queue.complete(newest) === "succeeded");

      await queue.enqueueReductions([
        job(workspaceId, sessionId, 30n, "backfill"),
      ]);
      const resetSucceeded = await reductionState(sql, workspaceId, sessionId);
      assert(resetSucceeded.status === "queued");
      assert(Number(resetSucceeded.attempt_count) === 0);
      assert(resetSucceeded.completed_at === null);
      assert(resetSucceeded.request_generation === "5");
      assert(
        resetSucceeded.workload_class === "live",
        "a prior live request must not be demoted",
      );
      await sql.unsafe(
        `update processing.telemetry_jobs set available_at = now()
          where workspace_id = $1 and session_id = $2`,
        [workspaceId, sessionId],
      );
      const failedReduction = await queue.claim("live", "worker-failure", 60);
      assert(failedReduction?.job_kind === "reduce");
      assert(await queue.fail(failedReduction, "test_failure", "test failure"));
      await queue.enqueueReductions([
        job(workspaceId, sessionId, 30n, "backfill"),
      ]);
      const resetFailed = await reductionState(sql, workspaceId, sessionId);
      assert(resetFailed.status === "queued");
      assert(Number(resetFailed.attempt_count) === 0);
      assert(Number(resetFailed.requeue_count) === 1);
      assert(resetFailed.completed_at === null);
      assert(resetFailed.request_generation === "6");

      const batchSessions = await sql.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           actor_role, role_version, started_at
         )
         select gen_random_uuid(), $1::uuid, $2::uuid, 'queue-batch',
                'queue-batch-' || ordinal, 'worker', 'test.v1', now()
           from generate_series(1, 75) ordinal
         returning id::text as id`,
        [workspaceId, personId],
      );
      const batchTargets = batchSessions.map((row, index) => ({
        workspaceId,
        sessionId: String(row.id),
        normalizerVersion: "test.batch-normalizer.v1",
        activityVersion: "test.batch-activity.v1",
        targetEventId: BigInt(index + 1),
        workloadClass: "backfill" as const,
      }));
      await queue.enqueueReductions([
        ...batchTargets,
        {
          ...batchTargets[0],
          targetEventId: 500n,
          workloadClass: "live",
        },
      ]);
      const firstBatchState = await sql.unsafe(
        `select count(*)::int as count,
                min(request_generation)::int as min_generation,
                max(request_generation)::int as max_generation,
                max(target_event_id)::text as max_target,
                count(*) filter (where workload_class = 'live')::int as live
           from processing.telemetry_jobs
          where workspace_id = $1
            and normalizer_version = 'test.batch-normalizer.v1'`,
        [workspaceId],
      );
      assert(
        Number(firstBatchState[0].count) === 75 &&
          Number(firstBatchState[0].min_generation) === 1 &&
          Number(firstBatchState[0].max_generation) === 1 &&
          firstBatchState[0].max_target === "500" &&
          Number(firstBatchState[0].live) === 1,
        "a load-shaped reduction batch must insert every target once",
      );
      await sql.unsafe(
        `update processing.telemetry_jobs set available_at = now()
          where workspace_id = $1
            and normalizer_version = 'test.batch-normalizer.v1'`,
        [workspaceId],
      );
      const leasedBatchTarget = await queue.claim(
        "backfill",
        "batch-reducer",
        60,
        "reduce",
      );
      assert(leasedBatchTarget?.job_kind === "reduce");
      await queue.enqueueReductions(batchTargets.map((target) => ({
        ...target,
        targetEventId: target.targetEventId + 100n,
        workloadClass: "live" as const,
      })));
      const secondBatchState = await sql.unsafe(
        `select count(*)::int as count,
                min(request_generation)::int as min_generation,
                max(request_generation)::int as max_generation,
                count(*) filter (where workload_class = 'live')::int as live,
                count(*) filter (where status = 'leased')::int as leased
           from processing.telemetry_jobs
          where workspace_id = $1
            and normalizer_version = 'test.batch-normalizer.v1'`,
        [workspaceId],
      );
      assert(
        Number(secondBatchState[0].count) === 75 &&
          Number(secondBatchState[0].min_generation) === 2 &&
          Number(secondBatchState[0].max_generation) === 2 &&
          Number(secondBatchState[0].live) === 75 &&
          Number(secondBatchState[0].leased) === 1,
        "batch upsert must preserve convergence and leased dirty-generation semantics",
      );
      assert(
        await queue.complete(leasedBatchTarget) === "requeued",
        "a batched update must fence an in-flight stale reduction generation",
      );
      await sql.unsafe(
        `delete from processing.telemetry_jobs
          where workspace_id = $1
            and normalizer_version = 'test.batch-normalizer.v1'`,
        [workspaceId],
      );
      await sql.unsafe(
        `delete from telemetry.sessions
          where workspace_id = $1 and collector_key = 'queue-batch'`,
        [workspaceId],
      );
    } finally {
      await sql.unsafe(
        "delete from telemetry.session_scm where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from telemetry.native_records where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
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
      await Promise.allSettled([
        replacementQueue.close(),
        queue.close(),
        sql.end(),
      ]);
    }
  },
});

Deno.test({
  name:
    "GitHub candidates union recent SCM with non-replay active sessions once",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 2 });
    const queue = PostgresJobQueue.connect(databaseUrl!, 1);
    const { workspaceId, personId } = await insertQueueFixture(
      sql,
      "github-candidates",
    );
    const now = Date.now();
    try {
      await insertGithubFact(sql, {
        workspaceId,
        personId,
        label: "recent-and-active",
        commitSha: "a".repeat(40),
        createdAt: new Date(now).toISOString(),
        recentEvent: "live",
      });
      await insertGithubFact(sql, {
        workspaceId,
        personId,
        label: "old-but-active",
        commitSha: "b".repeat(40),
        createdAt: new Date(now - 27 * 60 * 60 * 1_000).toISOString(),
        recentEvent: "live",
      });
      await insertGithubFact(sql, {
        workspaceId,
        personId,
        label: "old-replay-only",
        commitSha: "c".repeat(40),
        createdAt: new Date(now - 27 * 60 * 60 * 1_000).toISOString(),
        recentEvent: "replay",
      });
      await insertGithubFact(sql, {
        workspaceId,
        personId,
        label: "old-inactive",
        commitSha: "d".repeat(40),
        createdAt: new Date(now - 27 * 60 * 60 * 1_000).toISOString(),
        recentEvent: null,
      });

      assert(
        GITHUB_PENDING_QUERY_TIMEOUT_MILLISECONDS === 20_000,
        "GitHub candidate selection must have a short server-side deadline",
      );
      assert(
        (await queue.pendingGithubCommitPairs(10, [crypto.randomUUID()]))
          .length === 0,
        "recent events must not cross the workspace allowlist",
      );
      const pairs = await queue.pendingGithubCommitPairs(10, [workspaceId]);
      assert(
        pairs.length === 2,
        "only recent SCM and non-replay active-session facts are candidates",
      );
      assert(
        new Set(pairs.map((pair) => pair.repositoryFullName)).size === 2,
        "a fact present in both branches must be returned once",
      );
      assert(
        pairs.some((pair) =>
          pair.repositoryFullName === "e3-solutions/recent-and-active"
        ) &&
          pairs.some((pair) =>
            pair.repositoryFullName === "e3-solutions/old-but-active"
          ),
        "both candidate sources must remain visible",
      );
    } finally {
      await deleteGithubFixture(sql, workspaceId);
      await Promise.allSettled([queue.close(), sql.end()]);
    }
  },
});

Deno.test({
  name:
    "live normalization claims an ordered backfill prerequisite without borrowing unrelated backfill",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 4 });
    const queue = PostgresJobQueue.connect(databaseUrl!, 4);
    const competingQueue = PostgresJobQueue.connect(databaseUrl!, 2);
    const { workspaceId, personId } = await insertQueueFixture(
      sql,
      "mixed-lane",
    );
    const batchIds = {
      prerequisite: crypto.randomUUID(),
      live: crypto.randomUUID(),
      independentLive: crypto.randomUUID(),
      unrelatedBackfill: crypto.randomUUID(),
      futurePrerequisite: crypto.randomUUID(),
      futureLive: crypto.randomUUID(),
    };
    try {
      const batches = [
        [batchIds.prerequisite, "mixed", 0, "backfill"],
        [batchIds.live, "mixed", 1, "live"],
        [batchIds.independentLive, "independent", 0, "live"],
        [batchIds.unrelatedBackfill, "unrelated", 0, "backfill"],
        [batchIds.futurePrerequisite, "future", 0, "backfill"],
        [batchIds.futureLive, "future", 1, "live"],
      ] as const;
      for (const [id, stream, startOffset, workloadClass] of batches) {
        await insertQueueBatch(sql, {
          id,
          workspaceId,
          personId,
          sourceKind: "transcript",
          streamKey: `${stream}-stream`,
          generationKey: `${stream}-generation`,
          startOffset,
          workloadClass,
        });
      }
      await sql.unsafe(
        `update processing.telemetry_jobs
            set available_at = case
              when batch_id = $1 then now() - interval '10 minutes'
              when batch_id = $2 then now() - interval '4 minutes'
              when batch_id = $3 then now() + interval '1 hour'
              else now() - interval '5 minutes' end,
                created_at = case
                  when batch_id = $2 then now() - interval '6 minutes'
                  when batch_id = $4 then now() - interval '5 minutes'
                  else created_at end
          where workspace_id = $5`,
        [
          batchIds.unrelatedBackfill,
          batchIds.independentLive,
          batchIds.futureLive,
          batchIds.live,
          workspaceId,
        ],
      );

      const independentLive = await queue.claimLiveNormalizationFrontier(
        "live-frontier-a",
        60,
      );
      assert(
        independentLive?.job_kind === "normalize" &&
          independentLive.batch_id === batchIds.independentLive &&
          independentLive.workload_class === "live",
        "the oldest ready live demand must win across stream frontiers",
      );
      assert(await queue.complete(independentLive) === "succeeded");

      const prerequisite = await competingQueue
        .claimLiveNormalizationFrontier("live-frontier-b", 60);
      assert(
        prerequisite?.job_kind === "normalize" &&
          prerequisite.batch_id === batchIds.prerequisite,
        "live demand must pull its own earliest unfinished stream range",
      );
      assert(
        prerequisite.workload_class === "backfill",
        "dependency scheduling must preserve the prerequisite's stored workload class",
      );

      assert(
        await competingQueue.claimLiveNormalizationFrontier(
          "live-frontier-blocked",
          60,
        ) === null,
        "an active prerequisite must block its descendant without borrowing unrelated work",
      );
      assert(await competingQueue.complete(prerequisite) === "succeeded");

      const live = await queue.claimLiveNormalizationFrontier(
        "live-frontier-descendant",
        60,
      );
      assert(
        live?.job_kind === "normalize" &&
          live.batch_id === batchIds.live &&
          live.workload_class === "live",
        "the live descendant must follow its completed prerequisite",
      );
      assert(await queue.complete(live) === "succeeded");
      assert(
        await queue.claimLiveNormalizationFrontier("live-frontier-done", 60) ===
          null,
        "a ready prerequisite must not be borrowed for delayed live demand",
      );

      const states = await sql.unsafe(
        `select job.batch_id::text as batch_id, job.status,
                job.workload_class, batch.processing_class_hint
           from processing.telemetry_jobs job
           join telemetry.ingest_batches batch
             on batch.workspace_id = job.workspace_id
            and batch.id = job.batch_id
          where job.workspace_id = $1`,
        [workspaceId],
      );
      const byBatch = new Map(
        states.map((row) => [String(row.batch_id), row]),
      );
      assert(
        byBatch.get(batchIds.unrelatedBackfill)?.status === "queued",
        "live capacity must not borrow an unrelated backfill partition",
      );
      assert(
        byBatch.get(batchIds.futurePrerequisite)?.status === "queued" &&
          byBatch.get(batchIds.futureLive)?.status === "queued",
        "delayed live demand and its prerequisite must remain untouched",
      );
      assert(
        byBatch.get(batchIds.prerequisite)?.workload_class === "backfill" &&
          byBatch.get(batchIds.prerequisite)?.processing_class_hint ===
            "backfill",
        "claiming a dependency must not rewrite raw or queue classification facts",
      );
    } finally {
      await deleteQueueFixture(sql, workspaceId);
      await Promise.allSettled([
        competingQueue.close(),
        queue.close(),
        sql.end(),
      ]);
    }
  },
});

Deno.test({
  name:
    "concurrent live-frontier owners drain a bounded mixed-lane backlog without duplication or reordering",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 8 });
    const queue = PostgresJobQueue.connect(databaseUrl!, 8);
    const { workspaceId, personId } = await insertQueueFixture(
      sql,
      "mixed-load",
    );
    const streamCount = 12;
    const rangesPerStream = 4;
    const batchFacts = new Map<string, { stream: number; offset: number }>();
    const unrelatedBackfillId = crypto.randomUUID();
    try {
      const inserts: Promise<void>[] = [];
      for (let stream = 0; stream < streamCount; stream += 1) {
        for (let offset = 0; offset < rangesPerStream; offset += 1) {
          const id = crypto.randomUUID();
          batchFacts.set(id, { stream, offset });
          inserts.push(insertQueueBatch(sql, {
            id,
            workspaceId,
            personId,
            sourceKind: "transcript",
            streamKey: `mixed-load-stream-${stream}`,
            generationKey: `mixed-load-generation-${stream}`,
            startOffset: offset,
            workloadClass: offset === 0 ? "backfill" : "live",
          }));
        }
      }
      inserts.push(insertQueueBatch(sql, {
        id: unrelatedBackfillId,
        workspaceId,
        personId,
        sourceKind: "transcript",
        streamKey: "mixed-load-unrelated",
        generationKey: "mixed-load-unrelated-generation",
        startOffset: 0,
        workloadClass: "backfill",
      }));
      await Promise.all(inserts);

      const nextOffset = new Map<number, number>();
      for (let round = 0; round < 64; round += 1) {
        const claims = (await Promise.all(
          Array.from(
            { length: 5 },
            (_, owner) =>
              queue.claimLiveNormalizationFrontier(
                `mixed-load-owner-${owner}`,
                60,
              ),
          ),
        )).filter((job) => job !== null);
        if (claims.length === 0) break;

        const streamsInRound = new Set<number>();
        for (const job of claims) {
          assert(job.job_kind === "normalize");
          const fact = batchFacts.get(job.batch_id);
          assert(
            fact !== undefined,
            "live owners must not claim unrelated backfill",
          );
          assert(
            !streamsInRound.has(fact.stream),
            "concurrent owners must not overlap within a stream",
          );
          assert(
            fact.offset === (nextOffset.get(fact.stream) ?? 0),
            "each stream must drain in source-offset order",
          );
          assert(
            job.workload_class === (fact.offset === 0 ? "backfill" : "live"),
            "dependency claims must retain every job's original workload class",
          );
          streamsInRound.add(fact.stream);
          nextOffset.set(fact.stream, fact.offset + 1);
        }
        const completions = await Promise.all(
          claims.map((job) => queue.complete(job)),
        );
        assert(
          completions.every((result) => result === "succeeded"),
          "every active mixed-load lease must complete exactly once",
        );
      }
      assert(
        [...nextOffset.values()].every((offset) =>
          offset === rangesPerStream
        ) && nextOffset.size === streamCount,
        "every stream must reach its complete ordered frontier",
      );
      const remaining = await sql.unsafe(
        `select batch_id::text as batch_id, workload_class, status
           from processing.telemetry_jobs
          where workspace_id = $1 and status <> 'succeeded'`,
        [workspaceId],
      );
      assert(
        remaining.length === 1 &&
          remaining[0].batch_id === unrelatedBackfillId &&
          remaining[0].workload_class === "backfill" &&
          remaining[0].status === "queued",
        "the bounded drain must leave only unrelated backfill untouched",
      );
    } finally {
      await deleteQueueFixture(sql, workspaceId);
      await Promise.allSettled([queue.close(), sql.end()]);
    }
  },
});

Deno.test({
  name:
    "blocked GitHub SQL leaves control leases available and closes within the drain window",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 4 });
    const blocker = postgres(databaseUrl!, { prepare: false, max: 1 });
    const controlQueue = PostgresJobQueue.connect(databaseUrl!, 2);
    const githubQueue = PostgresJobQueue.connect(
      databaseUrl!,
      1,
      "sherlock-worker-github-sync",
    );
    let workspaceId: string | null = null;
    let releaseLock: (() => void) | undefined;
    let blockingTransaction: Promise<unknown> | null = null;
    let githubClosed = false;
    try {
      const fixture = await insertQueueFixture(sql, "github-pool-isolation");
      workspaceId = fixture.workspaceId;
      await insertQueueBatch(sql, {
        id: crypto.randomUUID(),
        workspaceId,
        personId: fixture.personId,
        sourceKind: "rollout",
        streamKey: "github-pool-isolation",
        generationKey: "github-pool-isolation",
        startOffset: 0,
        workloadClass: "live",
      });
      assert(
        await controlQueue.tryAcquireHandoff(
          `github-pool-isolation-${workspaceId}`,
        ),
      );
      const claimed = await controlQueue.claim(
        "live",
        "github-pool-isolation",
        120,
      );
      assert(claimed !== null, "the fixture job must be leased");

      let lockAcquired: (() => void) | undefined;
      const lockReady = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });
      const holdLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      blockingTransaction = blocker.begin(async (tx) => {
        await tx.unsafe(
          "lock table telemetry.session_scm in access exclusive mode",
        );
        lockAcquired?.();
        await holdLock;
      });
      await lockReady;

      const syncTask = githubQueue.pendingGithubCommitPairs(1, [workspaceId]);
      let githubWaiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [row] = await sql.unsafe(
          `select count(*)::integer as connections
             from pg_stat_activity
            where application_name = 'sherlock-worker-github-sync'
              and wait_event_type = 'Lock'`,
        );
        if (Number(row.connections) === 1) {
          githubWaiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert(githubWaiting, "the GitHub query must be blocked on its own pool");

      const [githubActivity] = await sql.unsafe(
        `select query
           from pg_stat_activity
          where application_name = 'sherlock-worker-github-sync'
            and wait_event_type = 'Lock'
          limit 1`,
      );
      assert(
        String(githubActivity.query).includes(
          "with recent_sessions as materialized",
        ) && String(githubActivity.query).includes("union"),
        "GitHub sync must materialize recent sessions once and union candidates",
      );
      assert(
        !String(githubActivity.query).includes("or exists"),
        "GitHub sync must not probe historical session events once per SCM fact",
      );

      const labels = await sql.unsafe(
        `select application_name, count(*)::integer as connections
           from pg_stat_activity
          where application_name in (
            'sherlock-worker-control',
            'sherlock-worker-processing',
            'sherlock-worker-github-sync'
          )
          group by application_name`,
      );
      assert(
        labels.some((row) =>
          row.application_name === "sherlock-worker-control" &&
          Number(row.connections) >= 1
        ),
        "the control pool label must remain present",
      );
      assert(
        labels.some((row) =>
          row.application_name === "sherlock-worker-github-sync" &&
          Number(row.connections) === 1
        ),
        "the blocked query must use exactly one dedicated session",
      );
      const [capacity] = await sql.unsafe(ADMISSION_HEADROOM_SQL);
      const labeledConnections = labels.reduce(
        (sum, row) => sum + Number(row.connections),
        0,
      );
      assert(
        Number(capacity.worker_connections) === labeledConnections,
        "admission accounting must include the dedicated GitHub session",
      );

      assert(
        await controlQueue.heartbeat(claimed, 120),
        "a blocked GitHub query must not starve the lease heartbeat",
      );
      assert(
        await controlQueue.complete(claimed) === "succeeded",
        "a blocked GitHub query must not fence control completion",
      );

      const closeStartedAt = performance.now();
      const closedPromptly = await Promise.race([
        Promise.allSettled([githubQueue.close(), syncTask]).then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), 7_000)
        ),
      ]);
      assert(
        closedPromptly && performance.now() - closeStartedAt < 7_000,
        "shutdown must terminate blocked GitHub SQL before Railway drains",
      );
      githubClosed = true;
    } finally {
      releaseLock?.();
      if (blockingTransaction !== null) {
        await blockingTransaction.catch(() => undefined);
      }
      if (!githubClosed) {
        await githubQueue.close().catch(() => undefined);
      }
      await controlQueue.close().catch(() => undefined);
      if (workspaceId !== null) {
        await deleteQueueFixture(sql, workspaceId);
      }
      await blocker.end({ timeout: 1 }).catch(() => undefined);
      await sql.end({ timeout: 1 }).catch(() => undefined);
    }
  },
});
