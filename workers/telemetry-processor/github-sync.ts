const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_SYNC_BATCH_SIZE = 25;

export interface CommitPair {
  workspaceId: string;
  repositoryFullName: string;
  commitSha: string;
}

export interface LookupResult extends CommitPair {
  outcome: "matched" | "none" | "ambiguous" | "failed";
  pullRequestNumber: number | null;
  pullRequestTerminalAt: string | null;
}

export interface LookupStore {
  pendingGithubCommitPairs(limit: number): Promise<CommitPair[]>;
  appendGithubLookup(result: LookupResult): Promise<void>;
}

export interface GithubSyncPause {
  status: 401 | 403 | 429;
  retryAtMs: number | null;
}

export interface GithubSyncSummary {
  attempted: number;
  failed: number;
  backlogRemaining: boolean;
  pause: GithubSyncPause | null;
}

class GitHubSyncError extends Error {
  constructor(
    readonly code: string,
    readonly pause: GithubSyncPause | null = null,
  ) {
    super(code);
  }
}

function outcome(
  pair: CommitPair,
  value: LookupResult["outcome"],
  pullRequestNumber: number | null = null,
  pullRequestTerminalAt: string | null = null,
): LookupResult {
  return {
    ...pair,
    outcome: value,
    pullRequestNumber,
    pullRequestTerminalAt,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new GitHubSyncError("invalid_pull");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new GitHubSyncError("invalid_pull");
  }
  return date.toISOString();
}

async function githubPause(
  response: Response,
  nowMs: number,
): Promise<GithubSyncPause | null> {
  const status = response.status;
  if (status === 401) {
    return { status, retryAtMs: null };
  }
  if (status !== 403 && status !== 429) return null;

  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
    const parsed = seconds === null
      ? Date.parse(retryAfter)
      : nowMs + seconds * 1_000;
    return {
      status,
      retryAtMs: Number.isFinite(parsed) ? Math.max(nowMs, parsed) : null,
    };
  }
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = response.headers.get("x-ratelimit-reset");
    const parsed = reset !== null && /^\d+$/.test(reset)
      ? Number(reset) * 1_000
      : NaN;
    return {
      status,
      retryAtMs: Number.isFinite(parsed) ? Math.max(nowMs, parsed) : null,
    };
  }
  if (status === 429) {
    return { status, retryAtMs: null };
  }

  let message = "";
  try {
    const body = record(await response.json());
    if (typeof body?.message === "string") message = body.message.slice(0, 512);
  } catch {
    // An ordinary, unstructured 403 is scoped to this repository.
  }
  return /rate limit|abuse detection/i.test(message)
    ? { status, retryAtMs: null }
    : null;
}

export async function lookupCommit(
  pair: CommitPair,
  token: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<LookupResult> {
  const [owner, repository] = pair.repositoryFullName.split("/");
  const url = "https://api.github.com/repos/" + encodeURIComponent(owner) +
    "/" + encodeURIComponent(repository) + "/commits/" + pair.commitSha +
    "/pulls?per_page=2";
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetcher(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "sherlock-github-pr-sync",
    },
  });
  if (!response.ok) {
    throw new GitHubSyncError(
      "github_http_" + response.status,
      await githubPause(response, now()),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GitHubSyncError("invalid_response");
  }
  if (!Array.isArray(body) || body.length > 2) {
    throw new GitHubSyncError("invalid_response");
  }
  if (body.length === 0) return outcome(pair, "none");
  if (body.length === 2) return outcome(pair, "ambiguous");

  const pull = record(body[0]);
  const baseRepository = record(record(pull?.base)?.repo);
  const baseRepositoryName = baseRepository?.full_name;
  const number = pull?.number;
  const state = pull?.state;
  const closedAt = timestamp(pull?.closed_at);
  const mergedAt = timestamp(pull?.merged_at);
  if (
    typeof baseRepositoryName !== "string" ||
    baseRepositoryName.toLowerCase() !==
      pair.repositoryFullName ||
    !Number.isSafeInteger(number) || Number(number) < 1 ||
    (state !== "open" && state !== "closed") ||
    (state === "open" && (closedAt || mergedAt)) ||
    (state === "closed" && (!closedAt || !mergedAt)) ||
    (mergedAt && mergedAt > closedAt!)
  ) throw new GitHubSyncError("invalid_pull");

  return outcome(pair, "matched", Number(number), mergedAt);
}

export async function syncPending(
  store: LookupStore,
  token: string,
  options: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    onError?: (error: unknown, pair: CommitPair) => void;
    now?: () => number;
  } = {},
): Promise<GithubSyncSummary> {
  const counts = { attempted: 0, failed: 0 };
  let pause: GithubSyncPause | null = null;
  options.signal?.throwIfAborted();
  const pending = await store.pendingGithubCommitPairs(
    GITHUB_SYNC_BATCH_SIZE + 1,
  );
  for (const pair of pending.slice(0, GITHUB_SYNC_BATCH_SIZE)) {
    options.signal?.throwIfAborted();
    counts.attempted += 1;
    let result: LookupResult;
    try {
      result = await lookupCommit(
        pair,
        token,
        options.fetcher,
        options.signal,
        options.now,
      );
    } catch (error) {
      if (options.signal?.aborted) options.signal.throwIfAborted();
      if (error instanceof GitHubSyncError && error.pause) {
        pause = error.pause;
        break;
      }
      options.onError?.(error, pair);
      counts.failed += 1;
      await store.appendGithubLookup(outcome(pair, "failed"));
      continue;
    }
    await store.appendGithubLookup(result);
  }
  return {
    ...counts,
    backlogRemaining: pause !== null || pending.length > GITHUB_SYNC_BATCH_SIZE,
    pause,
  };
}
