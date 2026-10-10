// @vitest-environment node
import postgres from "postgres";
import { createServer } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, it, expect } from "vitest";
import { collectCloudActivity, createRecoverySink, validateScope } from "./cloud-activity.js";
import { readRecovery, recoveredIntervalWork, mergeRecoveredTimeline } from "./thread-activity-recovery.js";
import { createMcpHttpRoute } from "./mcp-http.js";
import { createBonaparteMcpProtocol } from "./mcp-server.js";

const databaseUrl = process.env.SHERLOCK_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("private cloud recovery PostgreSQL integration", () => {
  it("commits, deduplicates and queries real rows under existing roles; denies reader/anonymous writes", async () => {
    const sql = postgres(databaseUrl, { max: 1, prepare: false });
    // This suite runs only against the explicitly supplied isolated test DB.
    // Immutable synthetic fixtures expire when that database is destroyed.
    const workspaceId = crypto.randomUUID(), personId = crypto.randomUUID(), threadId = crypto.randomUUID();
    const turnId = crypto.randomUUID(), startedAt = 1791172800;
    const scope = { workspaceId, personId, sourceIdentity: "synthetic-postgres", rootThreadId: threadId,
      sessions: [{ threadId, role: "agent" }] };
    const response = { schemaVersion: 1, thread: { id: threadId, kind: "chatgpt" },
      page: { order: "newest_first", hasMore: false, nextCursor: null },
      turns: [{ id: turnId, status: "completed", startedAt, completedAt: startedAt + 300,
        items: [{ text: "NEVER_PERSIST_THIS" }] }] };
    const store = () => ({ runExclusive: (fn) => fn(), load: async () => null, save: async () => {} });
    try {
      await sql.unsafe("insert into telemetry.workspaces (id, slug, name) values ($1, $2, 'Synthetic cloud activity')", [workspaceId, `cloud-test-${workspaceId}`]);
      await sql.unsafe(`insert into telemetry.people (workspace_id, id, identity_key, display_name, email)
        values ($1, $2, $3, 'Synthetic cloud', 'cloud-fixture@e3group.ai')`, [workspaceId, personId, `cloud-fixture-${personId}`]);
      const sink = createRecoverySink(sql, scope);
      const run = () => collectCloudActivity({ scope, store: store(), sink, readThread: async () => response, now: () => startedAt + 1000 });
      const receipt = await run(); await run();
      const rows = await sql.unsafe("select * from telemetry.thread_activity_recovery_batches where workspace_id=$1", [workspaceId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].manifest_sha256).toBe(receipt.manifestSha256);
      expect(rows[0].manifest_text).not.toContain("NEVER_PERSIST_THIS");
      const intervals = await sql.begin("isolation level repeatable read read only", async (tx) => {
        await tx.unsafe("set local role sherlock_reader");
        const [snapshot] = await tx.unsafe("select pg_current_snapshot()::text snapshot, clock_timestamp()::text read");
        return readRecovery(tx, { workspaceId, ...snapshot, expectedEmailDomain: "e3group.ai" });
      });
      expect(intervals).toHaveLength(1);
      expect(recoveredIntervalWork(intervals, personId, startedAt * 1000)[0]).toMatchObject({ sessionId: threadId, eventCount: null });
      // Real source projection -> PostgreSQL -> reader SQL -> authenticated MCP.
      const read = new Date().toISOString();
      const payload = mergeRecoveredTimeline({ start: new Date(startedAt * 1000).toISOString(), read,
        snapshot: `v4.${Buffer.from(JSON.stringify(["100:100:", read])).toString("base64url")}`,
        people: [{ id: personId, name: "Synthetic cloud", total: [0, 0, 0], buckets: Array.from({ length: 144 }, () => [0, 0, 0, 0]) }] }, intervals);
      const protocol = createBonaparteMcpProtocol({ fetchUsageEvidence: async () => payload,
        fetchPromptEvidence: async () => { throw new Error("No synthetic prompts available"); } });
      const token = "synthetic-test-token-".repeat(2);
      const route = createMcpHttpRoute({ protocolHandler: protocol.handler, token });
      const server = createServer((request, response) => void route(request, response));
      const client = new Client({ name: "cloud-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
      try {
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
        expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
        const result = await client.callTool({ name: "list_usage_evidence", arguments: {} });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent.people[0]).toMatchObject({ primaryAgentSessionCount: 1, primaryHumanPromptCount: 0 });
        expect(result.structuredContent.provenance.recovery.sourceHashes).toEqual([receipt.manifestSha256]);
        expect(JSON.stringify(result)).not.toContain("NEVER_PERSIST_THIS");
      } finally {
        await client.close(); await protocol.close();
        await new Promise((resolve) => server.close(resolve));
      }
      const foreign = await sql.begin(async (tx) => {
        await tx.unsafe("set local role sherlock_reader");
        const [snapshot] = await tx.unsafe("select pg_current_snapshot()::text snapshot, clock_timestamp()::text read");
        return readRecovery(tx, { workspaceId: crypto.randomUUID(), ...snapshot, expectedEmailDomain: "e3group.ai" });
      });
      expect(foreign).toEqual([]);
      for (const role of ["anon", "authenticated", "sherlock_reader"]) {
        await expect(sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx.unsafe(`insert into telemetry.thread_activity_recovery_batches
            (workspace_id, person_id, manifest_text, manifest_sha256) values ($1, $2, $3, $4)`,
          [workspaceId, personId, rows[0].manifest_text, rows[0].manifest_sha256]);
        })).rejects.toMatchObject({ code: "42501" });
      }
      await expect(sql.begin(async (tx) => {
        await tx.unsafe("set local role anon");
        await tx.unsafe("select manifest_text from telemetry.thread_activity_recovery_batches");
      })).rejects.toMatchObject({ code: "42501" });
      // A reader login cannot acquire the ingestion role. Do not expand grants.
      const deniedConnection = { begin: (fn) => sql.begin(async (tx) => {
        await tx.unsafe("set local session authorization sherlock_reader");
        return fn(tx);
      }) };
      await expect(createRecoverySink(deniedConnection, scope).commit({ scope: validateScope(scope),
        manifestText: rows[0].manifest_text, manifestSha256: rows[0].manifest_sha256 })).rejects.toMatchObject({ code: "42501" });
    } finally { await sql.end(); }
  });
});
