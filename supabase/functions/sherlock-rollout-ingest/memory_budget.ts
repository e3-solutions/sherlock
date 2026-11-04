import { IngestError } from "./contract.ts";

// A request this small may go ahead of waiting larger ones.
export const SMALL_REQUEST_BYTES = 1024 * 1024;

// Every request a worker serves shares its 256 MB. A batch needs a few times
// its body size while it is decoded and checked, so two large batches at
// once ended the worker ("Memory limit exceeded", 546) along with every small
// request it was serving. Requests reserve their body size here first; one
// request always runs, and others wait while the reserved total is too big.
export class MemoryBudget {
  private reserved = 0;
  private readonly waiting: Array<{
    bytes: number;
    grant: () => void;
  }> = [];

  constructor(readonly capacityBytes: number) {}

  get reservedBytes(): number {
    return this.reserved;
  }

  // Resolves with a release function, or rejects with 503 ingest_busy when
  // the reservation is not granted within waitMs.
  reserve(bytes: number, waitMs: number): Promise<() => void> {
    if (
      this.fits(bytes) &&
      (this.waiting.length === 0 || bytes <= SMALL_REQUEST_BYTES)
    ) {
      return Promise.resolve(this.take(bytes));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        bytes,
        grant: () => {
          clearTimeout(timer);
          resolve(this.take(bytes));
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        this.wake();
        reject(
          new IngestError(
            "ingest_busy",
            "this worker is busy with large batches; retry later",
            503,
          ),
        );
      }, Math.max(0, waitMs));
      this.waiting.push(entry);
    });
  }

  private fits(bytes: number): boolean {
    return this.reserved === 0 || this.reserved + bytes <= this.capacityBytes;
  }

  private take(bytes: number): () => void {
    this.reserved += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved -= bytes;
      this.wake();
    };
  }

  // Oldest first. Only small requests, which hold little and finish in
  // about a second, may pass a large one that does not fit yet; another
  // large one may not, so a large request cannot be starved.
  private wake(): void {
    let blocked = false;
    for (let index = 0; index < this.waiting.length;) {
      const { bytes } = this.waiting[index];
      const small = bytes <= SMALL_REQUEST_BYTES;
      if (this.fits(bytes) && (small || !blocked)) {
        this.waiting.splice(index, 1)[0].grant();
        continue;
      }
      if (!small) blocked = true;
      index += 1;
    }
  }
}
