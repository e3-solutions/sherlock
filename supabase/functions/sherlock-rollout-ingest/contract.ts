export const CONTRACT_VERSION = "sherlock.rollout-batch.v1";
export const RECEIPT_VERSION = "sherlock.committed-receipt.v1";
export const MAX_STORED_BYTES = 6 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_RECORDS = 20_000;
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
export const MAX_BULK_ITEMS = 32;
export const MAX_BULK_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_BULK_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_BULK_MANIFEST_TOTAL_BYTES = 20 * 1024 * 1024;
export const BULK_CONTENT_TYPE = "application/vnd.sherlock.rollout-bulk.v2";
export const BULK_RECEIPT_VERSION = "sherlock.bulk-receipts.v1";
const BULK_MAGIC = new TextEncoder().encode("SHRBULK2");
export const NATIVE_LABEL_BYTES = 256;
export const IDENTITY_HINT_BYTES = 512;
export const VERSION_HINT_BYTES = 128;
export const PERSON_NAME_BYTES = 256;
export const EMAIL_BYTES = 320;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]{1,200}$/;
const GITHUB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RecordLocator {
  record_index: number;
  source_start_offset: number;
  source_end_offset: number;
  record_sha256: string;
  native_type: string | null;
  native_payload_type: string | null;
  occurred_at: string | null;
  parse_status: "ok" | "unknown" | "malformed" | "fragment";
  native_record_start_offset: number | null;
  native_record_end_offset: number | null;
  native_record_sha256: string | null;
  fragment_index: number | null;
  fragment_count: number | null;
}

export interface BatchManifest {
  contract_version: typeof CONTRACT_VERSION;
  source_kind: "rollout";
  source_stream_key: string;
  generation_key: string;
  generation_seq: number;
  start_offset: number;
  end_offset: number;
  source_byte_count: number;
  source_sha256: string;
  storage_encoding: "gzip";
  stored_byte_count: number;
  stored_sha256: string;
  record_count: number;
  records: RecordLocator[];
  observed_native_session_id: string | null;
  first_occurred_at: string | null;
  last_occurred_at: string | null;
  codex_version: string | null;
  collector_version: string | null;
}

export interface Attribution {
  workspace_id: string;
  person_id: string;
  collector_key: string;
}

export interface CollectorIdentity {
  name: string;
  github_id: string;
  email: string;
  installation_id: string;
}

export interface CommittedReceipt extends Attribution {
  receipt_version: typeof RECEIPT_VERSION;
  status: "committed";
  batch_id: string;
  source_kind: "rollout";
  source_stream_key: string;
  generation_key: string;
  generation_seq: number;
  start_offset: number;
  end_offset: number;
  source_byte_count: number;
  source_sha256: string;
  storage_path: string;
  stored_byte_count: number;
  stored_sha256: string;
  record_count: number;
  contract_version: typeof CONTRACT_VERSION;
  committed_at: string;
}

export interface IngestEnvelope {
  collector: CollectorIdentity | null;
  manifest: BatchManifest;
  stored_payload: Uint8Array;
}

export class IngestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IngestError(
      "invalid_manifest",
      `${field} must be an object`,
      400,
    );
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new IngestError(
      "invalid_manifest",
      `${field} must be a safe integer >= ${minimum}`,
      400,
    );
  }
  return value as number;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IngestError(
      "invalid_manifest",
      `${field} must be non-empty`,
      400,
    );
  }
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, field);
}

function boundedNullableText(
  value: unknown,
  field: string,
  maximumBytes: number,
): string | null {
  const result = nullableText(value, field);
  if (
    result !== null &&
    new TextEncoder().encode(result).byteLength > maximumBytes
  ) {
    throw new IngestError(
      "invalid_manifest",
      `${field} exceeds ${maximumBytes} UTF-8 bytes`,
      400,
    );
  }
  return result;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  const result = nullableText(value, field);
  if (result === null) return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/
      .exec(
        result,
      );
  const parts = match?.slice(1, 7).map(Number);
  const calendar = parts
    ? new Date(
      Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]),
    )
    : null;
  const offset = match?.[7];
  const offsetValid = offset === "Z" || (
    offset !== undefined &&
    Number(offset.slice(1, 3)) <= 23 &&
    Number(offset.slice(4, 6)) <= 59
  );
  if (
    !parts ||
    !calendar ||
    calendar.getUTCFullYear() !== parts[0] ||
    calendar.getUTCMonth() !== parts[1] - 1 ||
    calendar.getUTCDate() !== parts[2] ||
    calendar.getUTCHours() !== parts[3] ||
    calendar.getUTCMinutes() !== parts[4] ||
    calendar.getUTCSeconds() !== parts[5] ||
    !offsetValid ||
    !Number.isFinite(Date.parse(result))
  ) {
    throw new IngestError(
      "invalid_manifest",
      `${field} must be an ISO-8601 timestamp`,
      400,
    );
  }
  return result;
}

export function timestampMicros(value: string): bigint {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/
      .exec(value);
  if (!match) throw new Error("timestamp is outside the validated contract");
  const [, year, month, day, hour, minute, second, fraction = "", zone] = match;
  const localMillis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  let offsetMinutes = 0;
  if (zone !== "Z") {
    offsetMinutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6));
    if (zone.startsWith("-")) offsetMinutes = -offsetMinutes;
  }
  return BigInt(localMillis - offsetMinutes * 60_000) * 1_000n +
    BigInt(fraction.padEnd(6, "0"));
}

function hash(value: unknown, field: string): string {
  const result = text(value, field);
  if (!SHA256.test(result)) {
    throw new IngestError(
      "invalid_manifest",
      `${field} must be lowercase SHA-256`,
      400,
    );
  }
  return result;
}

function safeSegment(value: unknown, field: string): string {
  const result = text(value, field);
  if (!SAFE_SEGMENT.test(result)) {
    throw new IngestError(
      "invalid_manifest",
      `${field} is not a safe path segment`,
      400,
    );
  }
  return result;
}

function identityText(
  value: unknown,
  field: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IngestError(
      "invalid_identity",
      `collector.${field} is required`,
      400,
    );
  }
  const result = value.trim();
  if (new TextEncoder().encode(result).byteLength > maximumBytes) {
    throw new IngestError(
      "invalid_identity",
      `collector.${field} exceeds ${maximumBytes} UTF-8 bytes`,
      400,
    );
  }
  return result;
}

export function parseCollectorIdentity(value: unknown): CollectorIdentity {
  const input = object(value, "collector");
  const name = identityText(input.name, "name", PERSON_NAME_BYTES);
  const githubId = identityText(input.github_id, "github_id", 39).toLowerCase();
  const email = identityText(input.email, "email", EMAIL_BYTES).toLowerCase();
  const installationId = identityText(
    input.installation_id,
    "installation_id",
    36,
  ).toLowerCase();
  if (!GITHUB_ID.test(githubId)) {
    throw new IngestError(
      "invalid_identity",
      "collector.github_id must be a GitHub login",
      400,
    );
  }
  if (
    email.split("@").length !== 2 ||
    /\s|[\u0000-\u001f]/.test(email) ||
    email.startsWith("@") ||
    email.endsWith("@")
  ) {
    throw new IngestError(
      "invalid_identity",
      "collector.email must be a valid address",
      400,
    );
  }
  const domain = email.split("@")[1];
  if (domain.startsWith(".") || domain.endsWith(".")) {
    throw new IngestError(
      "invalid_identity",
      "collector.email must be a valid address",
      400,
    );
  }
  if (!UUID_V4.test(installationId)) {
    throw new IngestError(
      "invalid_identity",
      "collector.installation_id must be a canonical UUIDv4",
      400,
    );
  }
  return {
    name,
    github_id: githubId,
    email,
    installation_id: installationId,
  };
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new IngestError(
      "invalid_payload",
      "stored_payload_base64 is required",
      400,
    );
  }
  const maximumEncodedLength = Math.ceil(MAX_STORED_BYTES / 3) * 4;
  if (value.length > maximumEncodedLength) {
    throw new IngestError(
      "payload_too_large",
      "stored payload exceeds 6 MiB",
      413,
    );
  }
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    if (bytes.byteLength > MAX_STORED_BYTES) {
      throw new IngestError(
        "payload_too_large",
        "stored payload exceeds 6 MiB",
        413,
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(
      "invalid_payload",
      "stored payload is not valid base64",
      400,
    );
  }
}

function parseRecord(value: unknown): RecordLocator {
  const input = object(value, "record");
  const parseStatus = text(input.parse_status, "record.parse_status");
  if (
    !(["ok", "unknown", "malformed", "fragment"] as string[]).includes(
      parseStatus,
    )
  ) {
    throw new IngestError(
      "invalid_manifest",
      "record.parse_status is unsupported",
      400,
    );
  }
  return {
    record_index: integer(input.record_index, "record.record_index"),
    source_start_offset: integer(
      input.source_start_offset,
      "record.source_start_offset",
    ),
    source_end_offset: integer(
      input.source_end_offset,
      "record.source_end_offset",
      1,
    ),
    record_sha256: hash(input.record_sha256, "record.record_sha256"),
    native_type: boundedNullableText(
      input.native_type,
      "record.native_type",
      NATIVE_LABEL_BYTES,
    ),
    native_payload_type: boundedNullableText(
      input.native_payload_type,
      "record.native_payload_type",
      NATIVE_LABEL_BYTES,
    ),
    occurred_at: nullableTimestamp(input.occurred_at, "record.occurred_at"),
    parse_status: parseStatus as RecordLocator["parse_status"],
    native_record_start_offset: input.native_record_start_offset == null
      ? null
      : integer(
        input.native_record_start_offset,
        "record.native_record_start_offset",
      ),
    native_record_end_offset: input.native_record_end_offset == null
      ? null
      : integer(
        input.native_record_end_offset,
        "record.native_record_end_offset",
        1,
      ),
    native_record_sha256: input.native_record_sha256 == null
      ? null
      : hash(input.native_record_sha256, "record.native_record_sha256"),
    fragment_index: input.fragment_index == null
      ? null
      : integer(input.fragment_index, "record.fragment_index"),
    fragment_count: input.fragment_count == null
      ? null
      : integer(input.fragment_count, "record.fragment_count", 2),
  };
}

export function parseManifest(value: unknown): BatchManifest {
  const raw = object(value, "manifest");
  if (!Array.isArray(raw.records)) {
    throw new IngestError("invalid_manifest", "records must be an array", 400);
  }
  if (raw.records.length > MAX_RECORDS) {
    throw new IngestError(
      "payload_too_large",
      "record locator count exceeds v1 limits",
      413,
    );
  }
  const contractVersion = text(raw.contract_version, "contract_version");
  const sourceKind = text(raw.source_kind, "source_kind");
  const storageEncoding = text(raw.storage_encoding, "storage_encoding");
  if (contractVersion !== CONTRACT_VERSION || sourceKind !== "rollout") {
    throw new IngestError(
      "unsupported_contract",
      "only rollout batch v1 is accepted",
      400,
    );
  }
  if (storageEncoding !== "gzip") {
    throw new IngestError(
      "unsupported_encoding",
      "rollout batches must use gzip",
      400,
    );
  }
  const manifest: BatchManifest = {
    contract_version: CONTRACT_VERSION,
    source_kind: "rollout",
    source_stream_key: safeSegment(raw.source_stream_key, "source_stream_key"),
    generation_key: safeSegment(raw.generation_key, "generation_key"),
    generation_seq: integer(raw.generation_seq, "generation_seq"),
    start_offset: integer(raw.start_offset, "start_offset"),
    end_offset: integer(raw.end_offset, "end_offset", 1),
    source_byte_count: integer(raw.source_byte_count, "source_byte_count", 1),
    source_sha256: hash(raw.source_sha256, "source_sha256"),
    storage_encoding: "gzip",
    stored_byte_count: integer(raw.stored_byte_count, "stored_byte_count", 1),
    stored_sha256: hash(raw.stored_sha256, "stored_sha256"),
    record_count: integer(raw.record_count, "record_count", 1),
    records: raw.records.map(parseRecord),
    observed_native_session_id: boundedNullableText(
      raw.observed_native_session_id,
      "observed_native_session_id",
      IDENTITY_HINT_BYTES,
    ),
    first_occurred_at: nullableTimestamp(
      raw.first_occurred_at,
      "first_occurred_at",
    ),
    last_occurred_at: nullableTimestamp(
      raw.last_occurred_at,
      "last_occurred_at",
    ),
    codex_version: boundedNullableText(
      raw.codex_version,
      "codex_version",
      VERSION_HINT_BYTES,
    ),
    collector_version: boundedNullableText(
      raw.collector_version,
      "collector_version",
      VERSION_HINT_BYTES,
    ),
  };
  validateManifest(manifest);
  return manifest;
}

export function parseEnvelope(value: unknown): IngestEnvelope {
  const input = object(value, "request");
  return {
    collector: input.collector == null
      ? null
      : parseCollectorIdentity(input.collector),
    manifest: parseManifest(input.manifest),
    stored_payload: decodeBase64(input.stored_payload_base64),
  };
}

export async function parseBulkEnvelope(
  bytes: Uint8Array,
): Promise<IngestEnvelope[]> {
  if (bytes.byteLength < BULK_MAGIC.byteLength + 4) {
    throw new IngestError("invalid_request", "bulk request is truncated", 400);
  }
  for (let index = 0; index < BULK_MAGIC.byteLength; index++) {
    if (bytes[index] !== BULK_MAGIC[index]) {
      throw new IngestError(
        "invalid_request",
        "bulk request magic is invalid",
        400,
      );
    }
  }
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  let offset = BULK_MAGIC.byteLength;
  const itemCount = view.getUint32(offset);
  offset += 4;
  if (itemCount < 1 || itemCount > MAX_BULK_ITEMS) {
    throw new IngestError(
      "payload_too_large",
      `bulk request must contain 1-${MAX_BULK_ITEMS} batches`,
      413,
    );
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const envelopes: IngestEnvelope[] = [];
  let totalSourceBytes = 0;
  let totalManifestBytes = 0;
  for (let index = 0; index < itemCount; index++) {
    if (offset + 12 > bytes.byteLength) {
      throw new IngestError(
        "invalid_request",
        "bulk item header is truncated",
        400,
      );
    }
    const encodedManifestLength = view.getUint32(offset);
    const manifestLength = view.getUint32(offset + 4);
    const payloadLength = view.getUint32(offset + 8);
    offset += 12;
    if (
      encodedManifestLength < 1 ||
      manifestLength < 2 ||
      manifestLength > MAX_BULK_MANIFEST_BYTES ||
      payloadLength < 1 ||
      payloadLength > MAX_STORED_BYTES ||
      offset + encodedManifestLength + payloadLength > bytes.byteLength
    ) {
      throw new IngestError(
        "invalid_request",
        "bulk item lengths are invalid",
        400,
      );
    }
    totalManifestBytes += manifestLength;
    if (totalManifestBytes > MAX_BULK_MANIFEST_TOTAL_BYTES) {
      throw new IngestError(
        "payload_too_large",
        "bulk manifests exceed 20 MiB",
        413,
      );
    }
    const manifestBytes = await decompressManifestBounded(
      bytes.subarray(offset, offset + encodedManifestLength),
      manifestLength,
    );
    let rawMetadata: unknown;
    try {
      rawMetadata = JSON.parse(decoder.decode(manifestBytes));
    } catch {
      throw new IngestError(
        "invalid_manifest",
        `bulk manifest ${index} is invalid JSON`,
        400,
      );
    }
    offset += encodedManifestLength;
    const storedPayload = bytes.slice(offset, offset + payloadLength);
    offset += payloadLength;
    const metadata = object(rawMetadata, `bulk metadata ${index}`);
    const wrapped = "manifest" in metadata || "collector" in metadata;
    const collector = wrapped
      ? parseCollectorIdentity(metadata.collector)
      : null;
    const manifest = parseManifest(wrapped ? metadata.manifest : metadata);
    if (manifest.stored_byte_count !== storedPayload.byteLength) {
      throw new IngestError(
        "stored_integrity_mismatch",
        `bulk payload ${index} size does not match its manifest`,
        400,
      );
    }
    totalSourceBytes += manifest.source_byte_count;
    if (totalSourceBytes > MAX_BULK_SOURCE_BYTES) {
      throw new IngestError(
        "payload_too_large",
        "bulk uncompressed source exceeds 20 MiB",
        413,
      );
    }
    envelopes.push({ collector, manifest, stored_payload: storedPayload });
  }
  if (offset !== bytes.byteLength) {
    throw new IngestError(
      "invalid_request",
      "bulk request has trailing bytes",
      400,
    );
  }
  return envelopes;
}

async function decompressManifestBounded(
  encoded: Uint8Array,
  expectedBytes: number,
): Promise<Uint8Array> {
  try {
    const bytes = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
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
      if (total > expectedBytes || total > MAX_BULK_MANIFEST_BYTES) {
        await reader.cancel();
        throw new IngestError(
          "payload_too_large",
          "bulk manifest exceeds its declared size",
          413,
        );
      }
      chunks.push(value);
    }
    if (total !== expectedBytes) {
      throw new IngestError(
        "invalid_manifest",
        "bulk manifest size does not match its header",
        400,
      );
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
      "invalid_manifest",
      "bulk manifest is not valid gzip",
      400,
    );
  }
}

export function validateManifest(manifest: BatchManifest): void {
  if (
    manifest.source_byte_count > MAX_SOURCE_BYTES ||
    manifest.record_count > MAX_RECORDS
  ) {
    throw new IngestError(
      "payload_too_large",
      "source batch exceeds rollout v1 limits",
      413,
    );
  }
  if (
    manifest.end_offset <= manifest.start_offset ||
    manifest.source_byte_count !== manifest.end_offset - manifest.start_offset
  ) {
    throw new IngestError(
      "invalid_manifest",
      "batch range and source size disagree",
      400,
    );
  }
  if (
    manifest.record_count !== manifest.records.length ||
    manifest.records.length === 0
  ) {
    throw new IngestError(
      "invalid_manifest",
      "record_count must equal records",
      400,
    );
  }
  if (
    (manifest.first_occurred_at === null) !==
      (manifest.last_occurred_at === null)
  ) {
    throw new IngestError(
      "invalid_manifest",
      "occurred timestamp bounds must be paired",
      400,
    );
  }
  if (
    manifest.first_occurred_at !== null &&
    manifest.last_occurred_at !== null &&
    timestampMicros(manifest.first_occurred_at) >
      timestampMicros(manifest.last_occurred_at)
  ) {
    throw new IngestError(
      "invalid_manifest",
      "first_occurred_at must not be after last_occurred_at",
      400,
    );
  }
  let previousEnd: number | null = null;
  manifest.records.forEach((record, index) => {
    if (
      record.record_index !== index ||
      record.source_start_offset < manifest.start_offset ||
      record.source_end_offset <= record.source_start_offset ||
      record.source_end_offset > manifest.end_offset ||
      (previousEnd !== null && record.source_start_offset < previousEnd)
    ) {
      throw new IngestError(
        "invalid_manifest",
        "record ranges must be ordered, unique, and contained by the batch",
        400,
      );
    }
    previousEnd = record.source_end_offset;
    const fragmentFields = [
      record.native_record_start_offset,
      record.native_record_end_offset,
      record.native_record_sha256,
      record.fragment_index,
      record.fragment_count,
    ];
    if (record.parse_status === "fragment") {
      if (fragmentFields.some((value) => value === null)) {
        throw new IngestError(
          "invalid_manifest",
          "fragment record metadata must be complete",
          400,
        );
      }
      if (
        (record.native_record_start_offset as number) >
          record.source_start_offset ||
        record.source_end_offset >
          (record.native_record_end_offset as number) ||
        (record.fragment_index as number) >=
          (record.fragment_count as number) ||
        ((record.fragment_index as number) === 0) !==
          (record.source_start_offset ===
            (record.native_record_start_offset as number)) ||
        ((record.fragment_index as number) ===
            (record.fragment_count as number) - 1) !==
          (record.source_end_offset ===
            (record.native_record_end_offset as number))
      ) {
        throw new IngestError(
          "invalid_manifest",
          "fragment metadata does not contain the source range",
          400,
        );
      }
    } else if (fragmentFields.some((value) => value !== null)) {
      throw new IngestError(
        "invalid_manifest",
        "non-fragment records cannot include fragment metadata",
        400,
      );
    }
  });
}

export async function sha256Hex(value: Uint8Array): Promise<string> {
  const bytes = value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function storagePath(
  attribution: Attribution,
  manifest: BatchManifest,
): string {
  if (!SAFE_SEGMENT.test(attribution.collector_key)) {
    throw new IngestError(
      "invalid_configuration",
      "collector_key is not path-safe",
      500,
    );
  }
  return `workspaces/${attribution.workspace_id}/collectors/${attribution.collector_key}/${manifest.source_kind}/${manifest.source_stream_key}/generations/${manifest.generation_seq}-${manifest.generation_key}/${manifest.start_offset}-${manifest.end_offset}-${manifest.source_sha256}.jsonl.gz`;
}

export function receiptFromRow(row: Record<string, unknown>): CommittedReceipt {
  return {
    receipt_version: RECEIPT_VERSION,
    status: "committed",
    batch_id: String(row.id),
    workspace_id: String(row.workspace_id),
    person_id: String(row.person_id),
    collector_key: String(row.collector_key),
    source_kind: "rollout",
    source_stream_key: String(row.source_stream_key),
    generation_key: String(row.generation_key),
    generation_seq: Number(row.generation_seq),
    start_offset: Number(row.start_offset),
    end_offset: Number(row.end_offset),
    source_byte_count: Number(row.source_byte_count),
    source_sha256: String(row.source_sha256),
    storage_path: String(row.storage_path),
    stored_byte_count: Number(row.stored_byte_count),
    stored_sha256: String(row.stored_sha256),
    record_count: Number(row.record_count),
    contract_version: CONTRACT_VERSION,
    committed_at: new Date(String(row.committed_at)).toISOString(),
  };
}
