import {
  type Attribution,
  type BatchManifest,
  type CommittedReceipt,
  IngestError,
  MAX_SOURCE_BYTES,
  sha256Hex,
  storagePath,
} from "./contract.ts";

export interface ImmutableStorage {
  ensure(path: string, bytes: Uint8Array, storedSha256: string): Promise<void>;
}

export type WorkloadClassHint = "live" | "backfill" | null;

export interface BatchRepository {
  findExact(
    attribution: Attribution,
    manifest: BatchManifest,
  ): Promise<CommittedReceipt | null>;
  commit(
    attribution: Attribution,
    manifest: BatchManifest,
    path: string,
    workloadClassHint: WorkloadClassHint,
  ): Promise<CommittedReceipt>;
}

export interface BatchNormalizer {
  normalize(
    receipt: CommittedReceipt,
    manifest: BatchManifest,
    source: Uint8Array,
  ): Promise<NormalizationResult>;
}

export interface NormalizationResult {
  session_ids: string[];
}

export class IngestService {
  constructor(
    private readonly storage: ImmutableStorage,
    private readonly batches: BatchRepository,
  ) {}

  async ingest(
    attribution: Attribution,
    manifest: BatchManifest,
    storedPayload: Uint8Array,
    workloadClassHint: WorkloadClassHint = null,
  ): Promise<CommittedReceipt> {
    await validateStoredBatch(manifest, storedPayload);
    let receipt = await this.batches.findExact(attribution, manifest);
    if (!receipt) {
      const path = storagePath(attribution, manifest);
      await this.storage.ensure(path, storedPayload, manifest.stored_sha256);
      receipt = await this.batches.commit(
        attribution,
        manifest,
        path,
        workloadClassHint,
      );
    }
    return receipt;
  }
}

export async function validateStoredBatch(
  manifest: BatchManifest,
  storedPayload: Uint8Array,
): Promise<Uint8Array> {
  if (
    storedPayload.byteLength !== manifest.stored_byte_count ||
    (await sha256Hex(storedPayload)) !== manifest.stored_sha256
  ) {
    throw new IngestError(
      "stored_integrity_mismatch",
      "stored payload size/hash does not match the manifest",
      400,
    );
  }
  const source = await decompressBounded(storedPayload);
  if (
    source.byteLength !== manifest.source_byte_count ||
    (await sha256Hex(source)) !== manifest.source_sha256
  ) {
    throw new IngestError(
      "source_integrity_mismatch",
      "uncompressed source size/hash does not match the manifest",
      400,
    );
  }
  for (const record of manifest.records) {
    const relativeStart = record.source_start_offset - manifest.start_offset;
    const relativeEnd = record.source_end_offset - manifest.start_offset;
    if (
      (await sha256Hex(source.slice(relativeStart, relativeEnd))) !==
        record.record_sha256
    ) {
      throw new IngestError(
        "record_integrity_mismatch",
        `record ${record.record_index} hash does not match source bytes`,
        400,
      );
    }
  }
  return source;
}

export async function decompressBounded(
  storedPayload: Uint8Array,
): Promise<Uint8Array> {
  try {
    const bytes = storedPayload.buffer.slice(
      storedPayload.byteOffset,
      storedPayload.byteOffset + storedPayload.byteLength,
    ) as ArrayBuffer;
    const reader = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"))
      .getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new IngestError(
          "payload_too_large",
          "uncompressed source exceeds 5 MiB",
          413,
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
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(
      "invalid_gzip",
      "stored payload cannot be decoded as gzip",
      400,
    );
  }
}
