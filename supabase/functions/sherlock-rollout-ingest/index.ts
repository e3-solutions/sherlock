import { publicCollectorGrant, workspaceRoutingConfig } from "./attribution.ts";
import { IngestError, MAX_REQUEST_BYTES, parseEnvelope } from "./contract.ts";
import { parseExclusionsRequest, requestOperation } from "./exclusions.ts";
import {
  edgeFunctionDatabaseUrl,
  isDatabaseConnectionError,
  PostgresBatchRepository,
} from "./postgres.ts";
import { IngestService, type WorkloadClassHint } from "./service.ts";
import { SupabaseImmutableStorage } from "./storage.ts";

type EnvironmentReader = (name: string) => string | undefined;

function required(
  name: string,
  environment: EnvironmentReader = (key) => Deno.env.get(key),
): string {
  const value = environment(name);
  if (!value) {
    throw new IngestError("invalid_configuration", `${name} is required`, 500);
  }
  return value;
}

export function ingestDatabaseUrl(
  environment: EnvironmentReader = (name) => Deno.env.get(name),
): string {
  // Supabase injects SUPABASE_DB_URL as a direct connection. Ingestion needs
  // its own configurable pooler URL rather than that reserved variable.
  return edgeFunctionDatabaseUrl(
    required("SHERLOCK_INGEST_DATABASE_URL", environment),
  );
}

type Backend = {
  service: IngestService;
  batches: PostgresBatchRepository;
};

let backend: Backend | null = null;
function ingestBackend(): Backend {
  if (backend) return backend;
  const databaseUrl = ingestDatabaseUrl();
  const batches = PostgresBatchRepository.connect(databaseUrl);
  backend = {
    batches,
    service: new IngestService(
      new SupabaseImmutableStorage(
        required("SUPABASE_URL"),
        required("SUPABASE_SERVICE_ROLE_KEY"),
      ),
      batches,
    ),
  };
  return backend;
}

// The next request reconnects instead of reusing a client whose socket broke.
function discardIngestBackend(broken: Backend): void {
  if (backend === broken) backend = null;
  broken.batches.abandon();
}

// postgres.js can raise a connection failure from a timer or socket callback
// after the request that caused it has settled. Unhandled, the runtime kills
// the worker and every request on it fails with a 503. Only database
// connection errors are absorbed; anything else still crashes loudly. The
// client that raised it is unknown here, so the request path (its own error
// or its deadline) is what drops broken clients.
function absorbDetachedConnectionError(event: Event, error: unknown): void {
  if (!isDatabaseConnectionError(error)) return;
  event.preventDefault();
  console.error("database connection failed outside a request", error);
}
globalThis.addEventListener(
  "unhandledrejection",
  (event) => absorbDetachedConnectionError(event, event.reason),
);
globalThis.addEventListener(
  "error",
  (event) => absorbDetachedConnectionError(event, event.error),
);

export const DATABASE_ATTEMPTS = 3;
// A retry starts only this early in the request (counted from its arrival,
// since reading and hashing the body come first), so a second 8 s connect
// still answers before the collector's 20 s HTTP timeout.
export const DATABASE_RETRY_WINDOW_MS = 9_000;
export const DATABASE_RETRY_AFTER_SECONDS = 5;
// The collector gives up after 20 s; answer before it does. This also ends a
// postgres.js reconnect loop (a pooler that closes cleanly during startup is
// reconnected at once, forever, without a CONNECT_TIMEOUT) or a query stuck
// on a client whose socket broke.
export const REQUEST_DEADLINE_MS = 18_000;
const DEADLINE = Symbol("deadline");

function retryDelayMs(attempt: number): number {
  return 200 * attempt + Math.floor(Math.random() * 300);
}

// Every database write in a request is idempotent (person upsert, exact-range
// batch receipt, additive exclusions), so a connection failure at any point,
// even after COMMIT was sent, is safe to retry on a fresh connection.
async function withDatabase<T>(
  backendFactory: () => Backend,
  discardBackend: (broken: Backend) => void,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => number,
  requestStartedAt: number,
  requestDeadlineMs: number,
  work: (current: Backend) => Promise<T>,
): Promise<T> {
  for (let attempt = 1;; attempt += 1) {
    const current = backendFactory();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(DEADLINE),
        Math.max(0, requestStartedAt + requestDeadlineMs - now()),
      );
    });
    const running = work(current);
    running.catch(() => undefined); // settles after abandon when it loses
    try {
      return await Promise.race([running, deadline]);
    } catch (error) {
      if (error === DEADLINE) {
        discardBackend(current);
        console.error(`ingest passed its deadline (attempt ${attempt})`);
        throw new IngestError(
          "ingest_timeout",
          "ingest did not finish in time; retry later",
          503,
        );
      }
      if (!isDatabaseConnectionError(error)) throw error;
      discardBackend(current);
      const retry = attempt < DATABASE_ATTEMPTS &&
        now() - requestStartedAt < DATABASE_RETRY_WINDOW_MS;
      console.error(
        `database connection failed (attempt ${attempt}, ${
          retry ? "retrying" : "giving up"
        })`,
        error,
      );
      if (!retry) {
        throw new IngestError(
          "database_unavailable",
          "the database is temporarily unreachable; retry later",
          503,
        );
      }
      await sleep(retryDelayMs(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function handler(request: Request): Promise<Response> {
  return await handleRequest(request);
}

export async function handleRequest(
  request: Request,
  {
    environment = (name) => Deno.env.get(name),
    backendFactory = ingestBackend,
    discardBackend = discardIngestBackend,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = () => performance.now(),
    requestDeadlineMs = REQUEST_DEADLINE_MS,
  }: {
    environment?: EnvironmentReader;
    backendFactory?: typeof ingestBackend;
    discardBackend?: typeof discardIngestBackend;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
    requestDeadlineMs?: number;
  } = {},
): Promise<Response> {
  const requestStartedAt = now();
  const database = <T>(work: (current: Backend) => Promise<T>) =>
    withDatabase(
      backendFactory,
      discardBackend,
      sleep,
      now,
      requestStartedAt,
      requestDeadlineMs,
      work,
    );
  try {
    if (request.method !== "POST") {
      return Response.json({ error: { code: "method_not_allowed" } }, {
        status: 405,
      });
    }
    const body = await readJsonBounded(request);
    const routing = () =>
      workspaceRoutingConfig(
        required("SHERLOCK_E3_WORKSPACE_ID", environment),
        required("SHERLOCK_SIXTYFOUR_WORKSPACE_ID", environment),
      );
    if (requestOperation(body) !== null) {
      // Authenticated exactly like a batch: the same collector identity
      // resolves the workspace and person the exclusions are scoped to.
      const exclusions = parseExclusionsRequest(body);
      const grant = publicCollectorGrant(routing(), exclusions.collector);
      const receipt = await database(async (current) => {
        const attribution = await current.batches.resolveAttribution(
          grant,
          exclusions.collector,
        );
        return await current.batches.recordOwnerExclusions(
          attribution,
          exclusions.excluded_session_ids,
        );
      });
      return Response.json(receipt, {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const envelope = parseEnvelope(body);
    const grant = publicCollectorGrant(routing(), envelope.collector);
    const workloadClassHint = parseWorkloadClassHint(
      request.headers.get("x-sherlock-workload-class"),
    );
    const receipt = await database(async (current) => {
      const attribution = await current.batches.resolveAttribution(
        grant,
        envelope.collector,
      );
      return await current.service.ingest(
        attribution,
        envelope.manifest,
        envelope.stored_payload,
        workloadClassHint,
      );
    });
    return Response.json(receipt, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof IngestError) {
      const headers: Record<string, string> = { "Cache-Control": "no-store" };
      if (
        error.code === "database_unavailable" ||
        error.code === "ingest_timeout"
      ) {
        headers["Retry-After"] = String(DATABASE_RETRY_AFTER_SECONDS);
      }
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers },
      );
    }
    console.error(error);
    return Response.json(
      { error: { code: "internal_error", message: "ingest failed" } },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export function parseWorkloadClassHint(
  value: string | null,
): WorkloadClassHint {
  if (value === null || value === "") return null;
  if (value === "live" || value === "backfill") return value;
  throw new IngestError(
    "invalid_workload_class",
    "x-sherlock-workload-class must be live or backfill",
    400,
  );
}

async function readJsonBounded(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new IngestError(
      "payload_too_large",
      "request body exceeds 24 MiB",
      413,
    );
  }
  if (!request.body) {
    throw new IngestError("invalid_request", "request body must be JSON", 400);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new IngestError(
        "payload_too_large",
        "request body exceeds 24 MiB",
        413,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new IngestError("invalid_request", "request body must be JSON", 400);
  }
}

export default { fetch: handler };
