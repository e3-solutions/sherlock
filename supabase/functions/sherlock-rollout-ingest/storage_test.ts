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

const bytes = new Uint8Array([1, 2, 3, 4]);
const storage = new SupabaseImmutableStorage(
  "https://example.supabase.co",
  "key",
);

function streamedResponse(
  chunks: Uint8Array[],
  contentLength?: string,
): Response {
  return new Response(ReadableStream.from(chunks), {
    status: 206,
    headers: contentLength ? { "Content-Length": contentLength } : undefined,
  });
}

function cancellableResponse(
  chunk: Uint8Array,
  contentLength?: string,
): { response: Response; wasCancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, {
      status: contentLength ? 206 : 200,
      headers: contentLength ? { "Content-Length": contentLength } : undefined,
    }),
    wasCancelled: () => cancelled,
  };
}

async function ensureWithConflict(run: MockRun): Promise<void> {
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
    await storage.ensure("path/object.gz", bytes, await sha256Hex(bytes));
    assert(calls === 2, "expected one upload and one verification request");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function expectError(
  code: string,
  run: MockRun,
): Promise<void> {
  try {
    await ensureWithConflict(run);
    assert(false, `${code} should be thrown`);
  } catch (error) {
    assert(error instanceof IngestError);
    assert(error.code === code, `received ${error.code}`);
  }
}

Deno.test("409 verification accepts exact streamed bytes without Content-Length", async () => {
  await ensureWithConflict({
    get: () => streamedResponse([bytes.subarray(0, 1), bytes.subarray(1)]),
    verify: (_request, init) => {
      assert(new Headers(init?.headers).get("range") === "bytes=0-4");
    },
  });
});

Deno.test("409 verification does not trust a lying Content-Length", async () => {
  await expectError("storage_integrity_conflict", {
    get: () => streamedResponse([new Uint8Array([1, 2, 3])], "4"),
  });
});

Deno.test("409 verification rejects declared length mismatch early", async () => {
  const stream = cancellableResponse(new Uint8Array([1, 2, 3]), "3");
  await expectError("storage_integrity_conflict", {
    get: () => stream.response,
  });
  assert(
    stream.wasCancelled(),
    "declared mismatch should cancel the response stream",
  );
});

Deno.test("409 verification cancels an oversized response chunk", async () => {
  const stream = cancellableResponse(new Uint8Array(1024 * 1024));
  await expectError("storage_integrity_conflict", {
    get: () => stream.response,
  });
  assert(
    stream.wasCancelled(),
    "long response should be cancelled after the first extra byte",
  );
});

Deno.test("409 verification rejects same-length different bytes", async () => {
  await expectError("storage_integrity_conflict", {
    get: () => streamedResponse([new Uint8Array([4, 3, 2, 1])], "4"),
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
