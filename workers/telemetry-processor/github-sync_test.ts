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
const workspaceIds = [pair.workspaceId];

function storeFor(
  results: LookupResult[],
  pending = [pair, { ...pair, commitSha: "b".repeat(40) }],
) {
  return {
    pendingGithubCommitPairs(limit: number, allowed: readonly string[]) {
      assert(limit === 26);
      assert(allowed.length === 1 && allowed[0] === pair.workspaceId);
      return Promise.resolve(pending);
    },
    appendGithubLookup(result: LookupResult) {
      results.push(result);
      return Promise.resolve();
    },
  };
}

function sync(
  store: Parameters<typeof syncPending>[0],
  options: Parameters<typeof syncPending>[3] = {},
) {
  return syncPending(store, "secret", workspaceIds, options);
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
    [[{ ...pull, merged_at: null }], "matched", "2026-08-21T01:02:03.000Z"],
    [[{ ...pull, closed_at: null, merged_at: null }], "error"],
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
        assert(result.errorCode === null);
      }
    } catch {
      assert(expected === "error");
    }
  }
});

Deno.test("sync classifies only an exact commit-not-found 422", async () => {
  const cases = [
    [`No commit found for SHA: ${pair.commitSha}`, "commit_not_found"],
    ["No commit found for SHA: " + "b".repeat(40), "github_http_422"],
    ["Validation Failed", "github_http_422"],
  ] as const;

  for (const [message, expectedCode] of cases) {
    const results: LookupResult[] = [];
    const summary = await sync(storeFor(results, [pair]), {
      fetcher: () =>
        Promise.resolve(Response.json({ message }, { status: 422 })),
    });
    assert(summary.attempted === 1 && summary.failed === 1);
    assert(!summary.backlogRemaining && summary.pause === null);
    assert(
      results.length === 1 && results[0].outcome === "failed" &&
        results[0].errorCode === expectedCode,
    );
  }

  const malformed: LookupResult[] = [];
  await sync(storeFor(malformed, [pair]), {
    fetcher: () => Promise.resolve(new Response("not-json", { status: 422 })),
  });
  assert(
    malformed.length === 1 && malformed[0].outcome === "failed" &&
      malformed[0].errorCode === "github_http_422",
  );
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
    const summary = await sync(storeFor(results), {
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
  const summary = await sync(storeFor(results), {
    fetcher: () =>
      Promise.resolve(
        Response.json({ message: "Resource not accessible" }, { status: 403 }),
      ),
  });
  assert(summary.attempted === 2 && summary.failed === 2);
  assert(!summary.backlogRemaining && summary.pause === null);
  assert(
    results.length === 2 &&
      results.every((row) =>
        row.outcome === "failed" && row.errorCode === "github_http_403"
      ),
  );
});

Deno.test("sync processes 25 pairs and reports remaining backlog", async () => {
  const results: LookupResult[] = [];
  const pending = Array.from({ length: 26 }, (_, index) => ({
    ...pair,
    commitSha: index.toString(16).padStart(40, "0"),
  }));
  const summary = await sync(storeFor(results, pending), {
    fetcher: () => Promise.resolve(Response.json([])),
  });
  assert(summary.attempted === 25 && results.length === 25);
  assert(summary.backlogRemaining && summary.pause === null);
});

Deno.test("sync never converts a persistence error into a failed lookup", async () => {
  let appends = 0;
  let rejected = false;
  try {
    await sync(
      {
        pendingGithubCommitPairs: () => Promise.resolve([pair]),
        appendGithubLookup: () => {
          appends += 1;
          return Promise.reject(new Error("database unavailable"));
        },
      },
      { fetcher: () => Promise.resolve(Response.json([])) },
    );
  } catch {
    rejected = true;
  }
  assert(rejected && appends === 1);
});
