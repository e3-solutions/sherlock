import { authenticate, parseCollectorConfigurations } from "./auth.ts";
import { publicCollectorGrant } from "./attribution.ts";
import {
  type Attribution,
  BULK_CONTENT_TYPE,
  BULK_RECEIPT_VERSION,
  type CollectorIdentity,
  type CommittedReceipt,
  type IngestEnvelope,
  IngestError,
  MAX_REQUEST_BYTES,
  parseBulkEnvelope,
  parseEnvelope,
} from "./contract.ts";
import { PostgresBatchRepository } from "./postgres.ts";
import { IngestService } from "./service.ts";
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
  const batches = PostgresBatchRepository.connect(required("SUPABASE_DB_URL"));
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

async function handler(request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return Response.json({ error: { code: "method_not_allowed" } }, {
        status: 405,
      });
    }
    const body = await readBodyBounded(request);
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]
      .trim().toLowerCase();
    const current = ingestBackend();
    if (contentType === BULK_CONTENT_TYPE) {
      const envelopes = await parseBulkEnvelope(body);
      const attribution = await resolveAttribution(
        request,
        current.batches,
        envelopes.map((envelope) => envelope.collector),
      );
      const receipts = await ingestMany(
        current.service,
        attribution,
        envelopes,
      );
      return Response.json({
        receipt_version: BULK_RECEIPT_VERSION,
        receipts,
      }, {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (contentType !== "application/json") {
      throw new IngestError(
        "unsupported_media_type",
        "content-type must be JSON or Sherlock bulk v2",
        415,
      );
    }
    const envelope = parseEnvelope(decodeJson(body));
    const attribution = await resolveAttribution(
      request,
      current.batches,
      [envelope.collector],
    );
    const receipt = await current.service.ingest(
      attribution,
      envelope.manifest,
      envelope.stored_payload,
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

async function ingestMany(
  service: IngestService,
  attribution: Attribution,
  envelopes: IngestEnvelope[],
): Promise<CommittedReceipt[]> {
  const receipts: CommittedReceipt[] = [];
  for (const envelope of envelopes) {
    receipts.push(
      await service.ingest(
        attribution,
        envelope.manifest,
        envelope.stored_payload,
      ),
    );
  }
  return receipts;
}

async function resolveAttribution(
  request: Request,
  batches: PostgresBatchRepository,
  collectors: Array<CollectorIdentity | null>,
): Promise<Attribution> {
  const identified = collectors.filter(
    (collector): collector is CollectorIdentity => collector !== null,
  );
  if (identified.length === collectors.length && identified.length > 0) {
    const canonical = JSON.stringify(identified[0]);
    if (
      identified.some((collector) => JSON.stringify(collector) !== canonical)
    ) {
      throw new IngestError(
        "invalid_identity",
        "bulk request must use one collector identity",
        400,
      );
    }
    return await batches.resolveAttribution(
      publicCollectorGrant(required("SHERLOCK_WORKSPACE_ID")),
      identified[0],
    );
  }
  if (identified.length !== 0 || collectors.length === 0) {
    throw new IngestError(
      "invalid_identity",
      "bulk request cannot mix identified and legacy collectors",
      400,
    );
  }
  return await authenticate(
    request.headers.get("authorization"),
    parseCollectorConfigurations(required("SHERLOCK_COLLECTORS_JSON")),
  );
}

async function readBodyBounded(request: Request): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new IngestError(
      "payload_too_large",
      "request body exceeds 12 MiB",
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
        "request body exceeds 12 MiB",
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
  return bytes;
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new IngestError("invalid_request", "request body must be JSON", 400);
  }
}

export default { fetch: handler };
