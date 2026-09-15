import {
  type BatchManifest,
  IngestError,
  nullableTimestamp,
  sha256Hex,
  timestampMicros,
} from "./contract.ts";

export const PR_CONTEXT_VERSION = "sherlock.pr-context.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
export const REPOSITORY = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/;

export interface PrContextFact {
  record_index: number;
  event_id: string;
  operation: "link" | "retract";
  provider: "codex" | "claude_code";
  native_session_id: string;
  occurred_at: string;
  repository: string | null;
  pull_request_number: number | null;
  link_event_id: string | null;
  payload_sha256: string;
}

function invalid(): never {
  throw new IngestError(
    "invalid_pr_context",
    "invalid or mismatched explicit PR context sidecar",
    400,
  );
}

export async function projectPrContextBatch(
  manifest: BatchManifest,
  source: Uint8Array,
) {
  if (
    manifest.source_kind !== "collector" ||
    manifest.source_version !== PR_CONTEXT_VERSION ||
    manifest.record_count !== 1 || manifest.records.length !== 1 ||
    !manifest.observed_native_session_id ||
    !SESSION.test(manifest.observed_native_session_id) ||
    manifest.observed_parent_native_session_id !== null
  ) invalid();
  const locator = manifest.records[0];
  if (
    locator.parse_status !== "ok" ||
    locator.native_type !== PR_CONTEXT_VERSION ||
    locator.native_payload_type !== null
  ) invalid();
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(
        locator.source_start_offset - manifest.start_offset,
        locator.source_end_offset - manifest.start_offset,
      )),
    );
  } catch {
    invalid();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const value = raw as Record<string, unknown>;
  const {
    type,
    event_id,
    operation,
    provider,
    native_session_id,
    occurred_at,
  } = value;
  if (
    type !== PR_CONTEXT_VERSION || typeof event_id !== "string" ||
    !UUID.test(event_id) ||
    (operation !== "link" && operation !== "retract") ||
    provider !== manifest.source_provider ||
    native_session_id !== manifest.observed_native_session_id ||
    typeof occurred_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
      .test(occurred_at) ||
    !Number.isFinite(Date.parse(occurred_at))
  ) invalid();
  const allowed = new Set([
    "type",
    "event_id",
    "operation",
    "provider",
    "native_session_id",
    "occurred_at",
    ...(operation === "link"
      ? ["repository", "pull_request_number"]
      : ["link_event_id"]),
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
  let repository: string | null = null;
  let pull_request_number: number | null = null;
  let link_event_id: string | null = null;
  if (operation === "link") {
    if (typeof value.repository !== "string") invalid();
    repository = value.repository.toLowerCase();
    if (
      !REPOSITORY.test(repository) ||
      [".", ".."].includes(repository.split("/")[1]) ||
      !Number.isSafeInteger(value.pull_request_number) ||
      Number(value.pull_request_number) < 1 ||
      Number(value.pull_request_number) > 2147483647
    ) invalid();
    pull_request_number = Number(value.pull_request_number);
  } else {
    if (
      typeof value.link_event_id !== "string" ||
      !UUID.test(value.link_event_id) ||
      value.link_event_id === event_id
    ) invalid();
    link_event_id = value.link_event_id;
  }
  const fact: Omit<PrContextFact, "record_index" | "payload_sha256"> = {
    event_id,
    operation,
    provider: manifest.source_provider,
    native_session_id: manifest.observed_native_session_id,
    occurred_at: nullableTimestamp(occurred_at, "occurred_at")!,
    repository,
    pull_request_number,
    link_event_id,
  };
  return {
    session: null,
    events: [],
    session_scm: null,
    pr_context: {
      ...fact,
      record_index: locator.record_index,
      payload_sha256: await sha256Hex(
        new TextEncoder().encode(
          JSON.stringify({
            ...fact,
            occurred_at: timestampMicros(fact.occurred_at).toString(),
          }),
        ),
      ),
    },
  };
}
