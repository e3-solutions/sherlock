import { assertEquals } from "jsr:@std/assert@1";
import { handle, validRequest } from "./index.ts";

const TOKEN = "t".repeat(43);
const NOW = Date.parse("2026-11-02T23:00:00Z");
const SID = "019a0000-0000-7000-8000-000000000001";

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function env(): Promise<(name: string) => string | undefined> {
  const values: Record<string, string> = {
    SHERLOCK_COLLECTOR_ACTIVITY_TOKEN_SHA256: await digest(TOKEN),
    SUPABASE_URL: "https://sherlock.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "service",
  };
  return (name) => values[name];
}

function request(body: unknown, token = TOKEN, method = "POST"): Request {
  return new Request("https://fn.invalid", {
    method,
    headers: { "x-capture-alerts-token": token },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

Deno.test("rejects a missing or wrong token before reading the database", async () => {
  let calls = 0;
  const fetcher = (() => {
    calls++;
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  const e = await env();
  assertEquals(
    (await handle(
      request({ since: "2026-11-01T00:00:00Z" }, ""),
      e,
      fetcher,
      () => NOW,
    )).status,
    401,
  );
  assertEquals(
    (await handle(
      request({ since: "2026-11-01T00:00:00Z" }, "x".repeat(43)),
      e,
      fetcher,
      () => NOW,
    )).status,
    401,
  );
  // An unset digest secret fails closed.
  assertEquals(
    (await handle(
      request({ since: "2026-11-01T00:00:00Z" }),
      () => undefined,
      fetcher,
      () => NOW,
    )).status,
    401,
  );
  assertEquals(calls, 0);
});

Deno.test("passes a bounded query to the service-role RPC and returns its result", async () => {
  let seen: { url: string; body: unknown; auth: string | null } | null = null;
  const fetcher = ((url: string, init: RequestInit) => {
    seen = {
      url,
      body: JSON.parse(String(init.body)),
      auth: new Headers(init.headers).get("authorization"),
    };
    return Promise.resolve(
      new Response(JSON.stringify({ collectors: [], sessions: {} })),
    );
  }) as unknown as typeof fetch;
  const response = await handle(
    request({ since: "2026-10-20T00:00:00Z", session_ids: [SID] }),
    await env(),
    fetcher,
    () => NOW,
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { collectors: [], sessions: {} });
  assertEquals(
    seen!.url,
    "https://sherlock.invalid/rest/v1/rpc/sherlock_collector_activity",
  );
  assertEquals(seen!.body, {
    p_since: "2026-10-20T00:00:00.000Z",
    p_session_ids: [SID],
  });
  assertEquals(seen!.auth, "Bearer service");
});

Deno.test("validates the window and session ids", () => {
  assertEquals(validRequest({ since: "2026-11-03T00:00:00Z" }, NOW), null);
  assertEquals(validRequest({ since: "2026-09-01T00:00:00Z" }, NOW), null);
  assertEquals(
    validRequest({ since: "2026-11-01T00:00:00Z", session_ids: ["../x"] }, NOW),
    null,
  );
  assertEquals(
    validRequest({ since: "2026-11-01T00:00:00Z", extra: 1 }, NOW),
    null,
  );
  assertEquals(
    validRequest({
      since: "2026-11-01T00:00:00Z",
      session_ids: new Array(2001).fill(SID),
    }, NOW),
    null,
  );
  assertEquals(validRequest({ since: "2026-11-01T00:00:00Z" }, NOW), {
    since: "2026-11-01T00:00:00.000Z",
    session_ids: [],
  });
});

Deno.test("only POST is served and backend failures read as unavailable", async () => {
  const e = await env();
  assertEquals(
    (await handle(request(null, TOKEN, "GET"), e, fetch, () => NOW)).status,
    405,
  );
  const failing = (() =>
    Promise.resolve(
      new Response("no", { status: 500 }),
    )) as unknown as typeof fetch;
  assertEquals(
    (await handle(
      request({ since: "2026-11-01T00:00:00Z" }),
      e,
      failing,
      () => NOW,
    )).status,
    503,
  );
});
