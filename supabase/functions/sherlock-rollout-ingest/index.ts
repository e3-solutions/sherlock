import { authenticate, parseCollectorConfigurations } from "./auth.ts";
import {
  type Attribution,
  BULK_CONTENT_TYPE,
  BULK_RECEIPT_VERSION,
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

let service: IngestService | null = null;
function ingestService(): IngestService {
  if (service) return service;
  service = new IngestService(
    new SupabaseImmutableStorage(
      required("SUPABASE_URL"),
      required("SUPABASE_SERVICE_ROLE_KEY"),
    ),
    PostgresBatchRepository.connect(required("SUPABASE_DB_URL")),
  );
  return service;
}

async function handler(request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return Response.json({ error: { code: "method_not_allowed" } }, {
        status: 405,
      });
    }
    const configurations = parseCollectorConfigurations(
      required("SHERLOCK_COLLECTORS_JSON"),
    );
    const attribution = await authenticate(
      request.headers.get("authorization"),
      configurations,
    );
    const body = await readBodyBounded(request);
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]
      .trim().toLowerCase();
    if (contentType === BULK_CONTENT_TYPE) {
      const envelopes = await parseBulkEnvelope(body);
      const receipts = await ingestMany(attribution, envelopes);
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
    const receipt = await ingestService().ingest(
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
  attribution: Attribution,
  envelopes: IngestEnvelope[],
): Promise<CommittedReceipt[]> {
  const receipts: CommittedReceipt[] = [];
  for (const envelope of envelopes) {
    receipts.push(
      await ingestService().ingest(
        attribution,
        envelope.manifest,
        envelope.stored_payload,
      ),
    );
  }
  return receipts;
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
