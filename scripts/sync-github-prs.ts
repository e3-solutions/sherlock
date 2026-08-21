#!/usr/bin/env -S deno run --allow-env --allow-net

import postgres from "npm:postgres@3.4.7";

export const GITHUB_LOOKUP_VERSION = "sherlock.github-associated-pulls.v1";
export const GITHUB_API_VERSION = "2026-03-10";
const SCM_VERSION = "sherlock.github-scm.v1";
const REPOSITORY_FULL_NAME = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CommitPair {
  repositoryFullName: string;
  commitSha: string;
}

export interface PullCandidate {
  githubRepositoryId: number;
  githubPullRequestId: number;
  pullRequestNumber: number;
  state: "open" | "closed";
  pullRequestCreatedAt: string;
  pullRequestClosedAt: string | null;
  pullRequestMergedAt: string | null;
}

export interface CompleteLookup {
  pair: CommitPair;
  responseSha256: string;
  githubRepositoryId: number | null;
  candidates: PullCandidate[];
}

export interface FailedLookup {
  pair: CommitPair;
  errorCode: string;
  httpStatus: number | null;
  retryAfter: string | null;
}

export interface LookupStore {
  tryLock(workspaceId: string): Promise<boolean>;
  unlock(workspaceId: string): Promise<void>;
  pendingPairs(workspaceId: string, limit: number): Promise<CommitPair[]>;
  appendComplete(workspaceId: string, lookup: CompleteLookup): Promise<void>;
  appendFailure(workspaceId: string, failure: FailedLookup): Promise<void>;
  close(): Promise<void>;
}

export class GitHubSyncError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number | null = null,
    readonly retryAfter: string | null = null,
    readonly rateLimited = false,
  ) {
    super(code);
  }
}

export const PENDING_PAIRS_SQL = `with rate_gate as materialized (
  select max(retry_after) retry_after
    from github.commit_pull_attempts
   where workspace_id = $1
     and lookup_version = '${GITHUB_LOOKUP_VERSION}'
     and api_version = '${GITHUB_API_VERSION}'
     and retry_after > now()
), observed as materialized (
  select repository_full_name, commit_sha
    from telemetry.scm_projections
   where workspace_id = $1
     and scm_version = '${SCM_VERSION}'
     and projection_status = 'matched'
     and observed_at >= now() - interval '26 hours'
   group by repository_full_name, commit_sha
), due as (
  select observed.*, latest.id latest_attempt_id
    from observed
    cross join rate_gate
    left join lateral (
      select attempt.id, attempt.retry_after
        from github.commit_pull_attempts attempt
       where attempt.workspace_id = $1
         and attempt.repository_full_name = observed.repository_full_name
         and attempt.commit_sha = observed.commit_sha
         and attempt.lookup_version = '${GITHUB_LOOKUP_VERSION}'
         and attempt.api_version = '${GITHUB_API_VERSION}'
       order by attempt.id desc
       limit 1
    ) latest on true
   where rate_gate.retry_after is null
     and (latest.retry_after is null or latest.retry_after <= now())
)
select repository_full_name, commit_sha
  from due
 order by (latest_attempt_id is not null), latest_attempt_id,
          repository_full_name, commit_sha
 limit $2`;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new GitHubSyncError(code);
  }
  return Number(value);
}

function timestamp(
  value: unknown,
  nullable: boolean,
  code: string,
): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new GitHubSyncError(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new GitHubSyncError(code);
  return parsed.toISOString();
}

export function hasNextPage(link: string | null): boolean {
  return link?.split(",").some((part) =>
    /;\s*rel="next"\s*$/.test(part.trim())
  ) ?? false;
}

export function validateCandidates(
  value: unknown,
  repositoryFullName: string,
): { githubRepositoryId: number | null; candidates: PullCandidate[] } {
  if (!Array.isArray(value) || value.length > 100) {
    throw new GitHubSyncError("github_pull_response_invalid");
  }
  const expectedRepository = repositoryFullName.toLowerCase();
  const ids = new Set<number>();
  const numbers = new Set<number>();
  let repositoryId: number | null = null;
  const candidates = value.map((raw) => {
    const pull = objectValue(raw);
    const repository = objectValue(objectValue(pull?.base)?.repo);
    const candidateRepositoryId = positiveInteger(
      repository?.id,
      "github_base_repository_invalid",
    );
    if (
      typeof repository?.full_name !== "string" ||
      repository.full_name.toLowerCase() !== expectedRepository ||
      (repositoryId !== null && repositoryId !== candidateRepositoryId)
    ) {
      throw new GitHubSyncError("github_base_repository_mismatch");
    }
    repositoryId = candidateRepositoryId;
    const githubPullRequestId = positiveInteger(
      pull?.id,
      "github_pull_request_id_invalid",
    );
    const pullRequestNumber = positiveInteger(
      pull?.number,
      "github_pull_request_number_invalid",
    );
    if (ids.has(githubPullRequestId) || numbers.has(pullRequestNumber)) {
      throw new GitHubSyncError("github_pull_response_duplicate");
    }
    ids.add(githubPullRequestId);
    numbers.add(pullRequestNumber);
    if (pull?.state !== "open" && pull?.state !== "closed") {
      throw new GitHubSyncError("github_pull_request_state_invalid");
    }
    const state: "open" | "closed" = pull.state;
    const pullRequestCreatedAt = timestamp(
      pull.created_at,
      false,
      "github_pull_request_created_at_invalid",
    )!;
    const pullRequestClosedAt = timestamp(
      pull.closed_at,
      true,
      "github_pull_request_closed_at_invalid",
    );
    const pullRequestMergedAt = timestamp(
      pull.merged_at,
      true,
      "github_pull_request_merged_at_invalid",
    );
    if (
      (state === "open" &&
        (pullRequestClosedAt !== null || pullRequestMergedAt !== null)) ||
      (state === "closed" && pullRequestClosedAt === null) ||
      (pullRequestClosedAt !== null &&
        pullRequestClosedAt < pullRequestCreatedAt) ||
      (pullRequestMergedAt !== null &&
        (pullRequestMergedAt < pullRequestCreatedAt ||
          pullRequestClosedAt === null ||
          pullRequestMergedAt > pullRequestClosedAt))
    ) throw new GitHubSyncError("github_pull_request_timeline_invalid");
    return {
      githubRepositoryId: candidateRepositoryId,
      githubPullRequestId,
      pullRequestNumber,
      state,
      pullRequestCreatedAt,
      pullRequestClosedAt,
      pullRequestMergedAt,
    };
  });
  return { githubRepositoryId: repositoryId, candidates };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function retryAfter(headers: Headers, now: Date): string | null {
  const raw = headers.get("retry-after");
  if (raw && /^\d+$/.test(raw)) {
    return new Date(now.getTime() + Number(raw) * 1_000).toISOString();
  }
  if (raw) {
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime()) && parsed > now) {
      return parsed.toISOString();
    }
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) {
    const parsed = new Date(Number(reset) * 1_000);
    if (Number.isFinite(parsed.getTime()) && parsed > now) {
      return parsed.toISOString();
    }
  }
  return null;
}

async function boundedResponseText(
  response: Response,
  maximumBytes = 4_096,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maximumBytes - received;
      chunks.push(value.subarray(0, remaining));
      received += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) break;
    }
  } finally {
    if (received >= maximumBytes) await reader.cancel();
    reader.releaseLock();
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function lookupCommit(
  pair: CommitPair,
  options: {
    token: string;
    fetcher?: typeof fetch;
    now?: Date;
    apiBase?: string;
    signal?: AbortSignal;
  },
): Promise<CompleteLookup> {
  if (
    !REPOSITORY_FULL_NAME.test(pair.repositoryFullName) ||
    pair.repositoryFullName.split("/").some((part) =>
      part === "." || part === ".."
    ) ||
    !COMMIT_SHA.test(pair.commitSha)
  ) throw new GitHubSyncError("github_lookup_identity_invalid");
  const [owner, repository] = pair.repositoryFullName.split("/");
  const url = `${options.apiBase ?? "https://api.github.com"}/repos/${
    encodeURIComponent(owner)
  }/${
    encodeURIComponent(repository)
  }/commits/${pair.commitSha}/pulls?per_page=100`;
  const timeout = AbortSignal.timeout(30_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const response = await (options.fetcher ?? fetch)(url, {
    signal,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "sherlock-github-pr-sync",
    },
  });
  if (!response.ok) {
    const errorBody = await boundedResponseText(response);
    const now = options.now ?? new Date();
    const secondaryRateLimit = response.status === 403 &&
      /(secondary rate limit|abuse detection)/i.test(errorBody);
    const retryAt = retryAfter(response.headers, now) ??
      (secondaryRateLimit
        ? new Date(now.getTime() + 60_000).toISOString()
        : null);
    const rateLimited = response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          retryAt !== null || secondaryRateLimit));
    throw new GitHubSyncError(
      `github_lookup_http_${response.status}`,
      response.status,
      retryAt,
      rateLimited,
    );
  }
  try {
    if (hasNextPage(response.headers.get("link"))) {
      throw new GitHubSyncError("github_lookup_incomplete");
    }
    const body = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new GitHubSyncError("github_pull_response_invalid");
    }
    const { githubRepositoryId, candidates } = validateCandidates(
      parsed,
      pair.repositoryFullName,
    );
    return {
      pair,
      responseSha256: await sha256(body),
      githubRepositoryId,
      candidates,
    };
  } catch (error) {
    if (error instanceof GitHubSyncError && error.httpStatus === null) {
      throw new GitHubSyncError(error.code, response.status);
    }
    throw error;
  }
}

export interface ReservedLookupConnection {
  unsafe(
    query: string,
    parameters?: readonly unknown[],
  ): Promise<Record<string, unknown>[]>;
  release(): void;
}

export class WorkspaceLockLease {
  private active: {
    workspaceId: string;
    connection: ReservedLookupConnection;
  } | null = null;

  constructor(
    private readonly reserve: () => Promise<ReservedLookupConnection>,
  ) {}

  async tryLock(workspaceId: string): Promise<boolean> {
    if (this.active) throw new Error("github workspace lock already held");
    const connection = await this.reserve();
    try {
      const rows = await connection.unsafe(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
        [`sherlock:github-sync:${workspaceId}`],
      );
      if (rows[0]?.locked !== true) {
        connection.release();
        return false;
      }
      this.active = { workspaceId, connection };
      return true;
    } catch (error) {
      connection.release();
      throw error;
    }
  }

  connection(): ReservedLookupConnection {
    if (!this.active) throw new Error("github workspace lock not held");
    return this.active.connection;
  }

  async unlock(workspaceId: string): Promise<void> {
    const active = this.active;
    this.active = null;
    if (!active) return;
    try {
      if (active.workspaceId !== workspaceId) {
        throw new Error("github workspace lock identity mismatch");
      }
      await active.connection.unsafe(
        "select pg_advisory_unlock(hashtextextended($1, 0))",
        [`sherlock:github-sync:${workspaceId}`],
      );
    } finally {
      active.connection.release();
    }
  }
}

export class PostgresLookupStore implements LookupStore {
  private readonly lock: WorkspaceLockLease;

  private constructor(private readonly sql: ReturnType<typeof postgres>) {
    this.lock = new WorkspaceLockLease(async () =>
      await this.sql.reserve() as unknown as ReservedLookupConnection
    );
  }

  static connect(databaseUrl: string): PostgresLookupStore {
    return new PostgresLookupStore(postgres(databaseUrl, {
      prepare: false,
      max: 1,
      idle_timeout: 0,
    }));
  }

  async tryLock(workspaceId: string): Promise<boolean> {
    return await this.lock.tryLock(workspaceId);
  }

  async unlock(workspaceId: string): Promise<void> {
    await this.lock.unlock(workspaceId);
  }

  private async transaction<T>(
    action: (connection: ReservedLookupConnection) => Promise<T>,
  ): Promise<T> {
    const connection = this.lock.connection();
    await connection.unsafe("begin");
    try {
      await connection.unsafe("set local role sherlock_github_sync");
      const result = await action(connection);
      await connection.unsafe("commit");
      return result;
    } catch (error) {
      try {
        await connection.unsafe("rollback");
      } catch {
        // Preserve the original failure; unlock still releases the reservation.
      }
      throw error;
    }
  }

  async pendingPairs(
    workspaceId: string,
    limit: number,
  ): Promise<CommitPair[]> {
    return await this.transaction(async (connection) => {
      const rows = await connection.unsafe(PENDING_PAIRS_SQL, [
        workspaceId,
        limit,
      ]);
      return rows.map((row) => ({
        repositoryFullName: String(row.repository_full_name),
        commitSha: String(row.commit_sha),
      }));
    });
  }

  async appendComplete(
    workspaceId: string,
    lookup: CompleteLookup,
  ): Promise<void> {
    await this.transaction(async (connection) => {
      const attempt = await connection.unsafe(
        `insert into github.commit_pull_attempts (
           workspace_id, lookup_version, api_version, repository_full_name,
           commit_sha, outcome, github_repository_id, response_sha256,
           candidate_count
         ) values ($1, $2, $3, $4, $5, 'complete', $6, $7, $8)
         returning id`,
        [
          workspaceId,
          GITHUB_LOOKUP_VERSION,
          GITHUB_API_VERSION,
          lookup.pair.repositoryFullName,
          lookup.pair.commitSha,
          lookup.githubRepositoryId,
          lookup.responseSha256,
          lookup.candidates.length,
        ],
      );
      if (lookup.candidates.length > 0) {
        await connection.unsafe(
          `insert into github.commit_pull_candidates (
             workspace_id, attempt_id, github_repository_id,
             github_pull_request_id, pull_request_number, state,
             pull_request_created_at, pull_request_closed_at,
             pull_request_merged_at
           )
           select $1, $2, item.github_repository_id,
                  item.github_pull_request_id, item.pull_request_number,
                  item.state, item.pull_request_created_at,
                  item.pull_request_closed_at, item.pull_request_merged_at
             from jsonb_to_recordset($3::jsonb) as item (
               github_repository_id bigint, github_pull_request_id bigint,
               pull_request_number integer, state text,
               pull_request_created_at timestamptz,
               pull_request_closed_at timestamptz,
               pull_request_merged_at timestamptz
             )`,
          [
            workspaceId,
            attempt[0].id,
            JSON.stringify(lookup.candidates.map((candidate) => ({
              github_repository_id: candidate.githubRepositoryId,
              github_pull_request_id: candidate.githubPullRequestId,
              pull_request_number: candidate.pullRequestNumber,
              state: candidate.state,
              pull_request_created_at: candidate.pullRequestCreatedAt,
              pull_request_closed_at: candidate.pullRequestClosedAt,
              pull_request_merged_at: candidate.pullRequestMergedAt,
            }))),
          ],
        );
      }
    });
  }

  async appendFailure(
    workspaceId: string,
    failure: FailedLookup,
  ): Promise<void> {
    await this.transaction(async (connection) => {
      await connection.unsafe(
        `insert into github.commit_pull_attempts (
           workspace_id, lookup_version, api_version, repository_full_name,
           commit_sha, outcome, error_code, http_status, retry_after
         ) values ($1, $2, $3, $4, $5, 'failed', $6, $7, $8)`,
        [
          workspaceId,
          GITHUB_LOOKUP_VERSION,
          GITHUB_API_VERSION,
          failure.pair.repositoryFullName,
          failure.pair.commitSha,
          failure.errorCode,
          failure.httpStatus,
          failure.retryAfter,
        ],
      );
    });
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

function failedLookup(pair: CommitPair, error: unknown): FailedLookup {
  if (error instanceof GitHubSyncError) {
    return {
      pair,
      errorCode: error.code,
      httpStatus: error.httpStatus,
      retryAfter: error.retryAfter,
    };
  }
  return {
    pair,
    errorCode: error instanceof DOMException && error.name === "TimeoutError"
      ? "github_lookup_timeout"
      : "github_lookup_failed",
    httpStatus: null,
    retryAfter: null,
  };
}

export async function syncPending(
  store: LookupStore,
  options: {
    workspaceId: string;
    token: string;
    limit?: number;
    fetcher?: typeof fetch;
    now?: Date;
    apiBase?: string;
    signal?: AbortSignal;
  },
): Promise<{ attempted: number; inserted: number; failed: number }> {
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
    throw new GitHubSyncError("github_sync_limit_invalid");
  }
  options.signal?.throwIfAborted();
  if (!(await store.tryLock(options.workspaceId))) {
    return { attempted: 0, inserted: 0, failed: 0 };
  }
  try {
    const pairs = await store.pendingPairs(options.workspaceId, limit);
    let attempted = 0;
    let inserted = 0;
    let failed = 0;
    for (const pair of pairs) {
      options.signal?.throwIfAborted();
      attempted += 1;
      let lookup: CompleteLookup;
      try {
        lookup = await lookupCommit(pair, options);
      } catch (error) {
        if (options.signal?.aborted) options.signal.throwIfAborted();
        const failure = failedLookup(pair, error);
        await store.appendFailure(options.workspaceId, failure);
        failed += 1;
        console.error(JSON.stringify({
          event: "github_lookup_failed",
          repository: pair.repositoryFullName,
          commit_sha: pair.commitSha,
          error_code: failure.errorCode,
        }));
        if (error instanceof GitHubSyncError && error.rateLimited) break;
        continue;
      }
      await store.appendComplete(options.workspaceId, lookup);
      inserted += 1;
    }
    return { attempted, inserted, failed };
  } finally {
    await store.unlock(options.workspaceId);
  }
}

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  const databaseUrl = required("SUPABASE_DB_URL");
  const workspaceId = required("SHERLOCK_WORKSPACE_ID");
  const token = required("GITHUB_TOKEN");
  if (!UUID.test(workspaceId)) {
    throw new Error("SHERLOCK_WORKSPACE_ID is invalid");
  }
  const store = PostgresLookupStore.connect(databaseUrl);
  try {
    const result = await syncPending(store, { workspaceId, token });
    console.log(JSON.stringify({ event: "github_sync_complete", ...result }));
    if (result.failed > 0) Deno.exitCode = 1;
  } finally {
    await store.close();
  }
}
