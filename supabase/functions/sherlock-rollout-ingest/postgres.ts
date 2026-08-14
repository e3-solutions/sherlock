import postgres from "npm:postgres@3.4.7";
import {
  type Attribution,
  type BatchManifest,
  type CommittedReceipt,
  IngestError,
  receiptFromRow,
  timestampMicros,
} from "./contract.ts";
import type { BatchRepository } from "./service.ts";

type Sql = ReturnType<typeof postgres>;
type Queryable = Pick<Sql, "unsafe">;

const RECEIPT_COLUMNS = `
  id, workspace_id, person_id, collector_key, source_kind, source_stream_key,
  generation_key, generation_seq, start_offset, end_offset, source_byte_count,
  source_sha256, storage_path, stored_byte_count, stored_sha256, record_count,
  contract_version, committed_at
`;

function assertExact(
  row: Record<string, unknown>,
  manifest: BatchManifest,
): void {
  const expected: Record<string, unknown> = {
    source_sha256: manifest.source_sha256,
    source_byte_count: manifest.source_byte_count,
    storage_encoding: manifest.storage_encoding,
    stored_byte_count: manifest.stored_byte_count,
    stored_sha256: manifest.stored_sha256,
    record_count: manifest.record_count,
    contract_version: manifest.contract_version,
    observed_native_session_id: manifest.observed_native_session_id,
    first_occurred_at: manifest.first_occurred_at,
    last_occurred_at: manifest.last_occurred_at,
    codex_version: manifest.codex_version,
    collector_version: manifest.collector_version,
  };
  for (const [field, value] of Object.entries(expected)) {
    const actual = typeof value === "number" ? Number(row[field]) : row[field];
    const timestampField = field === "first_occurred_at" ||
      field === "last_occurred_at";
    const equal = timestampField && value !== null
      ? timestampMicros(String(actual)) === timestampMicros(String(value))
      : actual === value;
    if (!equal) {
      throw new IngestError(
        "range_identity_conflict",
        `the committed byte range has a conflicting ${field}`,
        409,
      );
    }
  }
}

export function assertExactRecords(
  rows: readonly Record<string, unknown>[],
  manifest: BatchManifest,
): void {
  if (rows.length !== manifest.records.length) {
    throw new IngestError(
      "record_identity_conflict",
      "committed native record count differs from the retry manifest",
      409,
    );
  }
  rows.forEach((row, index) => {
    const record = manifest.records[index];
    const expected: Record<string, unknown> = {
      record_index: record.record_index,
      source_start_offset: record.source_start_offset,
      source_end_offset: record.source_end_offset,
      record_sha256: record.record_sha256,
      native_type: record.native_type,
      native_payload_type: record.native_payload_type,
      parse_status: record.parse_status,
    };
    for (const [field, value] of Object.entries(expected)) {
      const actual = typeof value === "number"
        ? Number(row[field])
        : row[field];
      if (actual !== value) {
        throw new IngestError(
          "record_identity_conflict",
          `committed native record ${index} differs in ${field}`,
          409,
        );
      }
    }
    const actualOccurredAt = row.occurred_at;
    const occurredAtMatches = record.occurred_at === null
      ? actualOccurredAt === null
      : timestampMicros(String(actualOccurredAt)) ===
        timestampMicros(record.occurred_at);
    if (!occurredAtMatches) {
      throw new IngestError(
        "record_identity_conflict",
        `committed native record ${index} differs in occurred_at`,
        409,
      );
    }
  });
}

async function assertCommittedRecords(
  sql: Queryable,
  workspaceId: string,
  batchId: unknown,
  manifest: BatchManifest,
): Promise<void> {
  const rows = await sql.unsafe(
    `select record_index, source_start_offset, source_end_offset, record_sha256,
            native_type, native_payload_type,
            to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
            parse_status
       from telemetry.native_records
      where workspace_id = $1 and batch_id = $2
      order by record_index`,
    [workspaceId, String(batchId)],
  );
  assertExactRecords(rows as Record<string, unknown>[], manifest);
}

export class PostgresBatchRepository implements BatchRepository {
  constructor(private readonly sql: Sql) {}

  static connect(databaseUrl: string): PostgresBatchRepository {
    return new PostgresBatchRepository(
      postgres(databaseUrl, { prepare: false, max: 2, idle_timeout: 20 }),
    );
  }

  async findExact(
    attribution: Attribution,
    manifest: BatchManifest,
  ): Promise<CommittedReceipt | null> {
    const rows = await this.sql.unsafe(
      `select ${RECEIPT_COLUMNS}, storage_encoding, observed_native_session_id,
              to_char(first_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as first_occurred_at,
              to_char(last_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_occurred_at,
              codex_version, collector_version
         from telemetry.ingest_batches
        where workspace_id = $1 and collector_key = $2 and source_kind = $3
          and source_stream_key = $4 and generation_seq = $5
          and generation_key = $6 and start_offset = $7 and end_offset = $8`,
      [
        attribution.workspace_id,
        attribution.collector_key,
        manifest.source_kind,
        manifest.source_stream_key,
        manifest.generation_seq,
        manifest.generation_key,
        manifest.start_offset,
        manifest.end_offset,
      ],
    );
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    assertExact(row, manifest);
    await assertCommittedRecords(
      this.sql,
      attribution.workspace_id,
      row.id,
      manifest,
    );
    return receiptFromRow(row);
  }

  async commit(
    attribution: Attribution,
    manifest: BatchManifest,
    path: string,
  ): Promise<CommittedReceipt> {
    return await this.sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_ingest");
      const lockIdentity = [
        attribution.workspace_id,
        attribution.collector_key,
        manifest.source_kind,
        manifest.source_stream_key,
      ].join("\u0000");
      await tx.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        lockIdentity,
      ]);

      const existing = await tx.unsafe(
        `select ${RECEIPT_COLUMNS}, storage_encoding, observed_native_session_id,
                to_char(first_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as first_occurred_at,
                to_char(last_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_occurred_at,
                codex_version, collector_version
           from telemetry.ingest_batches
          where workspace_id = $1 and collector_key = $2 and source_kind = $3
            and source_stream_key = $4 and generation_seq = $5
            and generation_key = $6 and start_offset = $7 and end_offset = $8`,
        [
          attribution.workspace_id,
          attribution.collector_key,
          manifest.source_kind,
          manifest.source_stream_key,
          manifest.generation_seq,
          manifest.generation_key,
          manifest.start_offset,
          manifest.end_offset,
        ],
      );
      if (existing.length > 0) {
        const row = existing[0] as Record<string, unknown>;
        assertExact(row, manifest);
        await assertCommittedRecords(
          tx,
          attribution.workspace_id,
          row.id,
          manifest,
        );
        return receiptFromRow(row);
      }

      const mappingConflict = await tx.unsafe(
        `select 1
           from telemetry.ingest_batches
          where workspace_id = $1 and collector_key = $2 and source_kind = $3
            and source_stream_key = $4
            and ((generation_seq = $5 and generation_key <> $6)
              or (generation_key = $6 and generation_seq <> $5))
          limit 1`,
        [
          attribution.workspace_id,
          attribution.collector_key,
          manifest.source_kind,
          manifest.source_stream_key,
          manifest.generation_seq,
          manifest.generation_key,
        ],
      );
      if (mappingConflict.length > 0) {
        throw new IngestError(
          "generation_mapping_conflict",
          "generation sequence and opaque key mapping is inconsistent",
          409,
        );
      }

      const overlap = await tx.unsafe(
        `select 1
           from telemetry.ingest_batches
          where workspace_id = $1 and collector_key = $2 and source_kind = $3
            and source_stream_key = $4 and generation_seq = $5
            and int8range(start_offset, end_offset, '[)') && int8range($6, $7, '[)')
          limit 1`,
        [
          attribution.workspace_id,
          attribution.collector_key,
          manifest.source_kind,
          manifest.source_stream_key,
          manifest.generation_seq,
          manifest.start_offset,
          manifest.end_offset,
        ],
      );
      if (overlap.length > 0) {
        throw new IngestError(
          "range_overlap",
          "batch byte range overlaps a committed range in this generation",
          409,
        );
      }

      const batchId = crypto.randomUUID();
      const inserted = await tx.unsafe(
        `insert into telemetry.ingest_batches (
           id, workspace_id, person_id, collector_key, observed_native_session_id,
           source_kind, source_stream_key, generation_key, generation_seq,
           start_offset, end_offset, source_byte_count, source_sha256,
           storage_path, storage_encoding, stored_byte_count, stored_sha256,
           record_count, first_occurred_at, last_occurred_at, codex_version,
           collector_version, contract_version
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
         ) returning ${RECEIPT_COLUMNS}`,
        [
          batchId,
          attribution.workspace_id,
          attribution.person_id,
          attribution.collector_key,
          manifest.observed_native_session_id,
          manifest.source_kind,
          manifest.source_stream_key,
          manifest.generation_key,
          manifest.generation_seq,
          manifest.start_offset,
          manifest.end_offset,
          manifest.source_byte_count,
          manifest.source_sha256,
          path,
          manifest.storage_encoding,
          manifest.stored_byte_count,
          manifest.stored_sha256,
          manifest.record_count,
          manifest.first_occurred_at,
          manifest.last_occurred_at,
          manifest.codex_version,
          manifest.collector_version,
          manifest.contract_version,
        ],
      );

      const records = manifest.records.map((record) => ({
        workspace_id: attribution.workspace_id,
        batch_id: batchId,
        record_index: record.record_index,
        source_start_offset: record.source_start_offset,
        source_end_offset: record.source_end_offset,
        record_sha256: record.record_sha256,
        native_type: record.native_type,
        native_payload_type: record.native_payload_type,
        occurred_at: record.occurred_at,
        parse_status: record.parse_status,
      }));
      for (let offset = 0; offset < records.length; offset += 1_000) {
        const locatorBatch = records.slice(offset, offset + 1_000);
        await tx`insert into telemetry.native_records ${
          tx(
            locatorBatch,
            "workspace_id",
            "batch_id",
            "record_index",
            "source_start_offset",
            "source_end_offset",
            "record_sha256",
            "native_type",
            "native_payload_type",
            "occurred_at",
            "parse_status",
          )
        }`;
      }
      return receiptFromRow(inserted[0] as Record<string, unknown>);
    });
  }
}
