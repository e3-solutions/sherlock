import { IngestError, sha256Hex } from "./contract.ts";
import { SupabaseImmutableStorage } from "./storage.ts";

const PATH = "workspaces/test/immutable.jsonl.gz";

Deno.test("ambiguous Storage 500 converges on an identical committed object", async () => {
  const payload = new TextEncoder().encode("immutable payload");
  const responses = [
    new Response('{"error":"DatabaseError"}', { status: 500 }),
    new Response(payload, { status: 200 }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.resolve(responses.shift()!)) as typeof fetch;
  try {
    const storage = new SupabaseImmutableStorage(
      "https://project.supabase.co",
      "service-role",
    );
    await storage.ensure(PATH, payload, await sha256Hex(payload));
    if (responses.length !== 0) {
      throw new Error("expected upload and verification");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("ambiguous Storage 500 remains retryable when no object exists", async () => {
  const payload = new TextEncoder().encode("immutable payload");
  const responses = [
    new Response('{"error":"DatabaseError"}', { status: 500 }),
    new Response("missing", { status: 404 }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.resolve(responses.shift()!)) as typeof fetch;
  try {
    const storage = new SupabaseImmutableStorage(
      "https://project.supabase.co",
      "service-role",
    );
    try {
      await storage.ensure(PATH, payload, await sha256Hex(payload));
      throw new Error("expected storage failure");
    } catch (error) {
      if (!(error instanceof IngestError)) throw error;
      if (error.code !== "storage_upload_failed" || error.status !== 503) {
        throw error;
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("ambiguous Storage 500 rejects a different committed object", async () => {
  const payload = new TextEncoder().encode("immutable payload");
  const conflicting = new TextEncoder().encode("different payload");
  const responses = [
    new Response('{"error":"DatabaseError"}', { status: 500 }),
    new Response(conflicting, { status: 200 }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.resolve(responses.shift()!)) as typeof fetch;
  try {
    const storage = new SupabaseImmutableStorage(
      "https://project.supabase.co",
      "service-role",
    );
    try {
      await storage.ensure(PATH, payload, await sha256Hex(payload));
      throw new Error("expected integrity conflict");
    } catch (error) {
      if (!(error instanceof IngestError)) throw error;
      if (error.code !== "storage_integrity_conflict" || error.status !== 409) {
        throw error;
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
