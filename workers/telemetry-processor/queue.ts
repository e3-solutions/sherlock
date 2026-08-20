import postgres from "npm:postgres@3.4.7";

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

type Sql = ReturnType<typeof postgres>;

export class PostgresJobQueue {
  private constructor(private readonly sql: Sql) {}

  static connect(
    databaseUrl: string,
    maxConnections: number,
  ): PostgresJobQueue {
    return new PostgresJobQueue(postgres(databaseUrl, {
      prepare: false,
      max: maxConnections,
      idle_timeout: 20,
      connect_timeout: 10,
    }));
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async claim(
    workloadClass: WorkloadClass,
    owner: string,
    leaseSeconds: number,
  ): Promise<TelemetryJob | null> {
    return await this.sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_processor");
      const rows = await tx.unsafe(
        `with candidate as (
           select j.id
             from processing.telemetry_jobs j
             left join telemetry.ingest_batches batch
               on j.job_kind = 'normalize'
              and batch.workspace_id = j.workspace_id
              and batch.id = j.batch_id
            where j.workload_class = $1
              and j.attempt_count < j.attempt_limit
              and (
                (j.status = 'queued' and j.available_at <= now()) or
                (j.status = 'leased' and j.lease_expires_at <= now())
              )
              and (
                j.job_kind <> 'normalize' or not exists (
                  select 1
                    from telemetry.ingest_batches predecessor
                    join processing.telemetry_jobs predecessor_job
                      on predecessor_job.workspace_id = predecessor.workspace_id
                     and predecessor_job.batch_id = predecessor.id
                     and predecessor_job.job_kind = 'normalize'
                   where predecessor.workspace_id = batch.workspace_id
                     and predecessor.collector_key = batch.collector_key
                     and predecessor.source_kind = batch.source_kind
                     and predecessor.source_stream_key = batch.source_stream_key
                     and predecessor.generation_seq = batch.generation_seq
                     and predecessor.generation_key = batch.generation_key
                     and predecessor.start_offset < batch.start_offset
                     and predecessor_job.status in ('queued', 'leased')
                )
              )
            order by case when j.status = 'queued' then j.available_at
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
        [workloadClass, owner, leaseSeconds],
      );
      return rows.length === 0 ? null : jobFromRow(rows[0]);
    });
  }

  async enqueueReduction(options: {
    workspaceId: string;
    sessionId: string;
    normalizerVersion: string;
    activityVersion: string;
    targetEventId: bigint;
    workloadClass: WorkloadClass;
  }): Promise<void> {
    if (options.targetEventId <= 0n) return;
    await this.sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_processor");
      await tx.unsafe(
        `insert into processing.telemetry_jobs (
           workspace_id, job_kind, session_id, normalizer_version,
           activity_version, target_event_id, request_generation,
           workload_class, available_at
         ) values (
           $1, 'reduce', $2, $3, $4, $5, 1, $6,
           now() + case when $6 = 'live' then interval '100 milliseconds'
                        else interval '2 seconds' end
         ) on conflict (
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
          options.workspaceId,
          options.sessionId,
          options.normalizerVersion,
          options.activityVersion,
          options.targetEventId.toString(),
          options.workloadClass,
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
