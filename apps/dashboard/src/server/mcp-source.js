import { createHash } from "node:crypto";

import { FlameSourceError } from "./flame-source.js";

export const MCP_USAGE_PAGE_LIMIT = 20;

const USAGE_CURSOR_VERSION = "u2";
export const MAX_USAGE_CURSOR_LENGTH = 512;
const UUID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

function snapshotDigest(snapshot) {
  if (typeof snapshot !== "string" || snapshot.length < 1 || snapshot.length > 8192) {
    throw new FlameSourceError("flame_usage_cursor_invalid");
  }
  return createHash("sha256").update(snapshot, "utf8").digest("hex");
}

export function encodeUsageCursor(snapshot, personId) {
  if (typeof personId !== "string" || !UUID_PATTERN.test(personId)) {
    throw new FlameSourceError("flame_usage_cursor_invalid");
  }
  const body = JSON.stringify({ s: snapshotDigest(snapshot), a: personId.toLowerCase() });
  return `${USAGE_CURSOR_VERSION}.${Buffer.from(body, "utf8").toString("base64url")}`;
}

export function decodeUsageCursor(cursor) {
  if (cursor === null || cursor === undefined || cursor === "") return null;
  if (typeof cursor !== "string" || cursor.length > MAX_USAGE_CURSOR_LENGTH) {
    throw new FlameSourceError("flame_usage_cursor_invalid");
  }
  const [version, body, extra] = cursor.split(".");
  if (version !== USAGE_CURSOR_VERSION || !body || extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/.test(body)) {
    throw new FlameSourceError("flame_usage_cursor_invalid");
  }
  const decoded = Buffer.from(body, "base64url").toString("utf8");
  let value;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new FlameSourceError("flame_usage_cursor_invalid");
  }
  if (Buffer.from(decoded, "utf8").toString("base64url") !== body ||
      !value || Object.keys(value).sort().join(",") !== "a,s" ||
      !UUID_PATTERN.test(value.a) || !/^[0-9a-f]{64}$/.test(value.s)) {
    throw new FlameSourceError("flame_usage_cursor_invalid");
  }
  return { snapshotSha256: value.s, afterPersonId: value.a.toLowerCase() };
}

export function pageCachedUsageEvidence(payload, cursor = "") {
  if (!payload || !Array.isArray(payload.people)) {
    throw new FlameSourceError("flame_database_result_invalid");
  }
  const decodedCursor = decodeUsageCursor(cursor);
  if (decodedCursor && decodedCursor.snapshotSha256 !== snapshotDigest(payload.snapshot)) {
    throw new FlameSourceError("flame_usage_snapshot_expired");
  }
  const afterPersonId = decodedCursor?.afterPersonId ?? null;
  const people = payload.people.map((person) => {
    const personId = person?.id;
    if (typeof personId !== "string" || !UUID_PATTERN.test(personId)) {
      throw new FlameSourceError("flame_database_result_invalid");
    }
    return { ...person, id: personId.toLowerCase() };
  }).sort((left, right) => {
    const leftId = String(left?.id ?? "");
    const rightId = String(right?.id ?? "");
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const ids = new Set();
  for (const person of people) {
    const personId = person?.id;
    if (ids.has(personId)) {
      throw new FlameSourceError("flame_database_result_invalid");
    }
    ids.add(personId);
  }
  const candidates = afterPersonId === null
    ? people
    : people.filter((person) => person.id > afterPersonId);
  const page = candidates.slice(0, MCP_USAGE_PAGE_LIMIT + 1);
  const hasMore = page.length > MCP_USAGE_PAGE_LIMIT;
  const selected = hasMore ? page.slice(0, MCP_USAGE_PAGE_LIMIT) : page;
  return {
    ...payload,
    people: selected,
    nextCursor: hasMore ? encodeUsageCursor(payload.snapshot, selected.at(-1).id) : null,
  };
}

export function createCachedMcpSource({ cache, source, candidateSource }) {
  if (typeof cache?.read !== "function" || typeof source?.fetchPromptEvidence !== "function") {
    throw new TypeError("A timeline cache and prompt evidence source are required");
  }
  const combined = {
    workspaceKey: candidateSource?.workspaceKey ?? "unconfigured",
    async fetchUsageEvidence({ cursor = "", signal } = {}) {
      const { payload } = await cache.read({ signal });
      return pageCachedUsageEvidence(payload, cursor);
    },
    async fetchPromptEvidence(request) {
      return await source.fetchPromptEvidence(request);
    },
  };
  if (candidateSource) {
    combined.submitCandidateBatch = async (request, options) =>
      await candidateSource.submitCandidateBatch(request, options);
    combined.listBottleneckCandidates = async (request) =>
      await candidateSource.listBottleneckCandidates(request);
  }
  return Object.freeze(combined);
}
