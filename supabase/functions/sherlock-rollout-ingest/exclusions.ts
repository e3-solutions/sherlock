import {
  type CollectorIdentity,
  IngestError,
  parseCollectorIdentity,
} from "./contract.ts";

// Collectors report the session ids their owner excluded locally so copies
// uploaded before the exclusion are hidden server-side (COR-5002). Reports are
// additive: the server never deletes on this path, so an emptied or corrupted
// local policy file cannot un-hide anything.
export const EXCLUSIONS_OPERATION = "exclusions";
export const MAX_EXCLUDED_SESSION_IDS = 5_000;

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ExclusionsRequest {
  collector: CollectorIdentity;
  excluded_session_ids: string[];
}

export interface ExclusionsReceipt {
  accepted: number;
  total: number;
}

export interface ExclusionsRepository {
  recordOwnerExclusions(
    attribution: { workspace_id: string; person_id: string },
    nativeSessionIds: readonly string[],
  ): Promise<ExclusionsReceipt>;
}

// Requests carrying "op" are operations; batch envelopes never carry it.
export function requestOperation(body: unknown): string | null {
  if (
    body === null || typeof body !== "object" || Array.isArray(body) ||
    !Object.hasOwn(body, "op")
  ) {
    return null;
  }
  const op = (body as Record<string, unknown>).op;
  if (op !== EXCLUSIONS_OPERATION) {
    throw new IngestError(
      "unsupported_operation",
      "op must be exclusions or absent",
      400,
    );
  }
  return op;
}

export function parseExclusionsRequest(value: unknown): ExclusionsRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IngestError("invalid_request", "request must be an object", 400);
  }
  const input = value as Record<string, unknown>;
  const collector = parseCollectorIdentity(input.collector);
  const raw = input.excluded_session_ids;
  if (!Array.isArray(raw)) {
    throw new IngestError(
      "invalid_exclusions",
      "excluded_session_ids must be an array",
      400,
    );
  }
  if (raw.length > MAX_EXCLUDED_SESSION_IDS) {
    throw new IngestError(
      "payload_too_large",
      `excluded_session_ids exceeds ${MAX_EXCLUDED_SESSION_IDS}`,
      413,
    );
  }
  const ids = new Set<string>();
  for (const item of raw) {
    const id = typeof item === "string" ? item.toLowerCase() : null;
    if (id === null || !SESSION_ID.test(id)) {
      throw new IngestError(
        "invalid_exclusions",
        "excluded_session_ids must contain only UUIDs",
        400,
      );
    }
    ids.add(id);
  }
  return { collector, excluded_session_ids: [...ids].sort() };
}
