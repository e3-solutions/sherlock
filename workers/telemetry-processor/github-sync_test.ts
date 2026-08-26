import {
  type CommitPair,
  lookupCommit,
  type LookupResult,
  syncPending,
} from "./github-sync.ts";

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error("assertion failed");
}

const pair: CommitPair = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  repositoryFullName: "e3-solutions/sherlock",
  commitSha: "a".repeat(40),
};

function storeFor(
  results: LookupResult[],
  pending = [pair, { ...pair, commitSha: "b".repeat(40) }],
) {
  return {
    pendingGithubCommitPairs(limit: number) {
      assert(limit === 26);
      return Promise.resolve(pending);
    },
    appendGithubLookup(result: LookupResult) {
      results.push(result);
      return Promise.resolve();
    },
  };
}

Deno.test("commit lookup accepts one exact PR and fails closed otherwise", async () => {
  const pull = {
    number: 57,
    state: "closed",
    base: { repo: { full_name: "E3-Solutions/Sherlock" } },
    closed_at: "2026-08-21T01:02:03Z",
    merged_at: "2026-08-21T01:02:02Z",
  };
  const cases: Array<[
    unknown,
    LookupResult["outcome"] | "error",
    (string | null)?,
  ]> = [
    [[], "none"],
    [[pull, { ...pull, number: 58 }], "ambiguous"],
    [[pull], "matched", "2026-08-21T01:02:02.000Z"],
    [
      [{ ...pull, state: "open", closed_at: null, merged_at: null }],
      "matched",
      null,
    ],
    [[{ ...pull, merged_at: null }], "error"],
    [[{ ...pull, base: { repo: { full_name: "other/repo" } } }], "error"],
    ["invalid", "error"],
  ];

  for (const [body, expected, terminalAt] of cases) {
    try {
      const result = await lookupCommit(
        pair,
        "secret",
        (url) => {
          assert(String(url).endsWith("/pulls?per_page=2"));
          return Promise.resolve(Response.json(body));
        },
      );
      assert(result.outcome === expected);
      if (expected === "matched") {
        assert(result.pullRequestNumber === 57);
        assert(result.pullRequestTerminalAt === terminalAt);
      }
    } catch {
      assert(expected === "error");
    }
  }
});

Deno.test("sync pauses globally without writing a pair failure", async () => {
  const now = 1_800_000_000_000;
  const cases = [
    [() => new Response(null, { status: 401 }), 401, null],
    [
      () =>
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
      429,
      now + 120_000,
    ],
    [
      () =>
        new Response(null, {
          status: 403,
          headers: {
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String((now + 180_000) / 1_000),
          },
        }),
      403,
      now + 180_000,
    ],
    [
      () =>
        Response.json(
          { message: "You have exceeded a secondary rate limit." },
          { status: 403 },
        ),
      403,
      null,
    ],
  ] as const;

  for (const [response, status, retryAtMs] of cases) {
    const results: LookupResult[] = [];
    const summary = await syncPending(storeFor(results), "secret", {
      fetcher: () => Promise.resolve(response()),
      now: () => now,
    });
    assert(results.length === 0);
    assert(summary.attempted === 1 && summary.failed === 0);
    assert(summary.backlogRemaining && summary.pause !== null);
    assert(summary.pause.status === status);
    assert(summary.pause.retryAtMs === retryAtMs);
  }
});

Deno.test("sync continues after pair-specific HTTP failures", async () => {
  const results: LookupResult[] = [];
  const summary = await syncPending(storeFor(results), "secret", {
    fetcher: () =>
      Promise.resolve(
        Response.json({ message: "Resource not accessible" }, { status: 403 }),
      ),
  });
  assert(summary.attempted === 2 && summary.failed === 2);
  assert(!summary.backlogRemaining && summary.pause === null);
  assert(
    results.length === 2 && results.every((row) => row.outcome === "failed"),
  );
});

Deno.test("sync processes 25 pairs and reports remaining backlog", async () => {
  const results: LookupResult[] = [];
  const pending = Array.from({ length: 26 }, (_, index) => ({
    ...pair,
    commitSha: index.toString(16).padStart(40, "0"),
  }));
  const summary = await syncPending(storeFor(results, pending), "secret", {
    fetcher: () => Promise.resolve(Response.json([])),
  });
  assert(summary.attempted === 25 && results.length === 25);
  assert(summary.backlogRemaining && summary.pause === null);
});

Deno.test("sync never converts a persistence error into a failed lookup", async () => {
  let appends = 0;
  let rejected = false;
  try {
    await syncPending(
      {
        pendingGithubCommitPairs: () => Promise.resolve([pair]),
        appendGithubLookup: () => {
          appends += 1;
          return Promise.reject(new Error("database unavailable"));
        },
      },
      "secret",
      { fetcher: () => Promise.resolve(Response.json([])) },
    );
  } catch {
    rejected = true;
  }
  assert(rejected && appends === 1);
});
