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

Deno.test("commit lookup accepts one exact PR and fails closed otherwise", async () => {
  const pull = {
    number: 57,
    state: "closed",
    base: { repo: { full_name: "E3-Solutions/Sherlock" } },
    closed_at: "2026-08-21T01:02:03Z",
    merged_at: "2026-08-21T01:02:02Z",
  };
  const cases: Array<[unknown, LookupResult["outcome"] | "error"]> = [
    [[], "none"],
    [[pull, { ...pull, number: 58 }], "ambiguous"],
    [[pull], "matched"],
    [[{ ...pull, merged_at: null }], "error"],
    [[{ ...pull, base: { repo: { full_name: "other/repo" } } }], "error"],
    [[{ ...pull, state: "open" }], "error"],
    ["invalid", "error"],
  ];

  for (const [body, expected] of cases) {
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
      if (expected === "matched") assert(result.pullRequestNumber === 57);
    } catch {
      assert(expected === "error");
    }
  }
});

Deno.test("sync records a failure and stops on rate limiting", async () => {
  const results: LookupResult[] = [];
  const store = {
    pendingGithubCommitPairs(limit: number) {
      assert(limit === 25);
      return Promise.resolve([pair, { ...pair, commitSha: "b".repeat(40) }]);
    },
    appendGithubLookup(result: LookupResult) {
      results.push(result);
      return Promise.resolve();
    },
  };
  const counts = await syncPending(store, "secret", {
    fetcher: () => Promise.resolve(new Response(null, { status: 429 })),
  });
  assert(counts.attempted === 1 && counts.failed === 1);
  assert(results[0].outcome === "failed");
});
