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
  ensure(
    path: string,
    bytes: Uint8Array,
    storedSha256: string,
    remainingMs?: () => number,
  ): Promise<void>;
}

export type WorkloadClassHint = "live" | "backfill" | null;

export interface BatchRepository {
  // Returns the receipt of an exact replay. Throws the commit's 409 when the
  // batch conflicts with committed ranges, so it is never uploaded.
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
  normalizer_version: string;
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
    remainingMs: () => number = () => Number.POSITIVE_INFINITY,
  ): Promise<CommittedReceipt> {
    await validateStoredBatch(manifest, storedPayload);
    let receipt = await this.batches.findExact(attribution, manifest);
    if (!receipt) {
      const path = storagePath(attribution, manifest);
      await this.storage.ensure(
        path,
        storedPayload,
        manifest.stored_sha256,
        remainingMs,
      );
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
  const source = await decompressBounded(
    storedPayload,
    manifest.source_byte_count,
  );
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
      (await sha256Hex(source.subarray(relativeStart, relativeEnd))) !==
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

// Decompresses into one buffer of the size the manifest declares, so a large
// batch holds its source once rather than as chunks plus a joined copy.
// Bytes past that size are only counted, to tell a lying manifest (400) from
// an oversized source (413) as before.
export async function decompressBounded(
  storedPayload: Uint8Array,
  expectedBytes = MAX_SOURCE_BYTES,
): Promise<Uint8Array> {
  try {
    const reader = new Blob([storedPayload as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"))
      .getReader();
    const result = new Uint8Array(
      Math.max(0, Math.min(expectedBytes, MAX_SOURCE_BYTES)),
    );
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total < result.byteLength) {
        result.set(
          value.subarray(
            0,
            Math.min(value.byteLength, result.byteLength - total),
          ),
          total,
        );
      }
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new IngestError(
          "payload_too_large",
          "uncompressed source exceeds 16 MiB",
          413,
        );
      }
    }
    if (total > result.byteLength) {
      throw new IngestError(
        "source_integrity_mismatch",
        "uncompressed source size/hash does not match the manifest",
        400,
      );
    }
    // A shorter source fails the caller's size check.
    return result.subarray(0, total);
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(
      "invalid_gzip",
      "stored payload cannot be decoded as gzip",
      400,
    );
  }
}
