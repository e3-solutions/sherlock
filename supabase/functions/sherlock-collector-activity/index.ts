/**
 * Hourly commit counters per collector for the Jolly Roger capture stall alert
 * (COR-5105). Counts and ids only, never content. The caller presents a
 * dedicated token; only its SHA-256 digest is configured here.
 */
const MAX_BODY = 131072;
const MAX_SESSION_IDS = 2000;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_LOOKBACK_MS = 40 * 24 * 3600 * 1000;

type Env = (name: string) => string | undefined;

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function sameDigest(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function backendKey(env: Env): string {
  const modern = env("SUPABASE_SECRET_KEYS");
  if (modern) {
    const key = (JSON.parse(modern) as Record<string, unknown>).default;
    if (typeof key === "string" && key.startsWith("sb_secret_")) return key;
  }
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  throw new Error("backend key unavailable");
}

export function validRequest(
  value: unknown,
  now: number,
): { since: string; session_ids: string[] } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some((key) => key !== "since" && key !== "session_ids")
  ) return null;
  const since = Date.parse(String(item.since));
  if (
    typeof item.since !== "string" || !Number.isFinite(since) || since > now ||
    since < now - MAX_LOOKBACK_MS
  ) return null;
  const ids = item.session_ids ?? [];
  if (
    !Array.isArray(ids) || ids.length > MAX_SESSION_IDS ||
    ids.some((id) => typeof id !== "string" || !SESSION_ID.test(id))
  ) return null;
  return { since: new Date(since).toISOString(), session_ids: ids as string[] };
}

export async function handle(
  request: Request,
  env: Env = (name) => Deno.env.get(name),
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }
  const expected = env("SHERLOCK_COLLECTOR_ACTIVITY_TOKEN_SHA256") ?? "";
  const token = request.headers.get("x-capture-alerts-token") ?? "";
  if (!token || !sameDigest(await sha256(token), expected)) {
    return json(401, { error: "token" });
  }
  const text = await request.text();
  if (text.length > MAX_BODY) return json(413, { error: "too_large" });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid_body" });
  }
  const query = validRequest(body, now());
  if (!query) return json(400, { error: "invalid_request" });
  const url = env("SUPABASE_URL");
  if (!url) return json(503, { error: "unavailable" });
  try {
    const key = backendKey(env);
    const headers: Record<string, string> = {
      apikey: key,
      "content-type": "application/json",
    };
    if (!key.startsWith("sb_secret_")) headers.authorization = `Bearer ${key}`;
    const response = await fetcher(
      `${url}/rest/v1/rpc/sherlock_collector_activity`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_since: query.since,
          p_session_ids: query.session_ids,
        }),
      },
    );
    if (!response.ok) return json(503, { error: "unavailable" });
    return json(200, await response.json());
  } catch {
    return json(503, { error: "unavailable" });
  }
}

if (import.meta.main) Deno.serve((request) => handle(request));
