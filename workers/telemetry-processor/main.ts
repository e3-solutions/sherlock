import {
  type ReductionTarget,
  SupabaseRawStorage,
  TelemetryProcessor,
} from "./processor.ts";
import {
  type JobKind,
  PostgresJobQueue,
  type ReductionEnqueueOptions,
  type TelemetryJob,
  type WorkloadClass,
} from "./queue.ts";
import { syncPending } from "./github-sync.ts";

const OVERLOAD_SAMPLE_MILLISECONDS = 10_000;
const OVERLOAD_SAMPLE_COUNT = 2;
const CAPACITY_RETRY_BASE_MILLISECONDS = 30_000;
const CAPACITY_RETRY_MAX_MILLISECONDS = 120_000;
const HANDOFF_POLL_MILLISECONDS = 1_000;
const GITHUB_BACKLOG_INTERVAL_MILLISECONDS = 60_000;
const GITHUB_CAUGHT_UP_INTERVAL_MILLISECONDS = 300_000;
export const MAX_ADMISSIONS_PER_PASS = 1;

export interface WorkerConfig {
  databaseUrl: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  workerId: string;
  concurrency: number;
  liveReserved: number;
  normalizeReserved: number;
  controlConnections: number;
  processingConnections: number;
  leaseSeconds: number;
  pollMilliseconds: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  storageTimeoutMilliseconds: number;
  processingTimeoutMilliseconds: number;
  reductionTimeoutMilliseconds: number;
  overloadEnterSeconds: number;
  overloadExitSeconds: number;
  handoffKey: string;
  githubToken: string | null;
}

export function loadConfig(
  env: Record<string, string | undefined>,
): WorkerConfig {
  const concurrency = positiveInteger(env.SHERLOCK_WORKER_CONCURRENCY, 6);
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
  const normalizeReserved = positiveInteger(
    env.SHERLOCK_WORKER_NORMALIZE_RESERVED,
    Math.max(1, concurrency - 1),
  );
  if (normalizeReserved >= concurrency) {
    throw new Error(
      "SHERLOCK_WORKER_NORMALIZE_RESERVED must leave one reduction slot",
    );
  }
  const controlConnections = positiveInteger(
    env.SHERLOCK_WORKER_CONTROL_CONNECTIONS,
    4,
  );
  if (controlConnections < 2) {
    throw new Error(
      "SHERLOCK_WORKER_CONTROL_CONNECTIONS must include handoff and queue capacity",
    );
  }
  const processingConnections = positiveInteger(
    env.SHERLOCK_WORKER_PROCESSING_CONNECTIONS,
    6,
  );
  if (processingConnections < concurrency) {
    throw new Error(
      "SHERLOCK_WORKER_PROCESSING_CONNECTIONS must cover worker concurrency",
    );
  }
  const overloadEnterSeconds = positiveInteger(
    env.SHERLOCK_WORKER_OVERLOAD_ENTER_SECONDS,
    120,
  );
  const overloadExitSeconds = positiveInteger(
    env.SHERLOCK_WORKER_OVERLOAD_EXIT_SECONDS,
    60,
  );
  if (overloadExitSeconds >= overloadEnterSeconds) {
    throw new Error(
      "SHERLOCK_WORKER_OVERLOAD_EXIT_SECONDS must be below the enter threshold",
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
    normalizeReserved,
    controlConnections,
    processingConnections,
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
    processingTimeoutMilliseconds: positiveInteger(
      env.SHERLOCK_WORKER_PROCESSING_TIMEOUT_SECONDS,
      90,
    ) * 1_000,
    reductionTimeoutMilliseconds: positiveInteger(
      env.SHERLOCK_WORKER_REDUCTION_TIMEOUT_SECONDS,
      60,
    ) * 1_000,
    overloadEnterSeconds,
    overloadExitSeconds,
    handoffKey: JSON.stringify([
      "sherlock-telemetry-processor",
      env.RAILWAY_ENVIRONMENT_ID ?? "local",
      env.RAILWAY_SERVICE_ID ?? "local",
    ]),
    githubToken: env.GITHUB_TOKEN?.trim() || null,
  };
}

export interface OverloadState {
  active: boolean;
  enterSamples: number;
  exitSamples: number;
}

export function updateOverloadState(
  state: OverloadState,
  oldestLiveNormalizeSeconds: number | null,
  config: Pick<WorkerConfig, "overloadEnterSeconds" | "overloadExitSeconds">,
): OverloadState {
  if (!state.active) {
    const enterSamples = oldestLiveNormalizeSeconds !== null &&
        oldestLiveNormalizeSeconds >= config.overloadEnterSeconds
      ? state.enterSamples + 1
      : 0;
    return {
      active: enterSamples >= OVERLOAD_SAMPLE_COUNT,
      enterSamples,
      exitSamples: 0,
    };
  }
  const exitSamples = oldestLiveNormalizeSeconds === null ||
      oldestLiveNormalizeSeconds <= config.overloadExitSeconds
    ? state.exitSamples + 1
    : 0;
  return {
    active: exitSamples < OVERLOAD_SAMPLE_COUNT,
    enterSamples: 0,
    exitSamples,
  };
}

export function chooseOverloadJobKind(
  activeNormalize: number,
  activeReduce: number,
  normalizeReserved: number,
): JobKind {
  if (activeNormalize < normalizeReserved) return "normalize";
  if (activeReduce < 1) return "reduce";
  return "normalize";
}

export function admissionAvailable(
  admissions: number,
  active: number,
  concurrency: number,
): boolean {
  return admissions < MAX_ADMISSIONS_PER_PASS && active < concurrency;
}

export function maintenanceSampleDue(
  now: number,
  lastSampleAt: number,
): boolean {
  return now - lastSampleAt >= OVERLOAD_SAMPLE_MILLISECONDS;
}

export function isCapacityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  if (code === "53300" || code.startsWith("EMAX")) return true;
  return code === "XX000" && /\bEMAX(?:CONNSESSION)?\b/i.test(error.message);
}

export function capacityRetryMilliseconds(
  failureCount: number,
  random: () => number = Math.random,
): number {
  const capped = Math.min(
    CAPACITY_RETRY_MAX_MILLISECONDS,
    CAPACITY_RETRY_BASE_MILLISECONDS *
      2 ** Math.min(2, Math.max(0, failureCount - 1)),
  );
  return Math.round(capped * (0.8 + 0.4 * random()));
}

export class CapacityCircuit {
  private failures = 0;
  private openUntilMs = 0;
  private probeInFlight = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  handle(error: unknown): number | null {
    if (!isCapacityError(error)) return null;
    this.failures += 1;
    this.probeInFlight = false;
    const delayMilliseconds = capacityRetryMilliseconds(
      this.failures,
      this.random,
    );
    this.openUntilMs = Math.max(
      this.openUntilMs,
      this.now() + delayMilliseconds,
    );
    return delayMilliseconds;
  }

  millisecondsUntilReady(): number {
    return Math.max(0, this.openUntilMs - this.now());
  }

  isHalfOpen(): boolean {
    return this.failures > 0 && !this.probeInFlight &&
      this.millisecondsUntilReady() === 0;
  }

  beginProbe(): boolean {
    if (!this.isHalfOpen()) return false;
    this.probeInFlight = true;
    return true;
  }

  hasProbeInFlight(): boolean {
    return this.probeInFlight;
  }

  completeProbe(): boolean {
    if (!this.probeInFlight) return false;
    this.close();
    return true;
  }

  close(): void {
    this.failures = 0;
    this.openUntilMs = 0;
    this.probeInFlight = false;
  }
}

export function workerConnectionBudget(
  config: Pick<WorkerConfig, "controlConnections" | "processingConnections">,
  state: "handoff_wait" | "active",
): number {
  return state === "handoff_wait"
    ? 1
    : config.controlConnections + config.processingConnections;
}

export function handoffOverlapConnectionBudget(
  config: Pick<WorkerConfig, "controlConnections" | "processingConnections">,
): number {
  return workerConnectionBudget(config, "active") +
    workerConnectionBudget(config, "handoff_wait");
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
    config.controlConnections,
  );
  let processor: TelemetryProcessor | null = null;
  const active = new Map<
    Promise<void>,
    Pick<TelemetryJob, "job_kind" | "workload_class">
  >();
  let stopping = false;
  let githubTask: Promise<void> | null = null;
  let nextGithubSyncAt = 0;
  let githubRateLimitAttempts = 0;
  let githubAuthRejected = false;
  const shutdown = new AbortController();
  let lastReaperAt = 0;
  let lastOverloadSampleAt = 0;
  let overload: OverloadState = {
    active: false,
    enterSamples: 0,
    exitSamples: 0,
  };
  const capacityCircuit = new CapacityCircuit();
  const stop = () => {
    stopping = true;
    shutdown.abort();
    log("shutdown_requested", { active_jobs: active.size });
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
  const openCapacityCircuit = (error: unknown, source: string): boolean => {
    const delayMilliseconds = capacityCircuit.handle(error);
    if (delayMilliseconds === null) return false;
    log("database_capacity_circuit_open", {
      source,
      error_code: errorCode(error),
      retry_in_ms: delayMilliseconds,
    });
    return true;
  };
  try {
    let waitingLogged = false;
    while (!stopping) {
      try {
        if (await queue.tryAcquireHandoff(config.handoffKey)) break;
        if (!waitingLogged) {
          log("worker_handoff_waiting", { worker_id: config.workerId });
          waitingLogged = true;
        }
        await delay(HANDOFF_POLL_MILLISECONDS);
      } catch (error) {
        if (!openCapacityCircuit(error, "handoff")) throw error;
        await delay(Math.max(1, capacityCircuit.millisecondsUntilReady()));
      }
    }
    if (stopping) return;
    processor = new TelemetryProcessor(
      config.databaseUrl,
      new SupabaseRawStorage(
        config.supabaseUrl,
        config.serviceRoleKey,
        config.storageTimeoutMilliseconds,
      ),
      config.processingConnections,
    );
    log("worker_started", {
      worker_id: config.workerId,
      concurrency: config.concurrency,
      live_reserved: config.liveReserved,
      normalize_reserved: config.normalizeReserved,
      control_connections: config.controlConnections,
      processing_connections: config.processingConnections,
      lease_seconds: config.leaseSeconds,
      github_sync_enabled: config.githubToken !== null,
    });
    while (!stopping) {
      if (capacityCircuit.millisecondsUntilReady() > 0) {
        await waitForWork(
          active,
          Math.min(
            config.pollMilliseconds,
            capacityCircuit.millisecondsUntilReady(),
          ),
        );
        continue;
      }
      if (capacityCircuit.hasProbeInFlight()) {
        await waitForWork(active, config.pollMilliseconds);
        continue;
      }
      if (
        config.githubToken && !githubAuthRejected && githubTask === null &&
        Date.now() >= nextGithubSyncAt
      ) {
        nextGithubSyncAt = Date.now() + GITHUB_BACKLOG_INTERVAL_MILLISECONDS;
        githubTask = syncPending(queue, config.githubToken, {
          signal: shutdown.signal,
          onError: (error, pair) =>
            log("github_sync_lookup_failed", {
              workspace_id: pair.workspaceId,
              repository: pair.repositoryFullName,
              error_code: errorCode(error),
            }),
        }).then((result) => {
          const pause = result.pause;
          if (pause?.status === 401) {
            githubAuthRejected = true;
            log("github_sync_paused", {
              http_status: pause.status,
              retry_source: pause.retrySource,
            });
          } else if (pause) {
            githubRateLimitAttempts += 1;
            const now = Date.now();
            const fallbackDelay = retryDelaySeconds(
              githubRateLimitAttempts,
              60,
              900,
            ) * 1_000;
            nextGithubSyncAt = Math.max(
              nextGithubSyncAt,
              pause.retryAtMs ?? now + fallbackDelay,
            );
            log("github_sync_paused", {
              http_status: pause.status,
              retry_source: pause.retrySource,
              retry_in_ms: Math.max(0, nextGithubSyncAt - now),
            });
          } else {
            githubRateLimitAttempts = 0;
            nextGithubSyncAt = Date.now() +
              (result.backlogRemaining
                ? GITHUB_BACKLOG_INTERVAL_MILLISECONDS
                : GITHUB_CAUGHT_UP_INTERVAL_MILLISECONDS);
          }
          log("github_sync_complete", { ...result });
        }).catch(
          (error) => {
            if (!shutdown.signal.aborted) {
              log("github_sync_failed", { error_code: errorCode(error) });
            }
          },
        ).finally(() => {
          githubTask = null;
        });
      }
      const halfOpen = capacityCircuit.isHalfOpen();
      let claimedAny = false;
      try {
        if (maintenanceSampleDue(Date.now(), lastReaperAt)) {
          const terminalized = await queue.terminalizeExpired();
          if (terminalized > 0) log("expired_jobs_failed", { terminalized });
          lastReaperAt = Date.now();
        }
        if (maintenanceSampleDue(Date.now(), lastOverloadSampleAt)) {
          const age = await queue.oldestLiveNormalizationAgeSeconds();
          const previous = overload.active;
          overload = updateOverloadState(overload, age, config);
          if (previous !== overload.active) {
            log(
              overload.active
                ? "worker_overload_entered"
                : "worker_overload_exited",
              {
                oldest_live_normalize_seconds: age,
              },
            );
          }
          lastOverloadSampleAt = Date.now();
        }
        let admissions = 0;
        while (
          !stopping &&
          admissionAvailable(admissions, active.size, config.concurrency)
        ) {
          const job = overload.active
            ? await claimOverloadJob(queue, active, config)
            : await claimNormalJob(queue, active, config);
          if (!job) break;
          admissions += 1;
          claimedAny = true;
          const task = runJob(
            queue,
            processor,
            job,
            config,
            (error, source) => openCapacityCircuit(error, source),
          ).catch((error) => {
            log("job_task_failed", {
              ...jobFields(job),
              error_code: errorCode(error),
            });
          }).finally(() => {
            active.delete(task);
            if (halfOpen && capacityCircuit.completeProbe()) {
              log("database_capacity_circuit_closed", {
                probe_job_id: job.id.toString(),
              });
            }
          });
          active.set(task, {
            job_kind: job.job_kind,
            workload_class: job.workload_class,
          });
          if (halfOpen) {
            if (!capacityCircuit.beginProbe()) {
              throw new Error("capacity circuit admitted multiple probes");
            }
            log("database_capacity_circuit_half_open", {
              probe_job_id: job.id.toString(),
            });
            break;
          }
        }
        if (halfOpen && !claimedAny) {
          capacityCircuit.close();
          log("database_capacity_circuit_closed", {});
        }
      } catch (error) {
        if (!openCapacityCircuit(error, "queue_control")) throw error;
      }
      await waitForWork(
        active,
        claimedAny ? 1 : config.pollMilliseconds,
      );
    }
    await Promise.allSettled(active.keys());
  } finally {
    shutdown.abort();
    if (githubTask) await githubTask;
    Deno.removeSignalListener("SIGTERM", stop);
    Deno.removeSignalListener("SIGINT", stop);
    if (processor !== null) await processor.close().catch(() => undefined);
    await queue.close().catch(() => undefined);
    log("worker_stopped", {});
  }
}

async function claimNormalJob(
  queue: PostgresJobQueue,
  active: Map<Promise<void>, Pick<TelemetryJob, "job_kind" | "workload_class">>,
  config: WorkerConfig,
): Promise<TelemetryJob | null> {
  const activeLive =
    [...active.values()].filter((job) => job.workload_class === "live").length;
  const activeBackfill = active.size - activeLive;
  const preferred = chooseLane(activeLive, activeBackfill, config);
  const preferredJob = await queue.claim(
    preferred,
    config.workerId,
    config.leaseSeconds,
  );
  if (preferredJob) return preferredJob;
  const alternate = alternateLane(preferred, activeBackfill, config);
  return alternate
    ? await queue.claim(
      alternate,
      config.workerId,
      config.leaseSeconds,
    )
    : null;
}

export async function claimOverloadJob(
  queue: PostgresJobQueue,
  active: Map<Promise<void>, Pick<TelemetryJob, "job_kind" | "workload_class">>,
  config: WorkerConfig,
): Promise<TelemetryJob | null> {
  const jobs = [...active.values()];
  const activeNormalize =
    jobs.filter((job) => job.job_kind === "normalize").length;
  const activeReduce = jobs.length - activeNormalize;
  const preferred = chooseOverloadJobKind(
    activeNormalize,
    activeReduce,
    config.normalizeReserved,
  );
  const claim = (jobKind: JobKind): Promise<TelemetryJob | null> =>
    jobKind === "normalize"
      ? queue.claimLiveNormalizationFrontier(
        config.workerId,
        config.leaseSeconds,
      )
      : queue.claim(
        "live",
        config.workerId,
        config.leaseSeconds,
        "reduce",
      );
  const preferredJob = await claim(preferred);
  if (preferredJob) return preferredJob;
  return await claim(preferred === "normalize" ? "reduce" : "normalize");
}

async function waitForWork(
  active: Map<Promise<void>, unknown>,
  milliseconds: number,
): Promise<void> {
  if (active.size === 0) {
    await delay(Math.max(1, milliseconds));
    return;
  }
  await Promise.race([
    ...active.keys(),
    delay(Math.max(1, milliseconds)),
  ]);
}

async function runJob(
  queue: PostgresJobQueue,
  processor: TelemetryProcessor,
  job: TelemetryJob,
  config: WorkerConfig,
  onCapacityError: (error: unknown, source: string) => void,
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
      if (isCapacityError(error)) {
        onCapacityError(error, "lease_heartbeat");
      }
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
      ? await normalizeAndEnqueue(
        queue,
        processor,
        job,
        config.processingTimeoutMilliseconds,
      )
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
    if (isCapacityError(error)) onCapacityError(error, "job_processing");
    const code = errorCode(error);
    const message = safeError(error);
    const terminal = job.attempt_count >= job.attempt_limit;
    let changed = false;
    try {
      changed = terminal
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
    } catch (recordError) {
      if (isCapacityError(recordError)) {
        onCapacityError(recordError, "job_failure_record");
      }
      log("job_failure_record_deferred", {
        ...jobFields(job),
        error_code: errorCode(recordError),
      });
      return;
    }
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

async function normalizeAndEnqueue(
  queue: PostgresJobQueue,
  processor: TelemetryProcessor,
  job: Extract<TelemetryJob, { job_kind: "normalize" }>,
  maximumDurationMs: number,
): Promise<{
  session_count: number;
  candidate_count: number;
  inserted_count: number;
  tombstone_count: number;
}> {
  const targets = await processor.normalize(job, maximumDurationMs);
  await enqueueReductionTargets(queue, targets);
  return {
    session_count: targets.length,
    candidate_count: 0,
    inserted_count: 0,
    tombstone_count: 0,
  };
}

export async function enqueueReductionTargets(
  queue: Pick<PostgresJobQueue, "enqueueReductions">,
  targets: readonly ReductionTarget[],
): Promise<void> {
  await queue.enqueueReductions(
    targets.map((target): ReductionEnqueueOptions => ({
      workspaceId: target.workspace_id,
      sessionId: target.session_id,
      normalizerVersion: target.normalizer_version,
      activityVersion: target.activity_version,
      targetEventId: target.target_event_id,
      workloadClass: target.workload_class,
    })),
  );
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
