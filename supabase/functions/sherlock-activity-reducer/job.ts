import {
  ActivitySessionBusyError,
  ActivitySessionDeadlineError,
  ActivitySessionLimitError,
  type ReduceSessionOptions,
  type ReduceSessionResult,
} from "./postgres.ts";

export const NORMALIZER_VERSION = "sherlock.codex-rollout.v1";

export interface ActivityReductionBackend {
  resolveWorkspaceCutoff(
    workspaceId: string,
    normalizerVersion: string,
    statementTimeoutMs?: number,
  ): Promise<bigint>;
  listSessionIds(options: {
    workspaceId: string;
    normalizerVersion: string;
    throughEventId: bigint;
    afterSessionId?: string | null;
    limit: number;
    statementTimeoutMs?: number;
  }): Promise<string[]>;
  reduceSession(options: ReduceSessionOptions): Promise<ReduceSessionResult>;
  close(): Promise<void>;
}

export interface ActivityReductionJobOptions {
  workspaceId: string;
  normalizerVersion: string;
  activityVersion: string;
  maxSessions: number;
  maxEventsPerSession: number;
  eventPageSize: number;
  deadlineMs: number;
  statementTimeoutMs: number;
  now?: () => number;
}

export interface ActivityReductionFailure {
  session_id: string;
  code:
    | "session_busy"
    | "session_deadline_exceeded"
    | "session_event_limit_exceeded"
    | "reduction_failed";
}

export interface ActivityReductionJobResult {
  status: "complete" | "partial_failure" | "partial_deadline";
  workspace_id: string;
  normalizer_version: string;
  activity_version: string;
  through_event_id: bigint;
  selected_session_count: number;
  completed_session_count: number;
  candidate_count: number;
  inserted_count: number;
  tombstone_count: number;
  failures: ActivityReductionFailure[];
  duration_ms: number;
}

export class ActivityWorkspaceLimitError extends Error {
  readonly code = "workspace_session_limit_exceeded";

  constructor(public readonly maximum: number) {
    super(`workspace exceeds the ${maximum} session job limit`);
  }
}

export async function runActivityReductionJob(
  backend: ActivityReductionBackend,
  options: ActivityReductionJobOptions,
): Promise<ActivityReductionJobResult> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const throughEventId = await backend.resolveWorkspaceCutoff(
    options.workspaceId,
    options.normalizerVersion,
    options.statementTimeoutMs,
  );
  const sessionIds = await backend.listSessionIds({
    workspaceId: options.workspaceId,
    normalizerVersion: options.normalizerVersion,
    throughEventId,
    afterSessionId: null,
    limit: options.maxSessions + 1,
    statementTimeoutMs: Math.min(
      options.statementTimeoutMs,
      Math.max(1, options.deadlineMs - (now() - startedAt)),
    ),
  });
  if (sessionIds.length > options.maxSessions) {
    throw new ActivityWorkspaceLimitError(options.maxSessions);
  }

  const failures: ActivityReductionFailure[] = [];
  let completed = 0;
  let candidates = 0;
  let inserted = 0;
  let tombstones = 0;
  let deadlineReached = false;
  for (const sessionId of sessionIds) {
    if (now() - startedAt >= options.deadlineMs) {
      deadlineReached = true;
      break;
    }
    try {
      const result = await backend.reduceSession({
        workspaceId: options.workspaceId,
        sessionId,
        normalizerVersion: options.normalizerVersion,
        activityVersion: options.activityVersion,
        throughEventId,
        eventPageSize: options.eventPageSize,
        maxEventCount: options.maxEventsPerSession,
        statementTimeoutMs: Math.min(
          options.statementTimeoutMs,
          Math.max(1, options.deadlineMs - (now() - startedAt)),
        ),
        deadlineAtMs: startedAt + options.deadlineMs,
        now,
      });
      completed += 1;
      candidates += result.candidate_count;
      inserted += result.inserted_count;
      tombstones += result.tombstone_count;
    } catch (error) {
      if (error instanceof ActivitySessionDeadlineError) {
        failures.push({
          session_id: sessionId,
          code: "session_deadline_exceeded",
        });
        deadlineReached = true;
        break;
      }
      failures.push({
        session_id: sessionId,
        code: error instanceof ActivitySessionLimitError
          ? "session_event_limit_exceeded"
          : error instanceof ActivitySessionBusyError
          ? "session_busy"
          : "reduction_failed",
      });
    }
  }
  return {
    status: deadlineReached
      ? "partial_deadline"
      : failures.length > 0
      ? "partial_failure"
      : "complete",
    workspace_id: options.workspaceId,
    normalizer_version: options.normalizerVersion,
    activity_version: options.activityVersion,
    through_event_id: throughEventId,
    selected_session_count: sessionIds.length,
    completed_session_count: completed,
    candidate_count: candidates,
    inserted_count: inserted,
    tombstone_count: tombstones,
    failures,
    duration_ms: Math.max(0, Math.round(now() - startedAt)),
  };
}
