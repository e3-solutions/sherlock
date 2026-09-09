import {
  lookupPrContext,
  prContextRepositoryScope,
  type PrContextVerification,
  syncPrContexts,
} from "./pr-context-sync.ts";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
const workspace = "00000000-0000-4000-8000-000000000001";
const target = {
  workspaceId: workspace,
  sourceRecordId: "1",
  repositoryFullName: "e3-solutions/sherlock",
  pullRequestNumber: 91,
};
const scope = prContextRepositoryScope(`${workspace}=e3-solutions/sherlock`);
const pull = {
  id: 910,
  number: 91,
  state: "open",
  merged_at: null,
  closed_at: null,
  base: { repo: { id: 100, full_name: "E3-Solutions/Sherlock" } },
  head: { repo: { full_name: "fork/sherlock" }, ref: "reused" },
};
const forbiddenFetch: typeof fetch = () => {
  throw new Error("must never fetch");
};
Deno.test("PR identity lookup checks explicit workspace/repository scope before any network", async () => {
  for (
    const input of [
      { ...target, repositoryFullName: "private/secret" },
      { ...target, workspaceId: crypto.randomUUID() },
      { ...target, repositoryFullName: "https://127.0.0.1/secret" },
      { ...target, pullRequestNumber: -1 },
    ]
  ) {
    const v = await lookupPrContext(input, "secret", scope, forbiddenFetch);
    assert(v.outcome === "out_of_scope" && v.repositoryId === null);
  }
  assert(prContextRepositoryScope(undefined).size === 0);
});
Deno.test("direct PR endpoint pins base identity independent of fork/head/branch/commit", async () => {
  const v = await lookupPrContext(target, "secret", scope, (url, options) => {
    assert(
      String(url) ===
        "https://api.github.com/repos/e3-solutions/sherlock/pulls/91",
    );
    assert(options?.redirect === "manual");
    return Promise.resolve(Response.json(pull));
  });
  assert(
    v.outcome === "checked" && v.repositoryId === 100 &&
      v.pullRequestId === 910,
  );
});
Deno.test("closed-unmerged merged reopened PRs are checked declared context without allocation", async () => {
  for (
    const [changed, expected] of [[{}, "open"], [{
      state: "closed",
      closed_at: "2026-09-09T00:00:00Z",
    }, "closed"], [{
      state: "closed",
      closed_at: "2026-09-09T00:00:00Z",
      merged_at: "2026-09-09T00:00:00Z",
    }, "merged"]] as const
  ) {
    const v = await lookupPrContext(
      target,
      "secret",
      scope,
      () => Promise.resolve(Response.json({ ...pull, ...changed })),
    );
    assert(v.outcome === "checked" && v.pullRequestState === expected);
  }
});
Deno.test("canonical name and number mismatches never expose foreign metadata", async () => {
  for (
    const changed of [
      { number: 92 },
      { base: { repo: { id: 100, full_name: "private/secret" } } },
    ]
  ) {
    const v = await lookupPrContext(
      target,
      "secret",
      scope,
      () => Promise.resolve(Response.json({ ...pull, ...changed })),
    );
    assert(
      v.outcome === "identity_mismatch" && v.repositoryId === null &&
        v.pullRequestId === null,
    );
  }
});
Deno.test("renames redirects inaccessible and failures preserve only bounded outcomes", async () => {
  for (
    const [status, expected] of [[301, "identity_mismatch"], [
      404,
      "inaccessible",
    ], [500, "failed"]] as const
  ) {
    const v = await lookupPrContext(
      target,
      "secret",
      scope,
      () =>
        Promise.resolve(
          new Response("", {
            status,
            headers: { Location: "https://private/secret" },
          }),
        ),
    );
    assert(
      v.outcome === expected && v.repositoryId === null &&
        v.pullRequestState === null,
    );
  }
});
Deno.test("bounded worker keeps first failures retryable and pauses on token/rate rejection", async () => {
  const written: PrContextVerification[] = [];
  const store = {
    pendingPrContexts: () =>
      Promise.resolve(
        Array.from(
          { length: 26 },
          (_, i) => ({ ...target, sourceRecordId: String(i) }),
        ),
      ),
    appendPrContextVerification: (v: PrContextVerification) => {
      written.push(v);
      return Promise.resolve();
    },
  };
  const summary = await syncPrContexts(store, "secret", [workspace], scope, {
    fetcher: () => Promise.resolve(new Response("", { status: 500 })),
  });
  assert(
    summary.attempted === 25 && summary.failed === 25 &&
      summary.backlogRemaining && written.length === 25,
  );
  for (const status of [401, 429]) {
    const summary = await syncPrContexts(store, "secret", [workspace], scope, {
      fetcher: () => Promise.resolve(new Response("", { status })),
    });
    assert(summary.pause?.status === status && written.length === 25);
  }
});
Deno.test("disabled explicit scope does not scan store", async () => {
  const summary = await syncPrContexts(
    {
      pendingPrContexts: () => {
        throw new Error("must not query");
      },
      appendPrContextVerification: () => Promise.resolve(),
    },
    "secret",
    [workspace],
    new Map(),
  );
  assert(summary.attempted === 0);
});
Deno.test("explicit sync propagates persistence failures without inventing failed observations", async () => {
  let writes = 0, failed = false;
  try {
    await syncPrContexts(
      {
        pendingPrContexts: () => Promise.resolve([target]),
        appendPrContextVerification: () => {
          writes++;
          throw new Error("db down");
        },
      },
      "secret",
      [workspace],
      scope,
      { fetcher: () => Promise.resolve(Response.json(pull)) },
    );
  } catch {
    failed = true;
  }
  assert(failed && writes === 1);
});
