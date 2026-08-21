import postgres from "npm:postgres@3.4.7";

export const GITHUB_LOOKUP_VERSION = "sherlock.github-associated-pulls.v1";
export const GITHUB_API_VERSION = "2026-03-10";
const SCM_SOURCE_VERSION = "sherlock.github-scm.v1";

export interface CommitPair {
  repositoryFullName: string;
  commitSha: string;
}

export interface LookupResult extends CommitPair {
  outcome: "matched" | "none" | "ambiguous" | "failed";
  candidateCount: number | null;
  pullRequestNumber: number | null;
  pullRequestTerminalAt: string | null;
  errorCode: string | null;
}

export interface LookupStore {
  withWorkspaceLock<T>(
    workspaceId: string,
    run: () => Promise<T>,
  ): Promise<T | null>;
  pendingPairs(workspaceId: string, limit: number): Promise<CommitPair[]>;
  append(workspaceId: string, result: LookupResult): Promise<void>;
}
export class GitHubSyncError extends Error {
  constructor(readonly code: string, readonly status: number | null = null) {
    super(code);
  }
}

export const PENDING_PAIRS_SQL = `with observed as (
  select repository_full_name, commit_sha
    from telemetry.session_scm
   where workspace_id = $1
     and source_version = '${SCM_SOURCE_VERSION}'
     and observed_at >= now() - interval '26 hours'
   group by repository_full_name, commit_sha
), due as (
  select observed.*, latest.id latest_id
    from observed
    left join lateral (
      select id, created_at
        from github.commit_pr_lookups
       where workspace_id = $1
         and source_version = '${GITHUB_LOOKUP_VERSION}'
         and repository_full_name = observed.repository_full_name
         and commit_sha = observed.commit_sha
       order by id desc
       limit 1
    ) latest on true
   where latest.id is null or latest.created_at < now() - interval '10 minutes'
)
select repository_full_name, commit_sha
  from due
 order by (latest_id is not null), latest_id, repository_full_name, commit_sha
 limit $2`;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function result(
  pair: CommitPair,
  outcome: LookupResult["outcome"],
  candidateCount: number | null,
  pullRequestNumber: number | null = null,
  pullRequestTerminalAt: string | null = null,
  errorCode: string | null = null,
): LookupResult {
  return {
    ...pair,
    outcome,
    candidateCount,
    pullRequestNumber,
    pullRequestTerminalAt,
    errorCode,
  };
}

function timestamp(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new GitHubSyncError(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new GitHubSyncError(code);
  return parsed.toISOString();
}

export async function lookupCommit(
  pair: CommitPair,
  options: {
    token: string;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<LookupResult> {
  const [owner, repository] = pair.repositoryFullName.split("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${
    encodeURIComponent(repository)
  }/commits/${pair.commitSha}/pulls?per_page=100`;
  const timeout = AbortSignal.timeout(30_000);
  const response = await (options.fetcher ?? fetch)(url, {
    signal: options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "sherlock-github-pr-sync",
    },
  });
  if (!response.ok) {
    throw new GitHubSyncError(
      `github_http_${response.status}`,
      response.status,
    );
  }
  if (/;\s*rel="next"/.test(response.headers.get("link") ?? "")) {
    throw new GitHubSyncError("github_response_paginated", response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GitHubSyncError("github_response_invalid", response.status);
  }
  if (!Array.isArray(body) || body.length > 100) {
    throw new GitHubSyncError("github_response_invalid", response.status);
  }
  if (body.length === 0) {
    return result(pair, "none", 0);
  }
  if (body.length > 1) {
    return result(pair, "ambiguous", body.length);
  }

  const pull = objectValue(body[0]);
  const baseRepository = objectValue(objectValue(pull?.base)?.repo);
  const number = pull?.number;
  const state = pull?.state;
  if (
    typeof baseRepository?.full_name !== "string" ||
    baseRepository.full_name.toLowerCase() !== pair.repositoryFullName ||
    !Number.isSafeInteger(number) || Number(number) < 1 ||
    (state !== "open" && state !== "closed")
  ) throw new GitHubSyncError("github_candidate_invalid", response.status);
  const closedAt = timestamp(pull?.closed_at, "github_candidate_invalid");
  const mergedAt = timestamp(pull?.merged_at, "github_candidate_invalid");
  if (
    (state === "open" && (closedAt || mergedAt)) ||
    (state === "closed" && !closedAt) ||
    (mergedAt && mergedAt > closedAt!)
  ) throw new GitHubSyncError("github_candidate_invalid", response.status);
  return result(pair, "matched", 1, Number(number), mergedAt ?? closedAt);
}

export class PostgresLookupStore implements LookupStore {
  private connection:
    | Awaited<
      ReturnType<ReturnType<typeof postgres>["reserve"]>
    >
    | null = null;

  private constructor(private readonly sql: ReturnType<typeof postgres>) {}

  static connect(databaseUrl: string): PostgresLookupStore {
    return new PostgresLookupStore(postgres(databaseUrl, {
      prepare: false,
      max: 2,
      idle_timeout: 20,
    }));
  }

  async withWorkspaceLock<T>(
    workspaceId: string,
    run: () => Promise<T>,
  ): Promise<T | null> {
    const connection = await this.sql.reserve();
    try {
      const rows = await connection.unsafe(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) locked",
        [`sherlock:github-sync:${workspaceId}`],
      );
      if (rows[0]?.locked !== true) return null;
      try {
        await connection.unsafe("set role sherlock_github_sync");
        this.connection = connection;
        return await run();
      } finally {
        this.connection = null;
        try {
          await connection.unsafe("reset role");
        } finally {
          await connection.unsafe(
            "select pg_advisory_unlock(hashtextextended($1, 0))",
            [`sherlock:github-sync:${workspaceId}`],
          );
        }
      }
    } finally {
      connection.release();
    }
  }

  async pendingPairs(
    workspaceId: string,
    limit: number,
  ): Promise<CommitPair[]> {
    const rows = await this.runAsSyncRole(PENDING_PAIRS_SQL, [
      workspaceId,
      limit,
    ]);
    return rows.map((row) => ({
      repositoryFullName: String(row.repository_full_name),
      commitSha: String(row.commit_sha),
    }));
  }

  async append(workspaceId: string, result: LookupResult): Promise<void> {
    await this.runAsSyncRole(
      `insert into github.commit_pr_lookups (
         workspace_id, source_version, repository_full_name, commit_sha,
         outcome, candidate_count, pull_request_number,
         pull_request_terminal_at, error_code
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        workspaceId,
        GITHUB_LOOKUP_VERSION,
        result.repositoryFullName,
        result.commitSha,
        result.outcome,
        result.candidateCount,
        result.pullRequestNumber,
        result.pullRequestTerminalAt,
        result.errorCode,
      ],
    );
  }

  private async runAsSyncRole(
    query: string,
    parameters: unknown[],
  ): Promise<Record<string, unknown>[]> {
    if (!this.connection) throw new Error("GitHub sync lock is not held");
    return await this.connection.unsafe(
      query,
      parameters as never[],
    ) as unknown as Record<string, unknown>[];
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

function failure(pair: CommitPair, error: unknown): LookupResult {
  const code = error instanceof GitHubSyncError
    ? error.code
    : error instanceof DOMException && error.name === "TimeoutError"
    ? "github_timeout"
    : "github_request_failed";
  return result(pair, "failed", null, null, null, code);
}

export async function syncPending(
  store: LookupStore,
  options: {
    workspaceId: string;
    token: string;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<{ attempted: number; matched: number; failed: number }> {
  options.signal?.throwIfAborted();
  return await store.withWorkspaceLock(options.workspaceId, async () => {
    let attempted = 0;
    let matched = 0;
    let failed = 0;
    for (const pair of await store.pendingPairs(options.workspaceId, 25)) {
      options.signal?.throwIfAborted();
      attempted += 1;
      try {
        const result = await lookupCommit(pair, options);
        await store.append(options.workspaceId, result);
        if (result.outcome === "matched") matched += 1;
      } catch (error) {
        if (options.signal?.aborted) options.signal.throwIfAborted();
        await store.append(options.workspaceId, failure(pair, error));
        failed += 1;
        if (
          error instanceof GitHubSyncError &&
          (error.status === 403 || error.status === 429)
        ) break;
      }
    }
    return { attempted, matched, failed };
  }) ?? { attempted: 0, matched: 0, failed: 0 };
}
