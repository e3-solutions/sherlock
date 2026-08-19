import postgres from "npm:postgres@3.4.7";
import { PostgresActivityReducer } from "../../supabase/functions/sherlock-activity-reducer/postgres.ts";
import { ACTIVITY_VERSION } from "../../supabase/functions/sherlock-activity-reducer/reducer.ts";
import {
  type BatchManifest,
  type CommittedReceipt,
  CONTRACT_VERSION,
  IngestError,
  receiptFromRow,
} from "../../supabase/functions/sherlock-rollout-ingest/contract.ts";
import { NORMALIZER_VERSION } from "../../supabase/functions/sherlock-rollout-ingest/normalizer.ts";
import { PostgresBatchNormalizer } from "../../supabase/functions/sherlock-rollout-ingest/normalizer_postgres.ts";
import { validateStoredBatch } from "../../supabase/functions/sherlock-rollout-ingest/service.ts";
import type { NormalizationJob, ReductionJob, WorkloadClass } from "./queue.ts";

type Sql = ReturnType<typeof postgres>;

export interface ProcessingResult {
  session_count: number;
  candidate_count: number;
  inserted_count: number;
  tombstone_count: number;
}

export interface ReductionTarget {
  workspace_id: string;
  session_id: string;
  normalizer_version: string;
  activity_version: string;
  target_event_id: bigint;
  workload_class: WorkloadClass;
}

export interface TargetedReducer {
  reduceSession(options: {
    workspaceId: string;
    sessionId: string;
    normalizerVersion: string;
    activityVersion: string;
    throughEventId: bigint;
    eventPageSize: number;
    statementTimeoutMs?: number;
    deadlineAtMs?: number;
  }): Promise<{
    candidate_count: number;
    inserted_count: number;
    tombstone_count: number;
  }>;
}

interface StoredBatch {
  receipt: CommittedReceipt;
  manifest: BatchManifest;
}

export class TelemetryProcessor {
  private readonly loader: Sql;
  private readonly normalizer: PostgresBatchNormalizer;
  private readonly reducer: PostgresActivityReducer;

  constructor(
    databaseUrl: string,
    private readonly storage: SupabaseRawStorage,
  ) {
    this.loader = postgres(databaseUrl, {
      prepare: false,
      max: 2,
      idle_timeout: 20,
    });
    this.normalizer = PostgresBatchNormalizer.connect(databaseUrl);
    this.reducer = PostgresActivityReducer.connect(databaseUrl);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.loader.end(),
      this.normalizer.close(),
      this.reducer.close(),
    ]);
  }

  async normalize(job: NormalizationJob): Promise<ReductionTarget[]> {
    const batch = await this.loadBatch(job);
    const stored = await this.storage.download(
      batch.receipt.storage_path,
      batch.receipt.stored_byte_count,
    );
    const source = await validateStoredBatch(batch.manifest, stored);
    const normalized = await this.normalizer.normalize(
      batch.receipt,
      batch.manifest,
      source,
    );
    const targets: ReductionTarget[] = [];
    for (const sessionId of normalized.session_ids) {
      const targetEventId = await this.resolveSessionCutoff(
        job.workspace_id,
        sessionId,
        normalized.normalizer_version,
      );
      if (targetEventId > 0n) {
        targets.push({
          workspace_id: job.workspace_id,
          session_id: sessionId,
          normalizer_version: normalized.normalizer_version,
          activity_version: ACTIVITY_VERSION,
          target_event_id: targetEventId,
          workload_class: job.workload_class,
        });
      }
    }
    return targets;
  }

  async reduce(
    job: ReductionJob,
    maximumDurationMs: number,
  ): Promise<ProcessingResult> {
    const reduced = await this.reducer.reduceSession({
      workspaceId: job.workspace_id,
      sessionId: job.session_id,
      normalizerVersion: job.normalizer_version,
      activityVersion: job.activity_version,
      throughEventId: job.target_event_id,
      eventPageSize: 1_000,
      statementTimeoutMs: maximumDurationMs,
      deadlineAtMs: performance.now() + maximumDurationMs,
    });
    return {
      session_count: 1,
      candidate_count: reduced.candidate_count,
      inserted_count: reduced.inserted_count,
      tombstone_count: reduced.tombstone_count,
    };
  }

  private async loadBatch(job: NormalizationJob): Promise<StoredBatch> {
    return await this.loader.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_normalizer");
      const batches = await tx.unsafe(
        `select id, workspace_id, person_id, collector_key, source_provider,
                source_kind,
                source_stream_key, generation_key, generation_seq,
                start_offset, end_offset, source_byte_count, source_sha256,
                storage_path, storage_encoding, stored_byte_count,
                stored_sha256, record_count, contract_version,
                observed_native_session_id, observed_parent_native_session_id,
                to_char(first_occurred_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as first_occurred_at,
                to_char(last_occurred_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_occurred_at,
                codex_version, source_version, collector_version, committed_at
           from telemetry.ingest_batches
          where workspace_id = $1 and id = $2`,
        [job.workspace_id, job.batch_id],
      );
      if (batches.length !== 1) {
        throw new IngestError(
          "processing_batch_missing",
          "queued batch does not exist",
          500,
        );
      }
      const row = batches[0] as Record<string, unknown>;
      if (
        row.contract_version !== CONTRACT_VERSION ||
        !(["rollout", "transcript"] as unknown[]).includes(row.source_kind) ||
        row.storage_encoding !== "gzip"
      ) {
        throw new IngestError(
          "processing_contract_unsupported",
          "queued batch uses an unsupported stored contract",
          500,
        );
      }
      const records = await tx.unsafe(
        `select record_index, source_start_offset, source_end_offset,
                record_sha256, native_type, native_payload_type,
                to_char(occurred_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
                parse_status, native_record_start_offset,
                native_record_end_offset, native_record_sha256,
                fragment_index, fragment_count
           from telemetry.native_records
          where workspace_id = $1 and batch_id = $2
          order by record_index`,
        [job.workspace_id, job.batch_id],
      );
      const manifest: BatchManifest = {
        contract_version: CONTRACT_VERSION,
        source_provider: String(
          row.source_provider,
        ) as BatchManifest["source_provider"],
        source_kind: String(row.source_kind) as BatchManifest["source_kind"],
        source_stream_key: String(row.source_stream_key),
        generation_key: String(row.generation_key),
        generation_seq: Number(row.generation_seq),
        start_offset: Number(row.start_offset),
        end_offset: Number(row.end_offset),
        source_byte_count: Number(row.source_byte_count),
        source_sha256: String(row.source_sha256),
        storage_encoding: row.storage_encoding,
        stored_byte_count: Number(row.stored_byte_count),
        stored_sha256: String(row.stored_sha256),
        record_count: Number(row.record_count),
        records: records.map(recordLocatorFromRow),
        observed_native_session_id: nullableString(
          row.observed_native_session_id,
        ),
        observed_parent_native_session_id: nullableString(
          row.observed_parent_native_session_id,
        ),
        first_occurred_at: nullableString(row.first_occurred_at),
        last_occurred_at: nullableString(row.last_occurred_at),
        codex_version: nullableString(row.codex_version),
        source_version: nullableString(row.source_version),
        collector_version: nullableString(row.collector_version),
      };
      if (manifest.records.length !== manifest.record_count) {
        throw new IngestError(
          "processing_record_mismatch",
          "queued batch native record count is incomplete",
          500,
        );
      }
      return { receipt: receiptFromRow(row), manifest };
    });
  }

  private async resolveSessionCutoff(
    workspaceId: string,
    sessionId: string,
    normalizerVersion: string,
  ): Promise<bigint> {
    return await this.loader.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_normalizer");
      const rows = await tx.unsafe(
        `select coalesce(max(id), 0)::text as cutoff
           from telemetry.events
          where workspace_id = $1 and session_id = $2
            and normalizer_version = $3`,
        [workspaceId, sessionId, normalizerVersion],
      );
      return BigInt(String(rows[0].cutoff));
    });
  }
}

export async function reduceAffectedSessions(
  workspaceId: string,
  sessionIds: readonly string[],
  resolveCutoff: (sessionId: string) => Promise<bigint>,
  reducer: TargetedReducer,
): Promise<ProcessingResult> {
  const total: ProcessingResult = {
    session_count: sessionIds.length,
    candidate_count: 0,
    inserted_count: 0,
    tombstone_count: 0,
  };
  for (const sessionId of sessionIds) {
    const reduced = await reducer.reduceSession({
      workspaceId,
      sessionId,
      normalizerVersion: NORMALIZER_VERSION,
      activityVersion: ACTIVITY_VERSION,
      throughEventId: await resolveCutoff(sessionId),
      eventPageSize: 1_000,
    });
    total.candidate_count += reduced.candidate_count;
    total.inserted_count += reduced.inserted_count;
    total.tombstone_count += reduced.tombstone_count;
  }
  return total;
}

export function recordLocatorFromRow(
  record: Record<string, unknown>,
): BatchManifest["records"][number] {
  return {
    record_index: Number(record.record_index),
    source_start_offset: Number(record.source_start_offset),
    source_end_offset: Number(record.source_end_offset),
    record_sha256: String(record.record_sha256),
    native_type: nullableString(record.native_type),
    native_payload_type: nullableString(record.native_payload_type),
    occurred_at: nullableString(record.occurred_at),
    parse_status: String(
      record.parse_status,
    ) as BatchManifest["records"][number]["parse_status"],
    native_record_start_offset: nullableNumber(
      record.native_record_start_offset,
    ),
    native_record_end_offset: nullableNumber(record.native_record_end_offset),
    native_record_sha256: nullableString(record.native_record_sha256),
    fragment_index: nullableNumber(record.fragment_index),
    fragment_count: nullableNumber(record.fragment_count),
  };
}

export class SupabaseRawStorage {
  constructor(
    private readonly supabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly timeoutMilliseconds = 30_000,
  ) {}

  async download(path: string, expectedBytes: number): Promise<Uint8Array> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(
      `${this.supabaseUrl}/storage/v1/object/telemetry-raw/${encoded}`,
      {
        headers: {
          Authorization: `Bearer ${this.serviceRoleKey}`,
          apikey: this.serviceRoleKey,
        },
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      },
    );
    if (!response.ok) {
      throw new IngestError(
        "processing_storage_read_failed",
        `immutable Storage download failed (${response.status})`,
        response.status >= 500 ? 503 : 500,
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > expectedBytes) {
      await response.body?.cancel();
      throw new IngestError(
        "processing_storage_size_mismatch",
        "immutable Storage object exceeds its committed size",
        500,
      );
    }
    if (!response.body) {
      throw new IngestError(
        "processing_storage_read_failed",
        "immutable Storage download returned no body",
        500,
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expectedBytes) {
        await reader.cancel();
        throw new IngestError(
          "processing_storage_size_mismatch",
          "immutable Storage object exceeds its committed size",
          500,
        );
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
