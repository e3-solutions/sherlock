import {
  type CommitPair,
  type CompleteLookup,
  type FailedLookup,
  GitHubSyncError,
  lookupCommit,
  type LookupStore,
  PENDING_PAIRS_SQL,
  type ReservedLookupConnection,
  syncPending,
  WorkspaceLockLease,
} from "./sync-github-prs.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function pull(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1001,
    number: 54,
    state: "closed",
    created_at: "2026-08-20T00:00:00Z",
    closed_at: "2026-08-21T00:00:00Z",
    merged_at: "2026-08-21T00:00:00Z",
    base: { repo: { id: 9001, full_name: "e3-solutions/sherlock" } },
    ...overrides,
  };
}

const pair: CommitPair = {
  repositoryFullName: "e3-solutions/sherlock",
  commitSha: "a".repeat(40),
};

function response(
  body: unknown,
  options: { status?: number; headers?: HeadersInit } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: options.headers,
  });
}

Deno.test("complete exact lookup validates identity and uses a bounded signal", async () => {
  let requested = "";
  let hasSignal = false;
  const lookup = await lookupCommit(pair, {
    token: "secret",
    fetcher: (input, init) => {
      requested = String(input);
      hasSignal = init?.signal instanceof AbortSignal;
      return Promise.resolve(response([pull()]));
    },
  });
  assert(requested.endsWith(`/commits/${"a".repeat(40)}/pulls?per_page=100`));
  assert(hasSignal);
  assert(lookup.githubRepositoryId === 9001);
  assert(lookup.candidates[0].pullRequestNumber === 54);
  assert(/^[0-9a-f]{64}$/.test(lookup.responseSha256));
});

Deno.test("pending selection is recent, versioned, and fair", () => {
  assert(PENDING_PAIRS_SQL.includes("projection_status = 'matched'"));
  assert(PENDING_PAIRS_SQL.includes("interval '26 hours'"));
  assert(PENDING_PAIRS_SQL.includes("sherlock.github-scm.v1"));
  assert(PENDING_PAIRS_SQL.includes("sherlock.github-associated-pulls.v1"));
  assert(
    PENDING_PAIRS_SQL.includes("order by (latest_attempt_id is not null)"),
  );
  assert(PENDING_PAIRS_SQL.includes("latest.retry_after <= now()"));
  assert(PENDING_PAIRS_SQL.includes("max(retry_after) retry_after"));
  assert(PENDING_PAIRS_SQL.includes("rate_gate.retry_after is null"));
});

Deno.test("pagination, repository mismatch, and malformed lifecycle fail closed", async () => {
  await assertRejects(
    () =>
      lookupCommit(pair, {
        token: "secret",
        fetcher: () =>
          Promise.resolve(response([pull()], {
            headers: {
              Link: '<https://api.github.com/example?page=2>; rel="next"',
            },
          })),
      }),
    "github_lookup_incomplete",
  );
  await assertRejects(
    () =>
      lookupCommit(pair, {
        token: "secret",
        fetcher: () =>
          Promise.resolve(response([pull({
            base: { repo: { id: 77, full_name: "fork-owner/sherlock" } },
          })])),
      }),
    "github_base_repository_mismatch",
  );
  await assertRejects(
    () =>
      lookupCommit(pair, {
        token: "secret",
        fetcher: () =>
          Promise.resolve(response([pull({
            state: "open",
            closed_at: "2026-08-21T00:00:00Z",
          })])),
      }),
    "github_pull_request_timeline_invalid",
  );
});

Deno.test("rate limits record retry time and stop the tick", async () => {
  const other = {
    repositoryFullName: "e3-solutions/other",
    commitSha: "b".repeat(40),
  };
  const store = new MemoryStore([pair, other]);
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await syncPending(store, {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      token: "secret",
      now: new Date("2026-08-21T10:00:00Z"),
      fetcher: () =>
        Promise.resolve(response({}, {
          status: 429,
          headers: { "Retry-After": "120" },
        })),
    });
    assert(result.attempted === 1);
    assert(result.failed === 1);
    assert(store.failures[0].httpStatus === 429);
    assert(store.failures[0].retryAfter === "2026-08-21T10:02:00.000Z");
  } finally {
    console.error = originalError;
  }
});

Deno.test("secondary rate-limit body creates a fallback pause and stops the tick", async () => {
  const other = {
    repositoryFullName: "e3-solutions/other",
    commitSha: "b".repeat(40),
  };
  const store = new MemoryStore([pair, other]);
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await syncPending(store, {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      token: "secret",
      now: new Date("2026-08-21T10:00:00Z"),
      fetcher: () =>
        Promise.resolve(response({
          message: `You have exceeded a secondary rate limit. ${
            "x".repeat(10_000)
          }`,
        }, { status: 403 })),
    });
    assert(result.attempted === 1 && result.failed === 1);
    assert(store.failures[0].httpStatus === 403);
    assert(store.failures[0].retryAfter === "2026-08-21T10:01:00.000Z");
  } finally {
    console.error = originalError;
  }
});

Deno.test("reserved workspace lock releases on false, error, and unlock", async () => {
  const denied = new FakeConnection(false);
  const deniedLease = new WorkspaceLockLease(() => Promise.resolve(denied));
  assert(!(await deniedLease.tryLock("workspace")));
  assert(denied.releases === 1);

  const failed = new FakeConnection(new Error("lock failed"));
  const failedLease = new WorkspaceLockLease(() => Promise.resolve(failed));
  let rejected = false;
  try {
    await failedLease.tryLock("workspace");
  } catch {
    rejected = true;
  }
  assert(rejected && failed.releases === 1);

  const acquired = new FakeConnection(true);
  const acquiredLease = new WorkspaceLockLease(() => Promise.resolve(acquired));
  assert(await acquiredLease.tryLock("workspace"));
  assert(acquiredLease.connection() === acquired);
  assert(acquired.releases === 0);
  await acquiredLease.unlock("workspace");
  assert(Number(acquired.unlocks) === 1 && Number(acquired.releases) === 1);
});

Deno.test("sync persists complete and failed attempts", async () => {
  const other = {
    repositoryFullName: "e3-solutions/other",
    commitSha: "b".repeat(40),
  };
  const store = new MemoryStore([pair, other]);
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await syncPending(store, {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      token: "secret",
      fetcher: (input) =>
        String(input).includes("other")
          ? Promise.resolve(response({}, { status: 409 }))
          : Promise.resolve(response([pull()])),
    });
    assert(
      result.attempted === 2 && result.inserted === 1 && result.failed === 1,
    );
    assert(store.completes.length === 1);
    assert(store.failures[0].errorCode === "github_lookup_http_409");
  } finally {
    console.error = originalError;
  }
});

Deno.test("sync rejects oversized batches and honors cancellation", async () => {
  const store = new MemoryStore([pair]);
  await assertRejects(
    () =>
      syncPending(store, {
        workspaceId: "00000000-0000-4000-8000-000000000001",
        token: "secret",
        limit: 26,
      }),
    "github_sync_limit_invalid",
  );
  const controller = new AbortController();
  controller.abort(new Error("shutdown"));
  let aborted = false;
  try {
    await syncPending(store, {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      token: "secret",
      signal: controller.signal,
    });
  } catch {
    aborted = true;
  }
  assert(aborted);
  assert(store.pendingCalls === 0);
});

Deno.test("sync does no work when another replica owns the workspace", async () => {
  const store = new MemoryStore([pair], false);
  const result = await syncPending(store, {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    token: "secret",
  });
  assert(result.attempted === 0 && store.pendingCalls === 0);
});

async function assertRejects(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert(error instanceof GitHubSyncError);
    assert(error.code === code, `expected ${code}, received ${error.code}`);
    return;
  }
  throw new Error(`expected ${code}`);
}

class MemoryStore implements LookupStore {
  readonly completes: CompleteLookup[] = [];
  readonly failures: FailedLookup[] = [];
  pendingCalls = 0;

  constructor(
    private readonly pairs: CommitPair[],
    private readonly lockAvailable = true,
  ) {}

  tryLock(): Promise<boolean> {
    return Promise.resolve(this.lockAvailable);
  }

  unlock(): Promise<void> {
    return Promise.resolve();
  }

  pendingPairs(): Promise<CommitPair[]> {
    this.pendingCalls += 1;
    return Promise.resolve(this.pairs);
  }

  appendComplete(_workspaceId: string, lookup: CompleteLookup): Promise<void> {
    this.completes.push(lookup);
    return Promise.resolve();
  }

  appendFailure(_workspaceId: string, failure: FailedLookup): Promise<void> {
    this.failures.push(failure);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeConnection implements ReservedLookupConnection {
  releases = 0;
  unlocks = 0;

  constructor(private readonly result: boolean | Error) {}

  unsafe(query: string): Promise<Record<string, unknown>[]> {
    if (query.includes("pg_try_advisory_lock")) {
      if (this.result instanceof Error) return Promise.reject(this.result);
      return Promise.resolve([{ locked: this.result }]);
    }
    if (query.includes("pg_advisory_unlock")) this.unlocks += 1;
    return Promise.resolve([]);
  }

  release(): void {
    this.releases += 1;
  }
}
