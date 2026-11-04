import { IngestError, sha256Hex } from "./contract.ts";
import type { ImmutableStorage } from "./service.ts";

const STORAGE_BUCKET = "telemetry-raw";
const MAX_STORAGE_ERROR_BYTES = 4 * 1024;
// Storage object writes stall for tens of minutes at a time (Nov 2 19:30-22:30
// and Nov 4 18:00 UTC: write p50 3-12 s, p99 ~60 s, while reads and duplicate
// rejections stayed fast). An upload left to run into the request deadline
// also retired the isolate's shared database client, so it now ends early
// enough to answer 503 storage_unavailable with time kept for the commit.
// Only a fast failure is retried: an upload aborted here keeps running in
// Storage, so a second write after a timeout would queue behind the first.
export const STORAGE_ATTEMPTS = 2;
// Time kept back for the batch commit after the object is stored.
export const STORAGE_COMMIT_RESERVE_MS = 3_000;
// A shorter attempt than this is not worth starting.
export const STORAGE_MIN_ATTEMPT_MS = 2_000;
// Storage itself gives up on a write after 60 s.
export const STORAGE_MAX_ATTEMPT_MS = 60_000;
// Rate limits and gateway answers Storage gives while degraded.
const TRANSIENT_STATUSES = new Set([408, 429]);

export type RemainingMs = () => number;

function storageUnavailable(reason: string): IngestError {
  return new IngestError(
    "storage_unavailable",
    `Storage did not accept the batch in time (${reason}); retry later`,
    503,
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError");
}

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
    // Looked up per call so tests that replace globalThis.fetch still apply.
    private readonly fetcher: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
    };
  }

  // Milliseconds the next Storage call may take, or null when too little of
  // the request is left to start one.
  private attemptBudgetMs(remainingMs: RemainingMs): number | null {
    const budget = Math.floor(Math.min(
      STORAGE_MAX_ATTEMPT_MS,
      remainingMs() - STORAGE_COMMIT_RESERVE_MS,
    ));
    return budget >= STORAGE_MIN_ATTEMPT_MS ? budget : null;
  }

  // An immutable POST is safe to repeat: if the failed attempt did store the
  // object, the retry gets a duplicate answer and verifies the bytes.
  private async upload(
    path: string,
    bytes: Uint8Array,
    remainingMs: RemainingMs,
  ): Promise<Response> {
    let budget = this.attemptBudgetMs(remainingMs);
    for (let attempt = 1;; attempt += 1) {
      if (budget === null) throw storageUnavailable("no time left");
      let reason: string;
      let retryable = true;
      try {
        const response = await this.fetcher(
          objectUrl(this.supabaseUrl, path),
          {
            method: "POST",
            headers: {
              ...this.headers(),
              "Content-Type": "application/gzip",
              "Cache-Control": "private, max-age=31536000, immutable",
              "x-upsert": "false",
            },
            // Deno 2.5's Linux DOM types narrow BodyInit more than the runtime.
            body: bytes as BodyInit,
            signal: AbortSignal.timeout(budget),
          },
        );
        if (
          response.status < 500 && !TRANSIENT_STATUSES.has(response.status)
        ) {
          return response;
        }
        await cancelBody(response);
        reason = `upload answered ${response.status}`;
      } catch (error) {
        if (isAbort(error)) {
          reason = `upload took over ${budget} ms`;
          retryable = false;
        } else if (error instanceof TypeError) {
          // fetch reports DNS, TLS and connection failures as TypeError.
          reason = `upload request failed: ${error.message}`;
        } else {
          throw error;
        }
      }
      budget = retryable && attempt < STORAGE_ATTEMPTS
        ? this.attemptBudgetMs(remainingMs)
        : null;
      console.error(
        `storage upload attempt ${attempt} failed: ${reason}${
          budget === null ? "" : ", retrying"
        }`,
      );
      if (budget === null) throw storageUnavailable(reason);
    }
  }

  async ensure(
    path: string,
    bytes: Uint8Array,
    storedSha256: string,
    remainingMs: RemainingMs = () => Number.POSITIVE_INFINITY,
  ): Promise<void> {
    const response = await this.upload(path, bytes, remainingMs);
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
        500,
      );
    }
    const verifyBudget = this.attemptBudgetMs(remainingMs);
    if (verifyBudget === null) throw storageUnavailable("no time to verify");
    let existing: Response;
    try {
      existing = await this.fetcher(objectUrl(this.supabaseUrl, path), {
        headers: {
          ...this.headers(),
          // The inclusive end requests at most the expected bytes plus one, so
          // a longer object is detectable without downloading the remainder.
          Range: `bytes=0-${bytes.byteLength}`,
        },
        signal: AbortSignal.timeout(verifyBudget),
      });
    } catch (error) {
      throw new IngestError(
        "storage_verify_failed",
        isAbort(error)
          ? "existing Storage object could not be read in time"
          : "existing Storage object could not be read",
        503,
      );
    }
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
