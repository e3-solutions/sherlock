import { IngestError, sha256Hex } from "./contract.ts";
import {
  STORAGE_ATTEMPTS,
  STORAGE_COMMIT_RESERVE_MS,
  STORAGE_MAX_ATTEMPT_MS,
  STORAGE_MIN_ATTEMPT_MS,
  SupabaseImmutableStorage,
} from "./storage.ts";

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

type Fetcher = typeof fetch;

function timedOut(): Promise<Response> {
  return Promise.reject(
    new DOMException("The signal has been aborted", "TimeoutError"),
  );
}

async function expectUnavailable(work: Promise<void>): Promise<void> {
  try {
    await work;
    assert(false, "storage_unavailable should be thrown");
  } catch (error) {
    assert(error instanceof IngestError, `received ${error}`);
    assert(error.code === "storage_unavailable", `received ${error.code}`);
    assert(error.status === 503, `received ${error.status}`);
  }
}

Deno.test("a hung upload is aborted at its budget, not left to the request deadline", async () => {
  let posts = 0;
  const hung: Fetcher = (_request, init) => {
    posts += 1;
    return new Promise((_, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
      );
    });
  };
  const startedAt = performance.now();
  // 5.1 s left: one 2.1 s attempt fits before the commit reserve.
  const remainingMs = () => 5_100 - (performance.now() - startedAt);
  await expectUnavailable(
    new SupabaseImmutableStorage("https://example.supabase.co", "key", hung)
      .ensure("path/object.gz", bytes, await sha256Hex(bytes), remainingMs),
  );
  const elapsed = performance.now() - startedAt;
  assert(posts === 1, `expected one attempt, made ${posts}`);
  assert(elapsed >= 2_000 && elapsed < 4_500, `aborted after ${elapsed} ms`);
});

Deno.test("a timed-out upload is not written a second time", async () => {
  let posts = 0;
  const fetcher: Fetcher = (_request, init) => {
    posts += 1;
    assert(init?.signal instanceof AbortSignal, "every attempt needs a limit");
    return timedOut();
  };
  await expectUnavailable(
    new SupabaseImmutableStorage("https://example.supabase.co", "key", fetcher)
      .ensure("path/object.gz", bytes, await sha256Hex(bytes), () => 18_000),
  );
  assert(posts === 1, `expected one attempt, made ${posts}`);
});

Deno.test("a connection failure or rate limit is retried once and can succeed", async () => {
  for (
    const first of [
      () => Promise.reject(new TypeError("error sending request")),
      () => Promise.resolve(new Response("slow down", { status: 429 })),
    ]
  ) {
    let posts = 0;
    const fetcher: Fetcher = () => {
      posts += 1;
      return posts === 1 ? first() : Promise.resolve(new Response("{}"));
    };
    await new SupabaseImmutableStorage(
      "https://example.supabase.co",
      "key",
      fetcher,
    ).ensure("path/object.gz", bytes, await sha256Hex(bytes), () => 18_000);
    assert(posts === 2, `expected two attempts, made ${posts}`);
  }
});

Deno.test("an unexpected upload error is not hidden as a 503", async () => {
  const fetcher: Fetcher = () => Promise.reject(new RangeError("bug"));
  let thrown: unknown = null;
  try {
    await new SupabaseImmutableStorage(
      "https://example.supabase.co",
      "key",
      fetcher,
    ).ensure("path/object.gz", bytes, await sha256Hex(bytes), () => 18_000);
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof RangeError, `received ${thrown}`);
});

Deno.test("a Storage 5xx is retried and the second failure answers 503", async () => {
  let posts = 0;
  const fetcher: Fetcher = () => {
    posts += 1;
    return Promise.resolve(new Response("upstream", { status: 504 }));
  };
  await expectUnavailable(
    new SupabaseImmutableStorage("https://example.supabase.co", "key", fetcher)
      .ensure("path/object.gz", bytes, await sha256Hex(bytes), () => 18_000),
  );
  assert(posts === STORAGE_ATTEMPTS, `made ${posts} attempts`);
});

Deno.test("a retry after a failed upload that did store verifies the object", async () => {
  const methods: string[] = [];
  const fetcher: Fetcher = (_request, init) => {
    methods.push(init?.method ?? "GET");
    if (methods.length === 1) {
      return Promise.resolve(new Response("gateway", { status: 502 }));
    }
    if (methods.length === 2) {
      return Promise.resolve(
        new Response('{"error":"Duplicate","message":"already exists"}', {
          status: 400,
        }),
      );
    }
    return Promise.resolve(streamedResponse([bytes], "4"));
  };
  await new SupabaseImmutableStorage(
    "https://example.supabase.co",
    "key",
    fetcher,
  )
    .ensure("path/object.gz", bytes, await sha256Hex(bytes), () => 18_000);
  assert(
    methods.join(",") === "POST,POST,GET",
    `unexpected calls ${methods.join(",")}`,
  );
});

Deno.test("no upload starts without time for it and the commit", async () => {
  let calls = 0;
  const fetcher: Fetcher = () => {
    calls += 1;
    return Promise.resolve(new Response("{}"));
  };
  await expectUnavailable(
    new SupabaseImmutableStorage("https://example.supabase.co", "key", fetcher)
      .ensure(
        "path/object.gz",
        bytes,
        await sha256Hex(bytes),
        () => STORAGE_COMMIT_RESERVE_MS + STORAGE_MIN_ATTEMPT_MS - 1,
      ),
  );
  assert(calls === 0, `made ${calls} calls`);
});

Deno.test("an attempt never runs into the commit reserve", async () => {
  const limits: number[] = [];
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds: number) => {
    limits.push(milliseconds);
    return realTimeout.call(AbortSignal, milliseconds);
  };
  try {
    const ok: Fetcher = () => Promise.resolve(new Response("{}"));
    const storage = new SupabaseImmutableStorage(
      "https://example.supabase.co",
      "key",
      ok,
    );
    const sha = await sha256Hex(bytes);
    await storage.ensure("a", bytes, sha, () => 18_000);
    await storage.ensure("b", bytes, sha, () => 6_000);
    await storage.ensure("c", bytes, sha);
  } finally {
    AbortSignal.timeout = realTimeout;
  }
  assert(
    limits.join(",") === `15000,3000,${STORAGE_MAX_ATTEMPT_MS}`,
    `limits were ${limits.join(",")}`,
  );
});
