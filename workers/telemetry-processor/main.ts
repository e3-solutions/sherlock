import { SupabaseRawStorage, TelemetryProcessor } from "./processor.ts";
import {
  PostgresJobQueue,
  type TelemetryJob,
  type WorkloadClass,
} from "./queue.ts";

export interface WorkerConfig {
  databaseUrl: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  workerId: string;
  concurrency: number;
  liveReserved: number;
  leaseSeconds: number;
  pollMilliseconds: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  storageTimeoutMilliseconds: number;
  reductionTimeoutMilliseconds: number;
}

export function loadConfig(
  env: Record<string, string | undefined>,
): WorkerConfig {
  const concurrency = positiveInteger(env.SHERLOCK_WORKER_CONCURRENCY, 4);
  if (concurrency < 2) {
    throw new Error("SHERLOCK_WORKER_CONCURRENCY must be at least 2");
  }
  const liveReserved = positiveInteger(
    env.SHERLOCK_WORKER_LIVE_RESERVED,
    Math.max(1, concurrency - 1),
  );
  if (liveReserved >= concurrency) {
    throw new Error(
      "SHERLOCK_WORKER_LIVE_RESERVED must leave one backfill slot",
    );
  }
  const supabaseUrl = required(env, "SUPABASE_URL").replace(/\/$/, "");
  if (!supabaseUrl.startsWith("https://")) {
    throw new Error("SUPABASE_URL must use HTTPS");
  }
  return {
    databaseUrl: required(env, "SUPABASE_DB_URL"),
    supabaseUrl,
    serviceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    workerId: env.RAILWAY_REPLICA_ID ?? `local-${crypto.randomUUID()}`,
    concurrency,
    liveReserved,
    leaseSeconds: positiveInteger(env.SHERLOCK_WORKER_LEASE_SECONDS, 120),
    pollMilliseconds: positiveInteger(env.SHERLOCK_WORKER_POLL_MS, 250),
    retryBaseSeconds: positiveInteger(
      env.SHERLOCK_WORKER_RETRY_BASE_SECONDS,
      5,
    ),
    retryMaxSeconds: positiveInteger(
      env.SHERLOCK_WORKER_RETRY_MAX_SECONDS,
      300,
    ),
    storageTimeoutMilliseconds: positiveInteger(
      env.SHERLOCK_WORKER_STORAGE_TIMEOUT_SECONDS,
      30,
    ) * 1_000,
    reductionTimeoutMilliseconds: positiveInteger(
      env.SHERLOCK_WORKER_REDUCTION_TIMEOUT_SECONDS,
      60,
    ) * 1_000,
  };
}

export function chooseLane(
  activeLive: number,
  activeBackfill: number,
  config: Pick<WorkerConfig, "concurrency" | "liveReserved">,
): WorkloadClass {
  if (activeLive < config.liveReserved) return "live";
  const backfillReserved = config.concurrency - config.liveReserved;
  if (activeBackfill < backfillReserved) return "backfill";
  return "live";
}

export function alternateLane(
  preferred: WorkloadClass,
  activeBackfill: number,
  config: Pick<WorkerConfig, "concurrency" | "liveReserved">,
): WorkloadClass | null {
  if (preferred === "backfill") return "live";
  const backfillReserved = config.concurrency - config.liveReserved;
  return activeBackfill < backfillReserved ? "backfill" : null;
}

export function retryDelaySeconds(
  attempt: number,
  baseSeconds: number,
  maximumSeconds: number,
): number {
  return Math.min(maximumSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));
}

export async function runWorker(config: WorkerConfig): Promise<void> {
  const queue = PostgresJobQueue.connect(
    config.databaseUrl,
    config.concurrency + 2,
  );
  const processor = new TelemetryProcessor(
    config.databaseUrl,
    new SupabaseRawStorage(
      config.supabaseUrl,
      config.serviceRoleKey,
      config.storageTimeoutMilliseconds,
    ),
  );
  const active = new Map<Promise<void>, WorkloadClass>();
  let stopping = false;
  let lastReaperAt = 0;
  const stop = () => {
    stopping = true;
    log("shutdown_requested", { active_jobs: active.size });
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
  log("worker_started", {
    worker_id: config.workerId,
    concurrency: config.concurrency,
    live_reserved: config.liveReserved,
    lease_seconds: config.leaseSeconds,
  });
  try {
    while (!stopping) {
      if (Date.now() - lastReaperAt >= 10_000) {
        const terminalized = await queue.terminalizeExpired();
        if (terminalized > 0) log("expired_jobs_failed", { terminalized });
        lastReaperAt = Date.now();
      }
      let claimedAny = false;
      while (!stopping && active.size < config.concurrency) {
        const activeLive = [...active.values()].filter((lane) =>
          lane === "live"
        )
          .length;
        const activeBackfill = active.size - activeLive;
        const preferred = chooseLane(activeLive, activeBackfill, config);
        let job = await queue.claim(
          preferred,
          config.workerId,
          config.leaseSeconds,
        );
        if (!job) {
          const alternate = alternateLane(
            preferred,
            activeBackfill,
            config,
          );
          if (alternate) {
            job = await queue.claim(
              alternate,
              config.workerId,
              config.leaseSeconds,
            );
          }
        }
        if (!job) break;
        claimedAny = true;
        const task = runJob(queue, processor, job, config).finally(() => {
          active.delete(task);
        });
        active.set(task, job.workload_class);
      }
      if (active.size > 0) {
        await Promise.race([
          ...active.keys(),
          delay(claimedAny ? 1 : config.pollMilliseconds),
        ]);
      } else {
        await delay(config.pollMilliseconds);
      }
    }
    await Promise.allSettled(active.keys());
  } finally {
    Deno.removeSignalListener("SIGTERM", stop);
    Deno.removeSignalListener("SIGINT", stop);
    await Promise.allSettled([processor.close(), queue.close()]);
    log("worker_stopped", {});
  }
}

async function runJob(
  queue: PostgresJobQueue,
  processor: TelemetryProcessor,
  job: TelemetryJob,
  config: WorkerConfig,
): Promise<void> {
  const startedAt = performance.now();
  let leaseLost = false;
  let extending = false;
  const interval = setInterval(async () => {
    if (extending || leaseLost) return;
    extending = true;
    try {
      leaseLost = !(await queue.heartbeat(job, config.leaseSeconds));
    } catch (error) {
      log("lease_heartbeat_failed", {
        ...jobFields(job),
        error_code: errorCode(error),
      });
    } finally {
      extending = false;
    }
  }, Math.max(1_000, Math.floor(config.leaseSeconds * 1_000 / 3)));
  log("job_started", jobFields(job));
  try {
    const result = job.job_kind === "normalize"
      ? await normalizeAndEnqueue(queue, processor, job)
      : await processor.reduce(job, config.reductionTimeoutMilliseconds);
    const completion = leaseLost ? "fenced" : await queue.complete(job);
    if (completion === "fenced") {
      log("job_completion_fenced", jobFields(job));
      return;
    }
    log(completion === "requeued" ? "job_dirty_requeued" : "job_succeeded", {
      ...jobFields(job),
      ...result,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    const code = errorCode(error);
    const message = safeError(error);
    const terminal = job.attempt_count >= job.attempt_limit;
    const changed = terminal
      ? await queue.fail(job, code, message)
      : await queue.retry(
        job,
        retryDelaySeconds(
          job.attempt_count,
          config.retryBaseSeconds,
          config.retryMaxSeconds,
        ),
        code,
        message,
      );
    log(
      changed
        ? (terminal ? "job_failed" : "job_retry_scheduled")
        : "job_failure_fenced",
      {
        ...jobFields(job),
        error_code: code,
        duration_ms: Math.round(performance.now() - startedAt),
      },
    );
  } finally {
    clearInterval(interval);
  }
}

export async function normalizeAndEnqueue(
  queue: Pick<PostgresJobQueue, "enqueueReductions">,
  processor: Pick<TelemetryProcessor, "normalize">,
  job: Extract<TelemetryJob, { job_kind: "normalize" }>,
): Promise<{
  session_count: number;
  candidate_count: number;
  inserted_count: number;
  tombstone_count: number;
}> {
  const targets = await processor.normalize(job);
  await queue.enqueueReductions(
    targets.map((target) => ({
      workspaceId: target.workspace_id,
      sessionId: target.session_id,
      normalizerVersion: target.normalizer_version,
      activityVersion: target.activity_version,
      targetEventId: target.target_event_id,
      workloadClass: target.workload_class,
    })),
  );
  return {
    session_count: targets.length,
    candidate_count: 0,
    inserted_count: 0,
    tombstone_count: 0,
  };
}

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("worker numeric settings must be positive integers");
  }
  return parsed;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    return String(error.code).slice(0, 128);
  }
  return "processing_failed";
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "processing failed")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]")
    .slice(0, 1024);
}

function jobFields(job: TelemetryJob): Record<string, unknown> {
  return {
    job_id: job.id.toString(),
    job_kind: job.job_kind,
    ...(job.job_kind === "normalize" ? { batch_id: job.batch_id } : {
      session_id: job.session_id,
      target_event_id: job.target_event_id.toString(),
      request_generation: job.request_generation.toString(),
    }),
    workload_class: job.workload_class,
    attempt: job.attempt_count,
  };
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  }));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (import.meta.main) {
  await runWorker(loadConfig(Deno.env.toObject()));
}
