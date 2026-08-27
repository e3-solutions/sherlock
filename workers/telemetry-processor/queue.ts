import { createPostgresPool, type ReservedSql, type Sql } from "./database.ts";
import type { CommitPair, LookupResult } from "./github-sync.ts";

export type WorkloadClass = "live" | "backfill";
export type JobKind = "normalize" | "reduce";

interface BaseJob {
  id: bigint;
  workspace_id: string;
  workload_class: WorkloadClass;
  attempt_count: number;
  attempt_limit: number;
  lease_token: string;
}

export interface NormalizationJob extends BaseJob {
  job_kind: "normalize";
  batch_id: string;
  normalizer_version: string | null;
}

export interface ReductionJob extends BaseJob {
  job_kind: "reduce";
  session_id: string;
  normalizer_version: string;
  activity_version: string;
  target_event_id: bigint;
  request_generation: bigint;
}

export type TelemetryJob = NormalizationJob | ReductionJob;
export type CompletionResult = "succeeded" | "requeued" | "fenced";

export interface DatabaseConnectionCapacity {
  max_connections: number;
  superuser_reserved_connections: number;
  reserved_connections: number;
  client_connections: number;
  worker_connections: number;
  dashboard_connections: number;
}

export const ADMISSION_HEADROOM_SQL = `
select current_setting('max_connections')::integer as max_connections,
       current_setting('superuser_reserved_connections')::integer
         as superuser_reserved_connections,
       coalesce(
         nullif(current_setting('reserved_connections', true), ''),
         '0'
       )::integer as reserved_connections,
       count(*)::integer as client_connections,
       count(*) filter (
         where application_name in (
           'sherlock-worker-control',
           'sherlock-worker-processing'
         )
       )::integer as worker_connections,
       count(*) filter (
         where application_name like 'sherlock-dashboard:%'
       )::integer as dashboard_connections
from pg_stat_activity
where backend_type = 'client backend'
`;

export function admissionHeadroomAvailable(
  capacity: DatabaseConnectionCapacity,
  dashboardReservedConnections: number,
  workerConnectionBudget: number,
): boolean {
  const usableConnections = capacity.max_connections -
    capacity.superuser_reserved_connections - capacity.reserved_connections;
  const unopenedWorkerConnections = Math.max(
    0,
    workerConnectionBudget - capacity.worker_connections,
  );
  const missingDashboardConnections = Math.max(
    0,
    dashboardReservedConnections - capacity.dashboard_connections,
  );
  return usableConnections - capacity.client_connections -
      unopenedWorkerConnections >= missingDashboardConnections;
}

export interface ReductionEnqueueOptions {
  workspaceId: string;
  sessionId: string;
  normalizerVersion: string;
  activityVersion: string;
  targetEventId: bigint;
  workloadClass: WorkloadClass;
}

export function coalesceReductionTargets(
  options: readonly ReductionEnqueueOptions[],
): ReductionEnqueueOptions[] {
  const targets = new Map<string, ReductionEnqueueOptions>();
  for (const option of options) {
    if (option.targetEventId <= 0n) continue;
    const key = JSON.stringify([
      option.workspaceId,
      option.sessionId,
      option.normalizerVersion,
      option.activityVersion,
    ]);
    const existing = targets.get(key);
    if (existing === undefined) {
      targets.set(key, option);
      continue;
    }
    targets.set(key, {
      ...existing,
      targetEventId: existing.targetEventId > option.targetEventId
        ? existing.targetEventId
        : option.targetEventId,
      workloadClass: existing.workloadClass === "live" ||
          option.workloadClass === "live"
        ? "live"
        : "backfill",
    });
  }
  return [...targets.values()].sort((left, right) =>
    compareText(left.workspaceId, right.workspaceId) ||
    compareText(left.sessionId, right.sessionId) ||
    compareText(left.normalizerVersion, right.normalizerVersion) ||
    compareText(left.activityVersion, right.activityVersion)
  );
}

export class PostgresJobQueue {
  private handoffConnection: ReservedSql | null = null;

  private constructor(private readonly sql: Sql) {}

  static connect(
    databaseUrl: string,
    maxConnections: number,
  ): PostgresJobQueue {
    return new PostgresJobQueue(
      createPostgresPool(
        databaseUrl,
        maxConnections,
        "sherlock-worker-control",
      ),
    );
  }

  async close(): Promise<void> {
    await this.releaseHandoff();
    await this.sql.end({ timeout: 5 });
  }

  async tryAcquireHandoff(lockKey: string): Promise<boolean> {
    if (this.handoffConnection !== null) return true;
    const connection = await this.sql.reserve();
    try {
      const rows = await connection.unsafe(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired",
        [lockKey],
      );
      if (rows[0]?.acquired !== true) return false;
      this.handoffConnection = connection;
      return true;
    } finally {
      if (this.handoffConnection !== connection) connection.release();
    }
  }

  async releaseHandoff(): Promise<void> {
    const connection = this.handoffConnection;
    if (connection === null) return;
    this.handoffConnection = null;
    try {
      await connection.unsafe("select pg_advisory_unlock_all()");
    } finally {
      connection.release();
    }
  }

  async hasAdmissionHeadroom(
    dashboardReservedConnections: number,
    workerConnectionBudget: number,
  ): Promise<boolean> {
    if (this.handoffConnection === null) {
      throw new Error("database headroom requires the active handoff session");
    }
    const rows = await this.handoffConnection.unsafe(ADMISSION_HEADROOM_SQL);
    if (rows.length !== 1) return false;
    const row = rows[0];
    return admissionHeadroomAvailable(
      {
        max_connections: Number(row.max_connections),
        superuser_reserved_connections: Number(
          row.superuser_reserved_connections,
        ),
        reserved_connections: Number(row.reserved_connections),
        client_connections: Number(row.client_connections),
        worker_connections: Number(row.worker_connections),
        dashboard_connections: Number(row.dashboard_connections),
      },
      dashboardReservedConnections,
      workerConnectionBudget,
    );
  }

  async pendingGithubCommitPairs(
    limit: number,
    workspaceIds: readonly string[],
  ): Promise<CommitPair[]> {
    return await this.sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_processor");
      const rows = await tx.unsafe(
        `with observed as (
           select distinct scm.workspace_id, scm.repository_full_name,
                  scm.commit_sha
             from telemetry.session_scm scm
            where scm.source_version = 'sherlock.github-scm.v1'
              and scm.workspace_id = any($2::uuid[])
              and (
                scm.created_at >= now() - interval '26 hours'
                or exists (
                  select 1
                    from telemetry.events recent
                   where recent.workspace_id = scm.workspace_id
                     and recent.session_id = scm.session_id
                     and recent.server_received_at >=
                       now() - interval '26 hours'
                     and not recent.is_replay
                )
              )
         )
         select observed.*
           from observed
           left join lateral (
             select id, outcome, pull_request_terminal_at, created_at
               from github.commit_pr_lookups
              where workspace_id = observed.workspace_id
                and source_version = 'sherlock.github-associated-pulls.v1'
                and repository_full_name = observed.repository_full_name
                and commit_sha = observed.commit_sha
              order by id desc
              limit 1
           ) latest on true
          where latest.id is null or latest.created_at < now() - case
            when latest.outcome = 'matched' and
                 latest.pull_request_terminal_at is not null
              then interval '6 hours'
            else interval '10 minutes'
          end
          order by (latest.id is not null), latest.id,
                   observed.workspace_id, observed.repository_full_name,
                   observed.commit_sha
          limit $1`,
        [limit, workspaceIds],
      );
      return rows.map((row) => ({
        workspaceId: String(row.workspace_id),
        repositoryFullName: String(row.repository_full_name),
        commitSha: String(row.commit_sha),
      }));
    });
  }

  async appendGithubLookup(result: LookupResult): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_processor");
      await tx.unsafe(
        `insert into github.commit_pr_lookups (
           workspace_id, source_version, repository_full_name, commit_sha,
           outcome, pull_request_number, pull_request_terminal_at
         ) values ($1, 'sherlock.github-associated-pulls.v1', $2, $3, $4, $5, $6)`,
        [
          result.workspaceId,
          result.repositoryFullName,
          result.commitSha,
          result.outcome,
          result.pullRequestNumber,
          result.pullRequestTerminalAt,
        ],
      );
    });
  }

  async claim(
    workloadClass: WorkloadClass,
    owner: string,
    leaseSeconds: number,
    jobKind: JobKind | null = null,
  ): Promise<TelemetryJob | null> {
    return await this.claimMatching(
      workloadClass,
      owner,
      leaseSeconds,
      jobKind,
      false,
    );
  }

  async claimLiveNormalizationFrontier(
    owner: string,
    leaseSeconds: number,
  ): Promise<TelemetryJob | null> {
    return await this.claimMatching(
      "live",
      owner,
      leaseSeconds,
      "normalize",
      true,
    );
  }

  private async claimMatching(
    workloadClass: WorkloadClass,
    owner: string,
    leaseSeconds: number,
    jobKind: JobKind | null,
    liveNormalizationFrontier: boolean,
  ): Promise<TelemetryJob | null> {
    const liveDemandProjection = liveNormalizationFrontier
      ? `,
                  min(pending_job.created_at) filter (
                    where pending_job.workload_class = 'live'
                      and pending_job.attempt_count < pending_job.attempt_limit
                      and (
                        (pending_job.status = 'queued'
                          and pending_job.available_at <= now()) or
                        (pending_job.status = 'leased'
                          and pending_job.lease_expires_at <= now())
                      )
                  ) over (
                    partition by pending_batch.workspace_id,
                                 pending_batch.collector_key,
                                 pending_batch.source_kind,
                                 pending_batch.source_stream_key,
                                 pending_batch.generation_seq,
                                 pending_batch.generation_key
                  ) as oldest_ready_live_created_at`
      : "";
    const workloadPredicate = liveNormalizationFrontier
      ? "$1::text = 'live' and pending.oldest_ready_live_created_at is not null"
      : "j.workload_class = $1";
    const liveDemandOrder = liveNormalizationFrontier
      ? "pending.oldest_ready_live_created_at,"
      : "";
    return await this.sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_processor");
      const rows = await tx.unsafe(
        `with pending_normalize as (
           select pending_job.id,
                  min(pending_batch.start_offset) over (
                    partition by pending_batch.workspace_id,
                                 pending_batch.collector_key,
                                 pending_batch.source_kind,
                                 pending_batch.source_stream_key,
                                 pending_batch.generation_seq,
                                 pending_batch.generation_key
                  ) as earliest_start${liveDemandProjection}
             from processing.telemetry_jobs pending_job
             join telemetry.ingest_batches pending_batch
               on pending_batch.workspace_id = pending_job.workspace_id
              and pending_batch.id = pending_job.batch_id
            where pending_job.job_kind = 'normalize'
              and pending_job.status in ('queued', 'leased')
         ), candidate as (
           select j.id
             from processing.telemetry_jobs j
             left join telemetry.ingest_batches batch
               on j.job_kind = 'normalize'
              and batch.workspace_id = j.workspace_id
              and batch.id = j.batch_id
             left join pending_normalize pending
               on pending.id = j.id
            where ${workloadPredicate}
              and ($4::text is null or j.job_kind = $4)
              and j.attempt_count < j.attempt_limit
              and (
                (j.status = 'queued' and j.available_at <= now()) or
                (j.status = 'leased' and j.lease_expires_at <= now())
              )
              and (
                j.job_kind <> 'normalize' or batch.id is null
                or batch.start_offset = pending.earliest_start
              )
            order by ${liveDemandOrder}
                     case when j.status = 'queued' then j.available_at
                          else j.lease_expires_at end,
                     j.id
            for update of j skip locked
            limit 1
         )
         update processing.telemetry_jobs j
            set status = 'leased',
                attempt_count = j.attempt_count + 1,
                lease_token = gen_random_uuid(),
                lease_owner = $2,
                lease_started_at = now(),
                lease_expires_at = now() + make_interval(secs => $3),
                completed_at = null,
                updated_at = now()
           from candidate
          where j.id = candidate.id
        returning j.id::text as id, j.workspace_id::text as workspace_id,
                  j.job_kind, j.batch_id::text as batch_id,
                  j.session_id::text as session_id, j.normalizer_version,
                  j.activity_version, j.target_event_id::text as target_event_id,
                  j.request_generation::text as request_generation,
                  j.workload_class, j.attempt_count, j.attempt_limit,
                  j.lease_token::text as lease_token`,
        [workloadClass, owner, leaseSeconds, jobKind],
      );
      return rows.length === 0 ? null : jobFromRow(rows[0]);
    });
  }

  async oldestLiveNormalizationAgeSeconds(): Promise<number | null> {
    return await this.sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_processor");
      const rows = await tx.unsafe(
        `select extract(epoch from now() - min(created_at))::float8 as age_seconds
           from processing.telemetry_jobs
          where workload_class = 'live' and job_kind = 'normalize'
            and attempt_count < attempt_limit
            and (
              (status = 'queued' and available_at <= now()) or
              (status = 'leased' and lease_expires_at <= now())
            )`,
      );
      const value = rows[0]?.age_seconds;
      return value === null || value === undefined ? null : Number(value);
    });
  }

  async enqueueReduction(options: ReductionEnqueueOptions): Promise<void> {
    await this.enqueueReductions([options]);
  }

  async enqueueReductions(
    options: readonly ReductionEnqueueOptions[],
  ): Promise<void> {
    const targets = coalesceReductionTargets(options);
    if (targets.length === 0) return;
    await this.sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_processor");
      await tx.unsafe(
        `insert into processing.telemetry_jobs (
           workspace_id, job_kind, session_id, normalizer_version,
           activity_version, target_event_id, request_generation,
           workload_class, available_at
         )
         select target.workspace_id, 'reduce', target.session_id,
                target.normalizer_version, target.activity_version,
                target.target_event_id, 1, target.workload_class,
                now() + case when target.workload_class = 'live'
                  then interval '100 milliseconds' else interval '2 seconds' end
           from unnest(
             $1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::bigint[],
             $6::text[]
           ) as target(
             workspace_id, session_id, normalizer_version, activity_version,
             target_event_id, workload_class
           )
         on conflict (
           workspace_id, session_id, normalizer_version, activity_version
         ) where job_kind = 'reduce' do update set
           target_event_id = greatest(
             processing.telemetry_jobs.target_event_id,
             excluded.target_event_id
           ),
           request_generation = processing.telemetry_jobs.request_generation + 1,
           workload_class = case
             when processing.telemetry_jobs.workload_class = 'live'
               or excluded.workload_class = 'live' then 'live'
             else 'backfill'
           end,
           status = case
             when processing.telemetry_jobs.status = 'leased' then 'leased'
             else 'queued'
           end,
           available_at = case
             when processing.telemetry_jobs.status = 'leased'
               then processing.telemetry_jobs.available_at
             when processing.telemetry_jobs.status = 'queued'
               then least(processing.telemetry_jobs.available_at, excluded.available_at)
             else excluded.available_at
           end,
           attempt_count = case
             when processing.telemetry_jobs.status in ('failed', 'succeeded')
               then 0 else processing.telemetry_jobs.attempt_count
           end,
           requeue_count = processing.telemetry_jobs.requeue_count +
             case when processing.telemetry_jobs.status = 'failed' then 1 else 0 end,
           completed_at = case
             when processing.telemetry_jobs.status = 'leased'
               then processing.telemetry_jobs.completed_at
             else null
           end,
           updated_at = now()`,
        [
          targets.map((target) => target.workspaceId),
          targets.map((target) => target.sessionId),
          targets.map((target) => target.normalizerVersion),
          targets.map((target) => target.activityVersion),
          targets.map((target) => target.targetEventId.toString()),
          targets.map((target) => target.workloadClass),
        ],
      );
    });
  }

  async heartbeat(
    job: TelemetryJob,
    leaseSeconds: number,
  ): Promise<boolean> {
    return await this.updateLease(
      `update processing.telemetry_jobs
          set lease_expires_at = now() + make_interval(secs => $3),
              updated_at = now()
        where id = $1 and status = 'leased' and lease_token = $2
      returning id`,
      [job.id.toString(), job.lease_token, leaseSeconds],
    );
  }

  async complete(job: TelemetryJob): Promise<CompletionResult> {
    return await this.sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_processor");
      const rows = job.job_kind === "normalize"
        ? await tx.unsafe(
          `update processing.telemetry_jobs
              set status = 'succeeded', completed_at = now(),
                  lease_token = null, lease_owner = null,
                  lease_started_at = null, lease_expires_at = null,
                  updated_at = now()
            where id = $1 and status = 'leased' and lease_token = $2
          returning status`,
          [job.id.toString(), job.lease_token],
        )
        : await tx.unsafe(
          `update processing.telemetry_jobs
              set status = case when request_generation > $3 then 'queued'
                                else 'succeeded' end,
                  available_at = case when request_generation > $3 then now()
                                      else available_at end,
                  attempt_count = case when request_generation > $3 then 0
                                       else attempt_count end,
                  completed_at = case when request_generation > $3 then null
                                      else now() end,
                  lease_token = null, lease_owner = null,
                  lease_started_at = null, lease_expires_at = null,
                  updated_at = now()
            where id = $1 and status = 'leased' and lease_token = $2
          returning status`,
          [
            job.id.toString(),
            job.lease_token,
            job.request_generation.toString(),
          ],
        );
      if (rows.length !== 1) return "fenced";
      return rows[0].status === "queued" ? "requeued" : "succeeded";
    });
  }

  async retry(
    job: TelemetryJob,
    delaySeconds: number,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    return await this.updateLease(
      `update processing.telemetry_jobs
          set status = 'queued',
              available_at = now() + make_interval(secs => $3),
              lease_token = null, lease_owner = null,
              lease_started_at = null, lease_expires_at = null,
              last_error_code = $4, last_error = $5,
              last_failed_at = now(), updated_at = now()
        where id = $1 and status = 'leased' and lease_token = $2
      returning id`,
      [
        job.id.toString(),
        job.lease_token,
        delaySeconds,
        errorCode,
        errorMessage.slice(0, 1024),
      ],
    );
  }

  async fail(
    job: TelemetryJob,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    return await this.updateLease(
      `update processing.telemetry_jobs
          set status = 'failed', completed_at = now(),
              lease_token = null, lease_owner = null,
              lease_started_at = null, lease_expires_at = null,
              last_error_code = $3, last_error = $4,
              last_failed_at = now(), updated_at = now()
        where id = $1 and status = 'leased' and lease_token = $2
      returning id`,
      [
        job.id.toString(),
        job.lease_token,
        errorCode,
        errorMessage.slice(0, 1024),
      ],
    );
  }

  async terminalizeExpired(): Promise<number> {
    return await this.sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_processor");
      const rows = await tx.unsafe(
        `update processing.telemetry_jobs
            set status = 'failed', completed_at = now(),
                lease_token = null, lease_owner = null,
                lease_started_at = null, lease_expires_at = null,
                last_error_code = coalesce(last_error_code, 'lease_expired'),
                last_error = coalesce(
                  last_error,
                  'worker lease expired on the terminal attempt'
                ),
                last_failed_at = now(), updated_at = now()
          where status = 'leased' and lease_expires_at <= now()
            and attempt_count >= attempt_limit
        returning id`,
      );
      return rows.length;
    });
  }

  private async updateLease(
    query: string,
    parameters: unknown[],
  ): Promise<boolean> {
    return await this.sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_processor");
      return (await tx.unsafe(query, parameters as never[])).length === 1;
    });
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function jobFromRow(row: Record<string, unknown>): TelemetryJob {
  const common = {
    id: BigInt(String(row.id)),
    workspace_id: String(row.workspace_id),
    workload_class: String(row.workload_class) as WorkloadClass,
    attempt_count: Number(row.attempt_count),
    attempt_limit: Number(row.attempt_limit),
    lease_token: String(row.lease_token),
  };
  if (row.job_kind === "normalize") {
    return {
      ...common,
      job_kind: "normalize",
      batch_id: String(row.batch_id),
      normalizer_version: row.normalizer_version === null ||
          row.normalizer_version === undefined
        ? null
        : String(row.normalizer_version),
    };
  }
  return {
    ...common,
    job_kind: "reduce",
    session_id: String(row.session_id),
    normalizer_version: String(row.normalizer_version),
    activity_version: String(row.activity_version),
    target_event_id: BigInt(String(row.target_event_id)),
    request_generation: BigInt(String(row.request_generation)),
  };
}
