import { IngestError, sha256Hex } from "./contract.ts";
import { SupabaseImmutableStorage } from "./storage.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

interface MockRun {
  get: () => Response;
  verify?: (request: RequestInfo | URL, init?: RequestInit) => void;
}

async function withConflictFetch(
  run: MockRun,
  action: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((request: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      assert(init?.method === "POST");
      return Promise.resolve(new Response("already exists", { status: 409 }));
    }
    assert(calls === 2, "Storage verification should issue one bounded GET");
    run.verify?.(request, init);
    return Promise.resolve(run.get());
  }) as typeof fetch;
  try {
    await action();
    assert(calls === 2, "expected one upload and one verification request");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function expectError(
  code: string,
  run: MockRun,
  bytes = new Uint8Array([1, 2, 3, 4]),
): Promise<void> {
  const storage = new SupabaseImmutableStorage(
    "https://example.supabase.co",
    "key",
  );
  await withConflictFetch(run, async () => {
    try {
      await storage.ensure("path/object.gz", bytes, await sha256Hex(bytes));
      assert(false, `${code} should be thrown`);
    } catch (error) {
      assert(error instanceof IngestError);
      assert(error.code === code, `received ${error.code}`);
    }
  });
}

Deno.test("409 verification accepts exact streamed bytes without Content-Length", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const hash = await sha256Hex(bytes);
  const storage = new SupabaseImmutableStorage(
    "https://example.supabase.co",
    "key",
  );
  await withConflictFetch({
    get: () =>
      new Response(
        ReadableStream.from([
          bytes.subarray(0, 1),
          bytes.subarray(1),
        ]),
        { status: 206 },
      ),
    verify: (_request, init) => {
      assert(new Headers(init?.headers).get("range") === "bytes=0-4");
    },
  }, () => storage.ensure("path/object.gz", bytes, hash));
});

Deno.test("409 verification does not trust a lying Content-Length", async () => {
  await expectError("storage_integrity_conflict", {
    get: () =>
      new Response(ReadableStream.from([new Uint8Array([1, 2, 3])]), {
        status: 206,
        headers: { "Content-Length": "4" },
      }),
  });
});

Deno.test("409 verification rejects declared length mismatch early", async () => {
  let cancelled = false;
  await expectError("storage_integrity_conflict", {
    get: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: 206,
          headers: { "Content-Length": "3" },
        },
      ),
  });
  assert(cancelled, "declared mismatch should cancel the response stream");
});

Deno.test("409 verification cancels an oversized response chunk", async () => {
  let cancelled = false;
  await expectError("storage_integrity_conflict", {
    get: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      ),
  });
  assert(
    cancelled,
    "long response should be cancelled after the first extra byte",
  );
});

Deno.test("409 verification rejects same-length different bytes", async () => {
  await expectError("storage_integrity_conflict", {
    get: () =>
      new Response(ReadableStream.from([new Uint8Array([4, 3, 2, 1])]), {
        status: 206,
        headers: { "Content-Length": "4" },
      }),
  });
});

Deno.test("409 verification maps response stream errors to verify failure", async () => {
  await expectError("storage_verify_failed", {
    get: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            throw new Error("read failed");
          },
        }),
        { status: 206 },
      ),
  });
});
