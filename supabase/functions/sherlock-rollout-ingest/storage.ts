import { IngestError, sha256Hex } from "./contract.ts";
import type { ImmutableStorage } from "./service.ts";

function objectUrl(supabaseUrl: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${supabaseUrl}/storage/v1/object/telemetry-raw/${encoded}`;
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
      body: bytes,
    });
    if (response.ok) return;
    const detail = await response.text();
    const alreadyExists = response.status === 409 ||
      (response.status === 400 && /already exists|duplicate/i.test(detail));
    // Storage documents concurrent create-only uploads as an already-exists
    // response. In practice, a losing insert can surface as a 5xx after the
    // winning request has committed the object. Treat that ambiguous result as
    // idempotent only after reading and hashing the immutable object.
    const mayHaveCommitted = alreadyExists || response.status >= 500;
    if (!mayHaveCommitted) {
      throw new IngestError(
        "storage_upload_failed",
        `immutable Storage upload failed (${response.status})`,
        500,
      );
    }
    const existing = await fetch(objectUrl(this.supabaseUrl, path), {
      headers: this.headers(),
    });
    if (!existing.ok) {
      throw new IngestError(
        alreadyExists ? "storage_verify_failed" : "storage_upload_failed",
        alreadyExists
          ? `existing Storage object could not be read (${existing.status})`
          : `immutable Storage upload failed (${response.status})`,
        503,
      );
    }
    const existingBytes = new Uint8Array(await existing.arrayBuffer());
    if (
      existingBytes.byteLength !== bytes.byteLength ||
      (await sha256Hex(existingBytes)) !== storedSha256
    ) {
      throw new IngestError(
        "storage_integrity_conflict",
        "existing immutable Storage object has different bytes",
        409,
      );
    }
  }
}
