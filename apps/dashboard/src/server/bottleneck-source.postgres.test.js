import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { BottleneckSource } from "./bottleneck-source.js";
import { MAX_MCP_BODY_BYTES } from "./mcp-http.js";
import { registerBonaparteTools } from "./mcp-server.js";

const DATABASE_URL = process.env.SHERLOCK_TEST_DATABASE_URL;
const describePostgres = DATABASE_URL ? describe : describe.skip;
const START = "2026-08-20T00:00:00.000Z";
const END = "2026-08-21T00:00:00.000Z";
const READ = "2026-08-21T00:00:01.000Z";
const REPOSITORY = "https://github.com/example/repository";
const REVISION = "a".repeat(40);

function batch(submissionId, count, claim = "claim") {
  return {
    submissionId,
    method: {
      usageEvidence: {
        schemaVersion: "bonaparte.usage-evidence.v2",
        snapshotToken: "v2.integration-snapshot",
        window: { startInclusive: START, endExclusive: END, readAt: READ },
        provenance: {
          evidenceContract: "sherlock.canonical-events.v1",
          normalizerVersions: [
            "sherlock.codex-rollout.v1",
            "sherlock.claude-code-transcript.v1",
          ],
          frameVersion: null,
          backwardCompatible: false,
          supersedes: "bonaparte.usage-evidence.v1",
        },
      },
      promptInspection: {
        policy: "first_n_prompt_buckets_in_usage_order",
        limit: 2,
        availablePromptBucketCount: 2,
        eligiblePromptBucketCount: 2,
        inspectedPromptBucketCount: 2,
      },
      repository: {
        identifier: REPOSITORY,
        revision: REVISION,
        workingTreeState: "clean",
      },
      completeness: "agent_declared_complete",
    },
    candidates: Array.from({ length: count }, (_, index) => ({
      candidateKey: `candidate-${index}`,
      title: `Candidate ${index}`,
      claim: `${claim} ${index}`,
      evidence: [{
        type: "code_reference",
        repository: REPOSITORY,
        revision: REVISION,
        path: `src/${index}.js`,
        lineStart: index + 1,
        lineEnd: index + 2,
        trust: "unverified_client_claim",
      }],
    })),
  };
}

function transportBoundaryBatch(submissionId) {
  const repository = "漢".repeat(512);
  const revision = "b".repeat(40);
  const codeReferences = Array.from({ length: 13 }, () => ({
    type: "code_reference",
    repository,
    revision,
    path: `${"漢".repeat(504)}.js`,
    lineStart: 1,
    lineEnd: 2,
    trust: "unverified_client_claim",
  }));
  const request = batch(submissionId, 0);
  request.method.promptInspection = {
    policy: "first_n_prompt_buckets_in_usage_order",
    limit: 0,
    availablePromptBucketCount: 0,
    eligiblePromptBucketCount: 0,
    inspectedPromptBucketCount: 0,
  };
  request.method.repository = {
    identifier: repository,
    revision,
    workingTreeState: "clean",
  };
  request.candidates = Array.from({ length: 50 }, (_, index) => ({
    candidateKey: `boundary-${index}`,
    title: "x",
    claim: "x",
    evidence: codeReferences,
  }));
  return request;
}

function mcpSubmitSchema() {
  let schema;
  registerBonaparteTools({
    registerTool(name, config) {
      if (name === "submit_candidate_batch") schema = config.inputSchema;
    },
  }, {}, {});
  return schema;
}

async function workerUrl(sql) {
  const password = `bottleneck-${crypto.randomUUID()}`;
  await sql.unsafe(`alter role sherlock_worker_login password '${password}'`);
  const url = new URL(DATABASE_URL);
  url.username = "sherlock_worker_login";
  url.password = password;
  return url.toString();
}

describePostgres("bottleneck PostgreSQL source", () => {
  it("round-trips exact ordered batches with idempotency and workspace isolation", async () => {
    const admin = postgres(DATABASE_URL, { max: 1, prepare: false });
    const databaseUrl = await workerUrl(admin);
    const workspaceId = crypto.randomUUID();
    const otherWorkspaceId = crypto.randomUUID();
    const source = new BottleneckSource({ databaseUrl, workspaceId, writesEnabled: true });
    const other = new BottleneckSource({
      databaseUrl, workspaceId: otherWorkspaceId, writesEnabled: true,
    });
    try {
      const empty = batch(crypto.randomUUID(), 0);
      const emptyReceipt = await source.submitCandidateBatch(empty);
      expect(emptyReceipt).toMatchObject({
        schemaVersion: "bonaparte.candidate-batch-receipt.v1",
        submissionId: empty.submissionId,
        candidateCount: 0,
        server: {
          attributionMode: "workspace_shared_bearer",
          trust: "unverified_client_claim",
          clientClaimsVerified: false,
        },
      });
      await expect(source.getCandidateBatch({ submissionId: empty.submissionId }))
        .resolves.toEqual({ ...emptyReceipt, method: empty.method, candidates: [] });

      const nonempty = batch(crypto.randomUUID(), 3);
      const receipt = await source.submitCandidateBatch(nonempty);
      const loaded = await source.getCandidateBatch({ submissionId: nonempty.submissionId });
      expect(loaded).toEqual({ ...receipt, method: nonempty.method, candidates: nonempty.candidates });
      expect(loaded.candidates.map(({ candidateKey }) => candidateKey)).toEqual([
        "candidate-0", "candidate-1", "candidate-2",
      ]);
      await expect(source.submitCandidateBatch(structuredClone(nonempty)))
        .resolves.toEqual(receipt);
      await expect(source.submitCandidateBatch({
        ...nonempty,
        candidates: [{ ...nonempty.candidates[0], claim: "changed" }],
      })).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(other.getCandidateBatch({ submissionId: nonempty.submissionId }))
        .rejects.toMatchObject({ code: "not_found" });

      const boundary = transportBoundaryBatch(crypto.randomUUID());
      const rpcBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "submit_candidate_batch", arguments: boundary },
      });
      expect(Buffer.byteLength(rpcBody)).toBeGreaterThan(2_000_000);
      expect(Buffer.byteLength(rpcBody)).toBeLessThanOrEqual(MAX_MCP_BODY_BYTES);
      const parsed = mcpSubmitSchema().safeParse(boundary);
      expect(parsed.success).toBe(true);
      const boundaryReceipt = await source.submitCandidateBatch(parsed.data);
      const stored = (await admin.unsafe(`
        select octet_length(candidates::text) as candidate_bytes
          from product.bottleneck_submissions
         where workspace_id = $1 and submission_id = $2
      `, [workspaceId, boundary.submissionId]))[0];
      expect(Number(stored.candidate_bytes)).toBeGreaterThan(MAX_MCP_BODY_BYTES);
      expect(Number(stored.candidate_bytes)).toBeLessThanOrEqual(
        MAX_MCP_BODY_BYTES + 65_536,
      );
      await expect(source.getCandidateBatch({ submissionId: boundary.submissionId }))
        .resolves.toEqual({
          ...boundaryReceipt,
          method: parsed.data.method,
          candidates: parsed.data.candidates,
        });
    } finally {
      await source.close();
      await other.close();
      await admin.unsafe(
        "delete from product.bottleneck_submissions where workspace_id in ($1, $2)",
        [workspaceId, otherWorkspaceId],
      );
      await admin.unsafe("alter role sherlock_worker_login password null");
      await admin.end({ timeout: 5 });
    }
  });

  it("settles concurrent equal retries and conflicts different requests", async () => {
    const admin = postgres(DATABASE_URL, { max: 1, prepare: false });
    const databaseUrl = await workerUrl(admin);
    const workspaceId = crypto.randomUUID();
    const source = new BottleneckSource({ databaseUrl, workspaceId, writesEnabled: true });
    try {
      const equal = batch(crypto.randomUUID(), 1);
      const receipts = await Promise.all(Array.from({ length: 8 }, () =>
        source.submitCandidateBatch(structuredClone(equal))
      ));
      expect(new Set(receipts.map(({ requestSha256 }) => requestSha256)).size).toBe(1);
      expect(new Set(receipts.map(({ server }) => server.createdAt)).size).toBe(1);

      const submissionId = crypto.randomUUID();
      const settled = await Promise.allSettled([
        source.submitCandidateBatch(batch(submissionId, 1, "left")),
        source.submitCandidateBatch(batch(submissionId, 1, "right")),
      ]);
      expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(settled.filter(({ status, reason }) =>
        status === "rejected" && reason.code === "idempotency_conflict"
      )).toHaveLength(1);
    } finally {
      await source.close();
      await admin.unsafe(
        "delete from product.bottleneck_submissions where workspace_id = $1",
        [workspaceId],
      );
      await admin.unsafe("alter role sherlock_worker_login password null");
      await admin.end({ timeout: 5 });
    }
  });

  it("uses the dedicated role and transaction-local twenty-second timeout", async () => {
    const admin = postgres(DATABASE_URL, { max: 1, prepare: false });
    const databaseUrl = await workerUrl(admin);
    const source = new BottleneckSource({
      databaseUrl, workspaceId: crypto.randomUUID(), writesEnabled: true,
    });
    try {
      const posture = await source.transaction(async (tx) => (await tx.unsafe(`
        select current_role, current_setting('statement_timeout') as timeout,
               current_setting('transaction_read_only') as read_only
      `))[0], { readOnly: true });
      expect(posture).toEqual({
        current_role: "sherlock_bottleneck_writer",
        timeout: "20s",
        read_only: "on",
      });
    } finally {
      await source.close();
      await admin.unsafe("alter role sherlock_worker_login password null");
      await admin.end({ timeout: 5 });
    }
  });
});
