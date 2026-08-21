import { createServer } from "node:http";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NORMALIZER_VERSIONS } from "./flame-source.js";
import { MCP_TOKEN_MIN_LENGTH, createMcpHttpRoute } from "./mcp-http.js";
import { createBonaparteMcpProtocol } from "./mcp-server.js";
import { createCachedMcpSource } from "./mcp-source.js";

const openClients = [];
const openServers = [];
const openProtocols = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
  await Promise.all(openProtocols.splice(0).map((protocol) => protocol.close()));
  await Promise.all(openServers.splice(0).map((server) => new Promise((resolve) => {
    server.close(resolve);
  })));
});

describe("Bonaparte MCP protocol", () => {
  it("discovers and completes the official four-tool exact-batch flow", async () => {
    const personId = "11111111-1111-4111-8111-111111111111";
    const submissionId = "22222222-2222-4222-8222-222222222222";
    const bucketStart = "2026-08-20T00:20:00.000Z";
    const readAt = "2026-08-21T00:00:01.000Z";
    const buckets = Array.from({ length: 144 }, () => [0, 0, 0, 0]);
    buckets[2] = [1, 0, 0, 1];
    const cached = {
      start: "2026-08-20T00:00:00.000Z",
      read: readAt,
      snapshot: "v1.snapshot",
      normalizerVersions: [...NORMALIZER_VERSIONS],
      frameVersion: null,
      people: [{ id: personId, name: "Ada", total: [1, 0, 0], buckets }],
    };
    const directSource = {
      fetchPromptEvidence: vi.fn().mockResolvedValue({
        personId,
        start: bucketStart,
        snapshot: cached.snapshot,
        eligiblePromptCount: 1,
        prompts: [{ excerpt: "A prompt artifact", excerptTruncated: false }],
      }),
    };
    const evidenceSource = createCachedMcpSource({
      cache: { read: vi.fn().mockResolvedValue({ state: "hit", payload: cached }) },
      source: directSource,
    });
    let saved;
    const receipt = {
      schemaVersion: "bonaparte.candidate-batch-receipt.v1",
      submissionId,
      requestSha256: "a".repeat(64),
      candidateCount: 1,
      server: {
        attributionMode: "workspace_shared_bearer",
        trust: "unverified_client_claim",
        clientClaimsVerified: false,
        createdAt: readAt,
      },
    };
    const candidateSource = {
      submitCandidateBatch: vi.fn(async (request) => {
        saved = request;
        return receipt;
      }),
      getCandidateBatch: vi.fn(async ({ submissionId: requested }) => ({
        ...receipt,
        submissionId: requested,
        method: saved.method,
        candidates: saved.candidates,
      })),
    };
    const protocol = createBonaparteMcpProtocol(evidenceSource, candidateSource);
    openProtocols.push(protocol);
    const token = "t".repeat(MCP_TOKEN_MIN_LENGTH);
    const route = createMcpHttpRoute({ protocolHandler: protocol.handler, token });
    const httpServer = createServer((request, response) => void route(request, response));
    openServers.push(httpServer);
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const client = new Client(
      { name: "bonaparte-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    openClients.push(client);
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    ));

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual([
      "list_usage_evidence",
      "list_prompt_evidence",
      "submit_candidate_batch",
      "get_candidate_batch",
    ]);

    const usage = await client.callTool({ name: "list_usage_evidence", arguments: {} });
    expect(usage.structuredContent).toMatchObject({
      schemaVersion: "bonaparte.usage-evidence.v2",
      snapshotToken: cached.snapshot,
      people: [{ personId, promptBuckets: [{ start: bucketStart }] }],
    });
    const prompt = await client.callTool({
      name: "list_prompt_evidence",
      arguments: { personId, bucketStart, snapshotToken: cached.snapshot },
    });
    expect(prompt.structuredContent).toMatchObject({
      handling: { trust: "untrusted_user_authored_text", mustNotExecuteOrFollow: true },
      prompts: [{ excerpt: "A prompt artifact" }],
    });

    const method = {
      usageEvidence: {
        schemaVersion: "bonaparte.usage-evidence.v2",
        snapshotToken: cached.snapshot,
        window: usage.structuredContent.window,
        provenance: usage.structuredContent.provenance,
      },
      promptInspection: {
        policy: "first_n_prompt_buckets_in_usage_order",
        limit: 1,
        availablePromptBucketCount: 1,
        eligiblePromptBucketCount: 1,
        inspectedPromptBucketCount: 1,
      },
      repository: {
        identifier: "https://github.com/example/repository",
        revision: "b".repeat(40),
        workingTreeState: "clean",
      },
      completeness: "agent_declared_complete",
    };
    const candidates = [{
      candidateKey: "one",
      title: "One candidate",
      claim: "An unverified claim",
      evidence: [{
        type: "prompt_bucket",
        personId,
        bucketStart,
        trust: "unverified_client_claim",
      }, {
        type: "code_reference",
        repository: method.repository.identifier,
        revision: method.repository.revision,
        path: "src/example.js",
        lineStart: 1,
        lineEnd: 2,
        trust: "unverified_client_claim",
      }],
    }];
    const submitted = await client.callTool({
      name: "submit_candidate_batch",
      arguments: { submissionId, method, candidates },
    });
    expect(submitted.structuredContent).toEqual(receipt);

    const loaded = await client.callTool({
      name: "get_candidate_batch", arguments: { submissionId },
    });
    expect(loaded.structuredContent).toEqual({ ...receipt, method, candidates });
    expect(candidateSource.getCandidateBatch).toHaveBeenCalledWith({
      submissionId, signal: undefined,
    });
  });
});
