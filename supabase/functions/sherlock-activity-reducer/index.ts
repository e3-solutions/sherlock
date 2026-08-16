import {
  type ActivityReductionBackend,
  NORMALIZER_VERSION,
  runActivityReductionJob,
} from "./job.ts";
import { PostgresActivityReducer } from "./postgres.ts";
import { ACTIVITY_VERSION } from "./reducer.ts";

const TOKEN_HEADER = "x-sherlock-job-token";
const MAX_BODY_BYTES = 1_024;

interface FunctionConfig {
  databaseUrl: string;
  workspaceId: string;
  tokenHash: string;
  maxSessions: number;
  maxEventsPerSession: number;
  eventPageSize: number;
  deadlineMs: number;
  statementTimeoutMs: number;
}

export interface ActivityFunctionDependencies {
  env(name: string): string | undefined;
  connect(databaseUrl: string): ActivityReductionBackend;
  now?: () => number;
}

export function createHandler(
  dependencies: ActivityFunctionDependencies = {
    env: (name) => Deno.env.get(name),
    connect: (databaseUrl) => PostgresActivityReducer.connect(databaseUrl),
  },
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return jsonError("method_not_allowed", 405);

    let config: FunctionConfig;
    try {
      config = loadConfig(dependencies.env);
    } catch (error) {
      console.error("activity reducer configuration error", safeError(error));
      return jsonError("invalid_configuration", 500);
    }
    if (
      !await tokenMatches(request.headers.get(TOKEN_HEADER), config.tokenHash)
    ) {
      return jsonError("unauthorized", 401);
    }
    try {
      await readEmptyObject(request);
    } catch {
      return jsonError("invalid_request", 400);
    }

    let backend: ActivityReductionBackend | undefined;
    try {
      backend = dependencies.connect(config.databaseUrl);
      const result = await runActivityReductionJob(backend, {
        workspaceId: config.workspaceId,
        normalizerVersion: NORMALIZER_VERSION,
        activityVersion: ACTIVITY_VERSION,
        maxSessions: config.maxSessions,
        maxEventsPerSession: config.maxEventsPerSession,
        eventPageSize: config.eventPageSize,
        deadlineMs: config.deadlineMs,
        statementTimeoutMs: config.statementTimeoutMs,
        now: dependencies.now,
      });
      const status = result.status === "complete"
        ? 200
        : result.status === "partial_deadline"
        ? 503
        : 500;
      return Response.json(serialize(result), {
        status,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      const code = error instanceof Error &&
          "code" in error && error.code === "workspace_session_limit_exceeded"
        ? "workspace_session_limit_exceeded"
        : "internal_error";
      console.error("activity reduction failed", safeError(error));
      return jsonError(
        code,
        code === "workspace_session_limit_exceeded" ? 503 : 500,
      );
    } finally {
      if (backend) {
        try {
          await backend.close();
        } catch (error) {
          console.error(
            "activity reducer database close failed",
            safeError(error),
          );
        }
      }
    }
  };
}

function loadConfig(env: (name: string) => string | undefined): FunctionConfig {
  return {
    databaseUrl: required(env, "SUPABASE_DB_URL"),
    workspaceId: uuid(required(env, "SHERLOCK_WORKSPACE_ID")),
    tokenHash: sha256(required(env, "SHERLOCK_ACTIVITY_REDUCER_TOKEN_SHA256")),
    maxSessions: positiveInteger(env("SHERLOCK_REDUCER_MAX_SESSIONS") ?? "50"),
    maxEventsPerSession: positiveInteger(
      env("SHERLOCK_REDUCER_MAX_EVENTS_PER_SESSION") ?? "5000",
    ),
    eventPageSize: positiveInteger(
      env("SHERLOCK_REDUCER_EVENT_PAGE_SIZE") ?? "1000",
    ),
    deadlineMs: positiveInteger(
      env("SHERLOCK_REDUCER_DEADLINE_MS") ?? "90000",
    ),
    statementTimeoutMs: positiveInteger(
      env("SHERLOCK_REDUCER_STATEMENT_TIMEOUT_MS") ?? "10000",
    ),
  };
}

function required(
  env: (name: string) => string | undefined,
  name: string,
): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function uuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new Error("workspace ID must be a UUID");
  }
  return value;
}

function sha256(value: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("job token hash must be hexadecimal SHA-256");
  }
  return value.toLowerCase();
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("job bounds must be positive integers");
  }
  return parsed;
}

async function tokenMatches(
  presented: string | null,
  expectedHash: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const left = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(presented ?? ""),
  );
  const leftBytes = new Uint8Array(left);
  const rightBytes = Uint8Array.from(
    expectedHash.match(/.{2}/g)!,
    (byte) => Number.parseInt(byte, 16),
  );
  let difference = presented === null ? 1 : 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function readEmptyObject(request: Request): Promise<void> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error();
  if (!request.body) throw new Error();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== 0
  ) throw new Error();
}

function serialize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(
    value,
    (_key, item) => typeof item === "bigint" ? item.toString() : item,
  ));
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const code = "code" in error && typeof error.code === "string"
    ? `:${error.code}`
    : "";
  return `${error.name}${code}`;
}

function jsonError(code: string, status: number): Response {
  return Response.json({ error: { code } }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

const handler = createHandler();
export default { fetch: handler };
