#!/usr/bin/env -S deno run --allow-env --allow-net

import { PostgresActivityReducer } from "../supabase/functions/sherlock-activity-reducer/postgres.ts";
import { ACTIVITY_VERSION } from "../supabase/functions/sherlock-activity-reducer/reducer.ts";

interface Options {
  workspaceId: string;
  normalizerVersion: string;
  activityVersion: string;
  throughEventId: bigint | null;
  sessionId: string | null;
  afterSessionId: string | null;
  sessionBatchSize: number;
  eventPageSize: number;
}

if (import.meta.main) {
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL is required");
  const options = parseArgs(Deno.args);
  const reducer = PostgresActivityReducer.connect(databaseUrl);
  try {
    const throughEventId = options.throughEventId ??
      await reducer.resolveWorkspaceCutoff(
        options.workspaceId,
        options.normalizerVersion,
      );
    const results = [];
    if (options.sessionId) {
      results.push(
        await reducer.reduceSession({
          workspaceId: options.workspaceId,
          sessionId: options.sessionId,
          normalizerVersion: options.normalizerVersion,
          activityVersion: options.activityVersion,
          throughEventId,
          eventPageSize: options.eventPageSize,
        }),
      );
    } else {
      let after = options.afterSessionId;
      while (true) {
        const sessionIds = await reducer.listSessionIds({
          workspaceId: options.workspaceId,
          normalizerVersion: options.normalizerVersion,
          throughEventId,
          afterSessionId: after,
          limit: options.sessionBatchSize,
        });
        for (const sessionId of sessionIds) {
          results.push(
            await reducer.reduceSession({
              workspaceId: options.workspaceId,
              sessionId,
              normalizerVersion: options.normalizerVersion,
              activityVersion: options.activityVersion,
              throughEventId,
              eventPageSize: options.eventPageSize,
            }),
          );
        }
        if (sessionIds.length < options.sessionBatchSize) break;
        after = sessionIds.at(-1)!;
      }
    }
    console.log(JSON.stringify(
      {
        workspace_id: options.workspaceId,
        normalizer_version: options.normalizerVersion,
        activity_version: options.activityVersion,
        through_event_id: throughEventId.toString(),
        sessions: results.map((result) => ({
          ...result,
          cutoff_event_id: result.cutoff_event_id?.toString() ?? null,
        })),
      },
      null,
      2,
    ));
  } finally {
    await reducer.close();
  }
}

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value) usage();
    values.set(name.slice(2), value);
  }
  const workspaceId = values.get("workspace");
  if (!workspaceId) usage();
  const sessionBatchSize = positiveInteger(
    values.get("session-batch-size") ?? "50",
    "session-batch-size",
  );
  const eventPageSize = positiveInteger(
    values.get("event-page-size") ?? "1000",
    "event-page-size",
  );
  const through = values.get("through-event-id");
  return {
    workspaceId,
    normalizerVersion: values.get("normalizer-version") ??
      "sherlock.codex-rollout.v2",
    activityVersion: values.get("activity-version") ?? ACTIVITY_VERSION,
    throughEventId: through
      ? positiveBigInt(through, "through-event-id")
      : null,
    sessionId: values.get("session") ?? null,
    afterSessionId: values.get("after-session") ?? null,
    sessionBatchSize,
    eventPageSize,
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function positiveBigInt(value: string, name: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`--${name} must be a positive integer`);
  }
}

function usage(): never {
  throw new Error(
    "usage: reduce-activity.ts --workspace <uuid> [--through-event-id <id>] " +
      "[--session <uuid>] [--after-session <uuid>] " +
      "[--normalizer-version <version>] [--activity-version <version>] " +
      "[--session-batch-size <n>] [--event-page-size <n>]",
  );
}
