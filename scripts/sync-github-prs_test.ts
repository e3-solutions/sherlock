import {
  type CommitPair,
  lookupCommit,
  type LookupResult,
  type LookupStore,
  syncPending,
} from "./sync-github-prs.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

const pair: CommitPair = {
  repositoryFullName: "e3-solutions/sherlock",
  commitSha: "a".repeat(40),
};

function response(body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

Deno.test("exact commit lookup fails closed unless one candidate is valid", async () => {
  const cases: Array<{
    body: unknown;
    outcome?: LookupResult["outcome"];
    number?: number | null;
    error?: string;
    headers?: HeadersInit;
  }> = [
    { body: [], outcome: "none", number: null },
    { body: [{}, {}], outcome: "ambiguous", number: null },
    {
      body: [{
        number: 57,
        state: "closed",
        base: { repo: { full_name: "E3-Solutions/Sherlock" } },
        closed_at: "2026-08-21T01:02:03Z",
        merged_at: null,
      }],
      outcome: "matched",
      number: 57,
    },
    {
      body: [{
        number: 57,
        state: "open",
        base: { repo: { full_name: "e3-solutions/sherlock" } },
        closed_at: "2026-08-21T01:02:03Z",
        merged_at: null,
      }],
      error: "github_candidate_invalid",
    },
    {
      body: [{ number: 57, base: { repo: { full_name: "other/repo" } } }],
      error: "github_candidate_invalid",
    },
    { body: "not-an-array", error: "github_response_invalid" },
    {
      body: [],
      headers: { link: '<https://api.github.test/next>; rel="next"' },
      error: "github_response_paginated",
    },
  ];

  for (const testCase of cases) {
    try {
      const result = await lookupCommit(pair, {
        token: "secret",
        fetcher: () =>
          Promise.resolve(response(testCase.body, testCase.headers)),
      });
      assert(!testCase.error, `expected ${testCase.error}`);
      assert(result.outcome === testCase.outcome);
      assert(result.pullRequestNumber === testCase.number);
    } catch (error) {
      assert(testCase.error);
      assert(
        error instanceof Error && "code" in error &&
          error.code === testCase.error,
      );
    }
  }
});

class MemoryStore implements LookupStore {
  results: LookupResult[] = [];
  constructor(readonly pairs: CommitPair[]) {}
  withWorkspaceLock<T>(
    _workspaceId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    return run();
  }
  pendingPairs(_workspaceId: string, limit: number): Promise<CommitPair[]> {
    assert(limit === 25);
    return Promise.resolve(this.pairs);
  }
  append(_workspaceId: string, result: LookupResult): Promise<void> {
    this.results.push(result);
    return Promise.resolve();
  }
}

Deno.test("sync appends failures and stops a tick on rate limiting", async () => {
  const store = new MemoryStore([pair, { ...pair, commitSha: "b".repeat(40) }]);
  const result = await syncPending(store, {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    token: "secret",
    fetcher: () => Promise.resolve(new Response(null, { status: 429 })),
  });
  assert(result.attempted === 1 && result.failed === 1);
  assert(store.results[0].outcome === "failed");
  assert(store.results[0].errorCode === "github_http_429");
});
