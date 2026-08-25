import { IngestError, sha256Hex } from "./contract.ts";
import type { ImmutableStorage } from "./service.ts";

const STORAGE_BUCKET = "telemetry-raw";
const MAX_STORAGE_ERROR_BYTES = 4 * 1024;

function objectUrl(supabaseUrl: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${supabaseUrl}/storage/v1/object/${STORAGE_BUCKET}/${encoded}`;
}

function integrityConflict(): IngestError {
  return new IngestError(
    "storage_integrity_conflict",
    "existing immutable Storage object has different bytes",
    409,
  );
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The integrity error remains authoritative if cancellation also fails.
  }
}

async function boundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maximumBytes);
  let received = 0;
  try {
    while (received < maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const copied = Math.min(maximumBytes - received, value.byteLength);
      bytes.set(value.subarray(0, copied), received);
      received += copied;
      if (copied < value.byteLength) {
        await reader.cancel();
        break;
      }
    }
    if (received === maximumBytes) await reader.cancel();
  } catch {
    try {
      await reader.cancel();
    } catch {
      // A missing diagnostic body must not hide the upload status.
    }
  }
  return new TextDecoder().decode(bytes.subarray(0, received));
}

async function readExistingBytes(
  response: Response,
  expectedLength: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = /^\d+$/.test(declaredLength)
      ? Number(declaredLength)
      : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed !== expectedLength) {
      await cancelBody(response);
      throw integrityConflict();
    }
  }

  if (response.body === null) {
    if (expectedLength === 0) return new Uint8Array();
    throw integrityConflict();
  }

  const bytes = new Uint8Array(expectedLength);
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = expectedLength - received;
      if (remaining > 0) {
        bytes.set(
          value.subarray(0, Math.min(remaining, value.byteLength)),
          received,
        );
      }
      received += Math.min(value.byteLength, remaining + 1);
      if (received > expectedLength) {
        await reader.cancel();
        throw integrityConflict();
      }
    }
  } catch (error) {
    if (error instanceof IngestError) throw error;
    try {
      await reader.cancel();
    } catch {
      // Preserve the read failure below.
    }
    throw new IngestError(
      "storage_verify_failed",
      "existing Storage object could not be read",
      503,
    );
  }

  if (received !== expectedLength) throw integrityConflict();
  return bytes;
}

export class SupabaseImmutableStorage implements ImmutableStorage {
  constructor(
    private readonly supabaseUrl: string,
    private readonly serviceRoleKey: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
    };
  }

  async ensure(
    path: string,
    bytes: Uint8Array,
    storedSha256: string,
  ): Promise<void> {
    const response = await fetch(objectUrl(this.supabaseUrl, path), {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/gzip",
        "Cache-Control": "private, max-age=31536000, immutable",
        "x-upsert": "false",
      },
      // Deno 2.5's Linux DOM types narrow BodyInit more than the runtime.
      body: bytes as BodyInit,
    });
    if (response.ok) return;
    const alreadyExists = response.status === 409;
    if (alreadyExists) await cancelBody(response);
    const detail = alreadyExists
      ? ""
      : await boundedResponseText(response, MAX_STORAGE_ERROR_BYTES);
    const duplicate = alreadyExists ||
      (response.status === 400 && /already exists|duplicate/i.test(detail));
    if (!duplicate) {
      throw new IngestError(
        "storage_upload_failed",
        `immutable Storage upload failed (${response.status})`,
        response.status >= 500 ? 503 : 500,
      );
    }
    const existing = await fetch(objectUrl(this.supabaseUrl, path), {
      headers: {
        ...this.headers(),
        // The inclusive end requests at most the expected bytes plus one, so a
        // longer object is detectable without downloading the remainder.
        Range: `bytes=0-${bytes.byteLength}`,
      },
    });
    if (!existing.ok) {
      await cancelBody(existing);
      if (existing.status === 416) throw integrityConflict();
      throw new IngestError(
        "storage_verify_failed",
        `existing Storage object could not be read (${existing.status})`,
        503,
      );
    }
    const existingBytes = await readExistingBytes(existing, bytes.byteLength);
    if (
      (await sha256Hex(existingBytes)) !== storedSha256
    ) {
      throw integrityConflict();
    }
  }
}
