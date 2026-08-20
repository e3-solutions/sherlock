import { publicCollectorGrant } from "./attribution.ts";
import { IngestError, MAX_REQUEST_BYTES, parseEnvelope } from "./contract.ts";
import { PostgresBatchRepository } from "./postgres.ts";
import { IngestService, type WorkloadClassHint } from "./service.ts";
import { SupabaseImmutableStorage } from "./storage.ts";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new IngestError("invalid_configuration", `${name} is required`, 500);
  }
  return value;
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
  const databaseUrl = required("SUPABASE_DB_URL");
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
  try {
    if (request.method !== "POST") {
      return Response.json({ error: { code: "method_not_allowed" } }, {
        status: 405,
      });
    }
    const grant = publicCollectorGrant(required("SHERLOCK_WORKSPACE_ID"));
    const body = await readJsonBounded(request);
    const envelope = parseEnvelope(body);
    const current = ingestBackend();
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
