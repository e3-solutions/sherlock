import {
  type CollectorGrant,
  collectorKeyForIdentity,
  publicCollectorGrant,
  workspaceRoutingConfig,
} from "./attribution.ts";
import {
  type Attribution,
  type BatchManifest,
  type CollectorIdentity,
  IngestError,
  MAX_REQUEST_BYTES,
  parseEnvelope,
  sha256Hex,
} from "./contract.ts";
import { MemoryBudget } from "./memory_budget.ts";
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
// A client dropped only because one request ran out of time is retired
// gently: other requests in this isolate share it and may be mid-transaction.
function discardIngestBackend(
  dropped: Backend,
  reason: "broken" | "deadline" = "broken",
): void {
  if (backend === dropped) backend = null;
  if (reason === "deadline") dropped.batches.retire();
  else dropped.batches.abandon();
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
// A retry starts only while this much of the request's deadline is left. The
// deadline still bounds the retry, so a slow reconnect answers 503 in time.
export const DATABASE_RETRY_MIN_REMAINING_MS = 3_000;
export const DATABASE_RETRY_AFTER_SECONDS = 5;
const RETRYABLE_ERROR_CODES = new Set([
  "database_unavailable",
  "ingest_timeout",
  "storage_unavailable",
  "storage_verify_failed",
  "ingest_busy",
]);
// Body bytes this worker decodes at once. A batch peaks at a few times its
// body size; see memory_budget.ts.
export const INGEST_MEMORY_BUDGET_BYTES = 24 * 1024 * 1024;
// A request waiting for the budget stops while this much time is left to
// ingest it, and answers 503 ingest_busy instead.
export const BUSY_WAIT_RESERVE_MS = 8_000;
const workerMemory = new MemoryBudget(INGEST_MEMORY_BUDGET_BYTES);
// The database and its pooler are in us-east-1. An upload makes ~25
// sequential pooler round trips; served from ap-south-1 (most traffic on
// Nov 2) each costs ~250 ms, so requests took a p50 of 8.4 s against 0.6 s in
// us-east-1, and held the per-person attribution lock for ~1.8 s. One hop to
// us-east-1 is cheaper. Set SHERLOCK_INGEST_DATABASE_REGION=off to disable.
export const DEFAULT_DATABASE_REGION = "us-east-1";
export const FORWARDED_FROM_HEADER = "x-sherlock-forwarded-from";
// The forwarding request's time left, so the forwarded one answers first.
export const FORWARDED_DEADLINE_HEADER = "x-sherlock-deadline-ms";
// Ingesting here after a failed forward needs time for a slow connect.
export const FORWARD_FALLBACK_MIN_REMAINING_MS = 8_000;
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "user-agent",
  "x-sherlock-workload-class",
];
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "retry-after",
];
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
  discardBackend: (dropped: Backend, reason: "broken" | "deadline") => void,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => number,
  requestStartedAt: number,
  requestDeadlineMs: number,
  work: (current: Backend) => Promise<T>,
): Promise<T> {
  const remainingMs = () => requestStartedAt + requestDeadlineMs - now();
  for (let attempt = 1;; attempt += 1) {
    const current = backendFactory();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(DEADLINE),
        Math.max(0, remainingMs()),
      );
    });
    const running = work(current);
    running.catch(() => undefined); // settles after abandon when it loses
    try {
      return await Promise.race([running, deadline]);
    } catch (error) {
      if (error === DEADLINE) {
        discardBackend(current, "deadline");
        console.error(`ingest passed its deadline (attempt ${attempt})`);
        throw new IngestError(
          "ingest_timeout",
          "ingest did not finish in time; retry later",
          503,
        );
      }
      if (!isDatabaseConnectionError(error)) throw error;
      discardBackend(current, "broken");
      const retry = attempt < DATABASE_ATTEMPTS &&
        remainingMs() >= DATABASE_RETRY_MIN_REMAINING_MS;
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
    fetcher = fetch,
    memoryBudget = workerMemory,
  }: {
    environment?: EnvironmentReader;
    backendFactory?: typeof ingestBackend;
    discardBackend?: typeof discardIngestBackend;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
    requestDeadlineMs?: number;
    fetcher?: typeof fetch;
    memoryBudget?: MemoryBudget;
  } = {},
): Promise<Response> {
  const requestStartedAt = now();
  requestDeadlineMs = Math.min(
    requestDeadlineMs,
    forwardedDeadlineMs(request) ?? requestDeadlineMs,
  );
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
  let release = () => {};
  try {
    if (request.method !== "POST") {
      return Response.json({ error: { code: "method_not_allowed" } }, {
        status: 405,
      });
    }
    if (requestDeadlineMs < DATABASE_RETRY_MIN_REMAINING_MS) {
      // Too little time to do anything but drop the shared client.
      throw new IngestError(
        "ingest_timeout",
        "ingest did not finish in time; retry later",
        503,
      );
    }
    let bytes: Uint8Array | null = await readBodyBounded(request);
    const forwardTo = databaseRegionToForwardTo(request, environment);
    if (forwardTo) {
      // Forwarding holds the body once and decodes nothing, so it takes no
      // share of the budget.
      const forwarded = await forwardToDatabaseRegion(
        request,
        bytes,
        forwardTo,
        required("SUPABASE_URL", environment),
        environment("SB_REGION") ?? "",
        fetcher,
        () => requestStartedAt + requestDeadlineMs - now(),
      );
      if (forwarded) return forwarded;
    }
    release = await memoryBudget.reserve(
      bytes.byteLength,
      requestStartedAt + requestDeadlineMs - now() - BUSY_WAIT_RESERVE_MS,
    );
    let body: unknown = parseJson(bytes);
    // Only the decoded batch is needed from here; the raw body and its
    // base64 text would otherwise stay in memory until the response.
    bytes = null;
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
    body = undefined;
    const grant = publicCollectorGrant(routing(), envelope.collector);
    const workloadClassHint = parseWorkloadClassHint(
      request.headers.get("x-sherlock-workload-class"),
    );
    const receipt = await database(async (current) => {
      let attribution: Attribution | null = null;
      try {
        attribution = await current.batches.resolveAttribution(
          grant,
          envelope.collector,
        );
        return await current.service.ingest(
          attribution,
          envelope.manifest,
          envelope.stored_payload,
          workloadClassHint,
          () => requestStartedAt + requestDeadlineMs - now(),
        );
      } catch (error) {
        if (error instanceof IngestError && error.status === 409) {
          // Not awaited: logging must not hold the answer past its deadline.
          void logConflict(error, grant, envelope.collector, envelope.manifest);
        }
        throw error;
      }
    });
    return Response.json(receipt, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof IngestError) {
      const headers: Record<string, string> = { "Cache-Control": "no-store" };
      if (
        RETRYABLE_ERROR_CODES.has(error.code)
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
  } finally {
    release();
  }
}

// A short, stable stand-in for an identifier in logs.
async function logKey(value: string): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode(value))).slice(0, 12);
}

// One line per refused batch, so repeated 409s can be traced to a collector
// and a reason (Nov 4: 8,942 a day from one address, 15 distinct batches).
// Keys are hashed; no email, path or content is logged.
async function logConflict(
  error: IngestError,
  grant: CollectorGrant,
  identity: CollectorIdentity,
  manifest: BatchManifest,
): Promise<void> {
  try {
    const collectorKey = await collectorKeyForIdentity(grant, identity);
    console.warn(JSON.stringify({
      event: "ingest_conflict",
      code: error.code,
      collector: await logKey(`${grant.workspace_id}/${collectorKey}`),
      stream: await logKey(
        `${manifest.source_kind}/${manifest.source_stream_key}`,
      ),
      source_kind: manifest.source_kind,
      generation_seq: manifest.generation_seq,
      start_offset: manifest.start_offset,
      end_offset: manifest.end_offset,
      record_count: manifest.record_count,
      collector_version: manifest.collector_version,
    }));
  } catch {
    // Logging must never change the answer.
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

// Only a forwarded request may shorten its own deadline, never lengthen it.
function forwardedDeadlineMs(request: Request): number | null {
  if (!request.headers.has(FORWARDED_FROM_HEADER)) return null;
  const value = Number(request.headers.get(FORWARDED_DEADLINE_HEADER));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// Forward only from a known region that is not the database's, and never a
// request that was already forwarded (x-region is honoured, but a request
// that lands elsewhere anyway must not bounce).
export function databaseRegionToForwardTo(
  request: Request,
  environment: EnvironmentReader,
): string | null {
  const target = environment("SHERLOCK_INGEST_DATABASE_REGION") ??
    DEFAULT_DATABASE_REGION;
  const here = environment("SB_REGION");
  if (!here || target === "off" || here === target) return null;
  if (request.headers.has(FORWARDED_FROM_HEADER)) return null;
  return target;
}

// Returns the forwarded request's own answer, or null to process here when
// the database region could not be reached or the platform answered instead
// of the function (a gateway 429/5xx, say). Processing twice is safe: every
// write is idempotent. Without time for that, it answers 503.
async function forwardToDatabaseRegion(
  request: Request,
  bytes: Uint8Array,
  region: string,
  supabaseUrl: string,
  here: string,
  fetcher: typeof fetch,
  remainingMs: () => number,
): Promise<Response | null> {
  const timeoutMs = Math.max(0, remainingMs());
  if (timeoutMs - 1_000 < DATABASE_RETRY_MIN_REMAINING_MS) {
    throw new IngestError(
      "ingest_timeout",
      "ingest did not finish in time; retry later",
      503,
    );
  }
  const headers = new Headers({ "x-region": region });
  headers.set(FORWARDED_FROM_HEADER, here || "unknown");
  headers.set(
    FORWARDED_DEADLINE_HEADER,
    String(Math.max(1, Math.floor(timeoutMs - 1_000))),
  );
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const url = new URL(supabaseUrl);
  url.pathname = "/functions/v1/sherlock-rollout-ingest";
  url.search = "";
  url.searchParams.set("forceFunctionRegion", region);
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers,
      body: bytes as Uint8Array<ArrayBuffer>,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const answer = new Uint8Array(await response.arrayBuffer());
    if (response.status === 200 || isFunctionError(answer)) {
      const passed = new Headers();
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) passed.set(name, value);
      }
      return new Response(answer, { status: response.status, headers: passed });
    }
    console.error(
      `forward to ${region} answered ${response.status} without an ingest error`,
    );
  } catch (error) {
    if ((error as { name?: unknown })?.name === "TimeoutError") {
      console.error(`forward to ${region} passed the deadline`);
      throw new IngestError(
        "ingest_timeout",
        "ingest did not finish in time; retry later",
        503,
      );
    }
    console.error(`forward to ${region} failed`, error);
  }
  if (remainingMs() < FORWARD_FALLBACK_MIN_REMAINING_MS) {
    throw new IngestError(
      "ingest_timeout",
      "ingest did not finish in time; retry later",
      503,
    );
  }
  console.error(`ingesting in ${here || "this region"} instead`);
  return null;
}

// This function's own error bodies are {"error":{"code":...}}; anything else
// came from the platform in front of it.
function isFunctionError(body: Uint8Array): boolean {
  try {
    const value = JSON.parse(new TextDecoder().decode(body));
    return typeof value?.error?.code === "string";
  } catch {
    return false;
  }
}

async function readBodyBounded(request: Request): Promise<Uint8Array> {
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
  // One buffer of the declared size; chunks are joined only when the
  // length is missing or wrong.
  let buffer = Number.isSafeInteger(declaredLength) && declaredLength > 0
    ? new Uint8Array(declaredLength)
    : null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new IngestError(
        "payload_too_large",
        "request body exceeds 24 MiB",
        413,
      );
    }
    if (buffer && total + value.byteLength <= buffer.byteLength) {
      buffer.set(value, total);
    } else {
      if (buffer) {
        chunks.push(buffer.subarray(0, total));
        buffer = null;
      }
      chunks.push(value);
    }
    total += value.byteLength;
  }
  if (buffer) {
    // A shorter body than declared is copied so the spare bytes are freed.
    return total === buffer.byteLength ? buffer : buffer.slice(0, total);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new IngestError("invalid_request", "request body must be JSON", 400);
  }
}

export default { fetch: handler };
