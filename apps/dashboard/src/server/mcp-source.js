import { FlameSourceError } from "./flame-source.js";

export const MCP_USAGE_PAGE_LIMIT = 20;

const USAGE_CURSOR_VERSION = "u1";
const MAX_USAGE_CURSOR_LENGTH = 128;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function encodeUsageCursor(personId) {
  if (typeof personId !== "string" || !UUID_PATTERN.test(personId)) {
    throw new FlameSourceError("flame_usage_cursor_invalid");
  }
  return `${USAGE_CURSOR_VERSION}.${Buffer.from(personId, "utf8").toString("base64url")}`;
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
  if (Buffer.from(decoded, "utf8").toString("base64url") !== body ||
      !UUID_PATTERN.test(decoded)) {
    throw new FlameSourceError("flame_usage_cursor_invalid");
  }
  return decoded;
}

export function pageCachedUsageEvidence(payload, cursor = "") {
  if (!payload || !Array.isArray(payload.people)) {
    throw new FlameSourceError("flame_database_result_invalid");
  }
  const afterPersonId = decodeUsageCursor(cursor);
  const people = [...payload.people].sort((left, right) => {
    const leftId = String(left?.id ?? "");
    const rightId = String(right?.id ?? "");
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const ids = new Set();
  for (const person of people) {
    const personId = person?.id;
    if (typeof personId !== "string" || !UUID_PATTERN.test(personId) || ids.has(personId)) {
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
    nextCursor: hasMore ? encodeUsageCursor(selected.at(-1).id) : null,
  };
}

export function createCachedMcpSource({ cache, source }) {
  if (typeof cache?.read !== "function" || typeof source?.fetchPromptEvidence !== "function") {
    throw new TypeError("A timeline cache and prompt evidence source are required");
  }
  return Object.freeze({
    async fetchUsageEvidence({ cursor = "", signal } = {}) {
      const { payload } = await cache.read({ signal });
      return pageCachedUsageEvidence(payload, cursor);
    },
    async fetchPromptEvidence(request) {
      return await source.fetchPromptEvidence(request);
    },
  });
}
