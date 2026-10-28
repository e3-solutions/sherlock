import { publicCollectorGrant, workspaceRoutingConfig } from "./attribution.ts";
import { IngestError, MAX_REQUEST_BYTES, parseEnvelope } from "./contract.ts";
import { parseExclusionsRequest, requestOperation } from "./exclusions.ts";
import {
  edgeFunctionDatabaseUrl,
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

let backend: {
  service: IngestService;
  batches: PostgresBatchRepository;
} | null = null;
function ingestBackend(): {
  service: IngestService;
  batches: PostgresBatchRepository;
} {
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

export async function handler(request: Request): Promise<Response> {
  return await handleRequest(request);
}

export async function handleRequest(
  request: Request,
  {
    environment = (name) => Deno.env.get(name),
    backendFactory = ingestBackend,
  }: {
    environment?: EnvironmentReader;
    backendFactory?: typeof ingestBackend;
  } = {},
): Promise<Response> {
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
      const current = backendFactory();
      const attribution = await current.batches.resolveAttribution(
        grant,
        exclusions.collector,
      );
      const receipt = await current.batches.recordOwnerExclusions(
        attribution,
        exclusions.excluded_session_ids,
      );
      return Response.json(receipt, {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const envelope = parseEnvelope(body);
    const grant = publicCollectorGrant(routing(), envelope.collector);
    const current = backendFactory();
    const attribution = await current.batches.resolveAttribution(
      grant,
      envelope.collector,
    );
    const receipt = await current.service.ingest(
      attribution,
      envelope.manifest,
      envelope.stored_payload,
      parseWorkloadClassHint(request.headers.get("x-sherlock-workload-class")),
    );
    return Response.json(receipt, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof IngestError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: { "Cache-Control": "no-store" } },
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
