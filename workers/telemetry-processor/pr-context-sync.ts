import { REPOSITORY } from "../../supabase/functions/sherlock-rollout-ingest/pr-context.ts";
import {
  githubPause,
  GitHubSyncError,
  type GithubSyncSummary,
} from "./github-sync.ts";

export interface PrContextTarget {
  workspaceId: string;
  sourceRecordId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}
export interface PrContextVerification extends PrContextTarget {
  outcome:
    | "checked"
    | "inaccessible"
    | "failed"
    | "identity_mismatch"
    | "out_of_scope";
  repositoryId: number | null;
  pullRequestId: number | null;
  pullRequestState: "open" | "closed" | "merged" | null;
}
export interface PrContextStore {
  pendingPrContexts(
    limit: number,
    workspaceIds: readonly string[],
  ): Promise<PrContextTarget[]>;
  appendPrContextVerification(result: PrContextVerification): Promise<void>;
}
export type PrContextScope = ReadonlyMap<string, ReadonlySet<string>>;

// Explicit workspace/repository pairs, never inferred from upload metadata or
// the repositories reachable through a broad GitHub token. Empty means disabled.
export function prContextRepositoryScope(
  value: string | undefined,
): PrContextScope {
  const scope = new Map<string, Set<string>>();
  if (!value?.trim()) return scope;
  for (const entry of value.split(",")) {
    const [workspace, repository, extra] = entry.trim().toLowerCase().split(
      "=",
    );
    if (
      extra !== undefined ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        workspace,
      ) ||
      !repository || !REPOSITORY.test(repository) ||
      [".", ".."].includes(repository.split("/")[1])
    ) {
      throw new Error(
        "SHERLOCK_GITHUB_PR_CONTEXT_REPOSITORIES must be workspace-UUID=owner/repo pairs",
      );
    }
    if (!scope.has(workspace)) scope.set(workspace, new Set());
    scope.get(workspace)!.add(repository);
  }
  return scope;
}
function result(
  target: PrContextTarget,
  outcome: PrContextVerification["outcome"],
): PrContextVerification {
  return {
    ...target,
    outcome,
    repositoryId: null,
    pullRequestId: null,
    pullRequestState: null,
  };
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function lookupPrContext(
  target: PrContextTarget,
  token: string,
  scope: PrContextScope,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PrContextVerification> {
  if (
    !scope.get(target.workspaceId)?.has(target.repositoryFullName) ||
    !REPOSITORY.test(target.repositoryFullName) ||
    !Number.isSafeInteger(target.pullRequestNumber) ||
    target.pullRequestNumber < 1
  ) {
    return result(target, "out_of_scope");
  }
  const [owner, repository] = target.repositoryFullName.split("/");
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetcher(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${
      encodeURIComponent(repository)
    }/pulls/${target.pullRequestNumber}`,
    {
      // A rename redirect must not forward credentials or silently expand scope.
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "sherlock-explicit-pr-context",
      },
    },
  );
  if (!response.ok) {
    const pause = await githubPause(response, Date.now());
    if (pause) {
      throw new GitHubSyncError("github_http_" + response.status, pause);
    }
    if (response.status >= 300 && response.status < 400) {
      return result(target, "identity_mismatch");
    }
    return result(
      target,
      response.status === 404 || response.status === 403
        ? "inaccessible"
        : "failed",
    );
  }
  const pull = object(await response.json());
  const repo = object(object(pull?.base)?.repo);
  const state = pull?.state;
  const merged = pull?.merged_at;
  const closed = pull?.closed_at;
  if (
    typeof repo?.full_name !== "string" ||
    repo.full_name.toLowerCase() !== target.repositoryFullName ||
    pull?.number !== target.pullRequestNumber ||
    !Number.isSafeInteger(pull?.id) || Number(pull?.id) < 1 ||
    !Number.isSafeInteger(repo.id) || Number(repo.id) < 1 ||
    (state !== "open" && state !== "closed") ||
    (state === "open" && (closed !== null || merged !== null)) ||
    (state === "closed" &&
      (typeof closed !== "string" || !Number.isFinite(Date.parse(closed)))) ||
    (merged !== null &&
      (typeof merged !== "string" || !Number.isFinite(Date.parse(merged))))
  ) {
    return result(target, "identity_mismatch");
  }
  return {
    ...result(target, "checked"),
    repositoryId: Number(repo.id),
    pullRequestId: Number(pull.id),
    pullRequestState: merged ? "merged" : state,
  };
}

export async function syncPrContexts(
  store: PrContextStore,
  token: string,
  workspaceIds: readonly string[],
  scope: PrContextScope,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GithubSyncSummary> {
  const summary: GithubSyncSummary = {
    attempted: 0,
    failed: 0,
    backlogRemaining: false,
    pause: null,
  };
  const enabledWorkspaces = workspaceIds.filter((workspace) =>
    scope.has(workspace)
  );
  if (!enabledWorkspaces.length) return summary;
  const pending = await store.pendingPrContexts(26, enabledWorkspaces);
  summary.backlogRemaining = pending.length > 25;
  for (const target of pending.slice(0, 25)) {
    options.signal?.throwIfAborted();
    summary.attempted++;
    let verification: PrContextVerification;
    try {
      verification = await lookupPrContext(
        target,
        token,
        scope,
        options.fetcher,
        options.signal,
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof GitHubSyncError && error.pause) {
        summary.pause = error.pause;
        summary.backlogRemaining = true;
        break;
      }
      verification = result(target, "failed");
    }
    if (verification.outcome === "failed") summary.failed++;
    await store.appendPrContextVerification(verification);
  }
  return summary;
}
