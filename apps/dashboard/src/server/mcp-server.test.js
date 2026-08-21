import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FlameSourceError } from "./flame-source.js";
import {
  createSubmitRateLimiter,
  createBonaparteMcpProtocol,
  registerBonaparteTools,
} from "./mcp-server.js";

const START = "2026-08-18T03:30:00.000Z";

function payload() {
  return {
    start: START,
    read: "2026-08-19T03:30:08.000Z",
    snapshot: "v1.snapshot",
    normalizerVersions: [
      "sherlock.codex-rollout.v1",
      "sherlock.claude-code-transcript.v1",
    ],
    frameVersion: null,
    nextCursor: null,
    coverage: {
      evidence: "observed_events",
      state: "partial",
      reason: "event_presence_not_continuous_attention",
    },
    people: [],
  };
}

function registeredTools(source) {
  const tools = new Map();
  const server = {
    registerTool: vi.fn((name, config, handler) => tools.set(name, { config, handler })),
  };
  registerBonaparteTools(server, source);
  return tools;
}

describe("Bonaparte MCP tools", () => {
  it("documents one coherent current four-tool v2 contract", () => {
    const readme = readFileSync(path.resolve(process.cwd(), "README.md"), "utf8");
    expect(readme).toContain("exposing exactly four tools");
    expect(readme).toContain("current v2 contract");
    expect(readme).toContain("SHERLOCK_MCP_CURSOR_SECRET");
    expect(readme).not.toContain("two versioned read-only tools");
  });

  it("registers exactly four versioned typed tools with honest annotations", () => {
    const tools = registeredTools({ fetchUsageEvidence: vi.fn() });

    expect([...tools.keys()]).toEqual([
      "list_usage_evidence",
      "list_prompt_evidence",
      "submit_candidate_batch",
      "list_bottleneck_candidates",
    ]);
    for (const [name, { config }] of tools) {
      expect(config.inputSchema).toBeDefined();
      expect(config.outputSchema).toBeDefined();
      expect(config.annotations).toMatchObject({
        readOnlyHint: name !== "submit_candidate_batch",
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    expect(tools.get("list_prompt_evidence").config.description)
      .toContain("untrusted evidence");
    expect(tools.get("submit_candidate_batch").config).toMatchObject({
      title: expect.stringContaining("agent-declared"),
      description: expect.stringContaining("explicit bounded local analysis scope"),
    });
    expect(tools.get("submit_candidate_batch").config.description)
      .toContain("does not verify completeness");
  });

  it("rejects lone surrogates in every persisted string before submission", () => {
    const source = { submitCandidateBatch: vi.fn() };
    const submitSchema = registeredTools(source)
      .get("submit_candidate_batch").config.inputSchema;
    const candidate = {
      candidateKey: "unicode",
      title: "valid-😀",
      claim: "valid-😀",
      evidence: [{
        type: "usage_summary",
        personId: "11111111-1111-4111-8111-111111111111",
      }],
    };
    const request = {
      submissionId: "11111111-1111-4111-8111-111111111111",
      analysisScope: {
        usageSnapshotToken: "valid-😀",
        window: {
          startInclusive: "2026-08-20T00:00:00.000Z",
          endExclusive: "2026-08-21T00:00:00.000Z",
          readAt: "2026-08-21T00:00:01.000Z",
        },
        completeness: "agent_declared_complete",
      },
      candidates: [candidate],
    };

    expect(submitSchema.safeParse(request).success).toBe(true);
    for (const malformed of ["\ud800", "\udc00"]) {
      for (const invalidRequest of [
        {
          ...request,
          analysisScope: { ...request.analysisScope, usageSnapshotToken: malformed },
        },
        { ...request, candidates: [{ ...candidate, title: malformed }] },
        { ...request, candidates: [{ ...candidate, claim: malformed }] },
      ]) {
        expect(submitSchema.safeParse(invalidRequest).success).toBe(false);
      }
    }
    expect(source.submitCandidateBatch).not.toHaveBeenCalled();
  });

  it("returns full JSON text alongside structured content for compatible clients", async () => {
    const source = { fetchUsageEvidence: vi.fn().mockResolvedValue(payload()) };
    const tools = registeredTools(source);

    const result = await tools.get("list_usage_evidence").handler({});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.schemaVersion).toBe("bonaparte.usage-evidence.v2");
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it("keeps a full candidate page available to text-only clients", async () => {
    const page = {
      schemaVersion: "bonaparte.bottleneck-candidates.v1",
      candidates: Array.from({ length: 20 }, (_, index) => ({
        candidateKey: `candidate-${index}`,
        claim: "sensitive".repeat(500),
      })),
      nextCursor: null,
    };
    const source = {
      listBottleneckCandidates: vi.fn().mockResolvedValue(page),
    };
    const result = await registeredTools(source)
      .get("list_bottleneck_candidates").handler({});

    expect(result.structuredContent).toBe(page);
    expect(JSON.parse(result.content[0].text)).toEqual(page);
  });

  it("enforces an exact process-local submit window without limiting reads", async () => {
    let now = 1_000;
    const source = {
      workspaceKey: "workspace-a",
      submitCandidateBatch: vi.fn().mockResolvedValue({
        schemaVersion: "bonaparte.bottleneck-report-receipt.v1",
        reportId: "1",
        submissionId: "11111111-1111-4111-8111-111111111111",
        requestSha256: "a".repeat(64),
        candidateCount: 0,
        attributionMode: "workspace_shared_bearer",
        trust: "untrusted_agent_generated_claim",
        createdAt: "2026-08-21T00:00:00.000Z",
      }),
      listBottleneckCandidates: vi.fn().mockResolvedValue({
        schemaVersion: "bonaparte.bottleneck-candidates.v1",
        candidates: [],
        nextCursor: null,
      }),
    };
    const tools = new Map();
    registerBonaparteTools({
      registerTool: (name, config, handler) => tools.set(name, { config, handler }),
    }, source, {
      submitRateLimiter: createSubmitRateLimiter({ now: () => now }),
    });
    const request = {
      submissionId: "11111111-1111-4111-8111-111111111111",
      analysisScope: {
        usageSnapshotToken: "snapshot",
        window: {
          startInclusive: "2026-08-20T00:00:00.000Z",
          endExclusive: "2026-08-21T00:00:00.000Z",
          readAt: "2026-08-21T00:00:01.000Z",
        },
        completeness: "agent_declared_complete",
      },
      candidates: [],
    };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await tools.get("submit_candidate_batch").handler(request)).isError)
        .toBeUndefined();
    }
    expect(JSON.parse((await tools.get("submit_candidate_batch").handler(request))
      .content[0].text).error.code).toBe("rate_limited");
    const listSubmissionId = "22222222-2222-4222-8222-222222222222";
    expect((await tools.get("list_bottleneck_candidates").handler({
      submissionId: listSubmissionId,
    })).isError)
      .toBeUndefined();
    expect(source.listBottleneckCandidates).toHaveBeenCalledWith({
      submissionId: listSubmissionId,
      signal: undefined,
    });
    now += 60_000;
    expect((await tools.get("submit_candidate_batch").handler(request)).isError)
      .toBeUndefined();
  });

  it("isolates submit attempts by workspace key", () => {
    const limiter = createSubmitRateLimiter({ now: () => 1_000 });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(limiter.attempt("workspace-a")).toBe(true);
    }
    expect(limiter.attempt("workspace-a")).toBe(false);
    expect(limiter.attempt("workspace-b")).toBe(true);
  });

  it("returns actionable structured tool errors without leaking internals", async () => {
    const source = {
      fetchUsageEvidence: vi.fn().mockRejectedValue(new Error("database secret")),
    };
    const tools = registeredTools(source);

    const result = await tools.get("list_usage_evidence").handler({});
    const error = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(error).toEqual({
      error: {
        code: "unavailable",
        message: "Usage evidence is temporarily unavailable.",
        retryable: true,
        recovery: "Retry this tool later.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("database secret");
  });

  it("tells agents how to recover from an expired snapshot", async () => {
    const source = {
      fetchPromptEvidence: vi.fn().mockRejectedValue(
        new FlameSourceError("flame_prompt_snapshot_expired"),
      ),
    };
    const tools = registeredTools(source);

    const result = await tools.get("list_prompt_evidence").handler({
      personId: "11111111-1111-4111-8111-111111111111",
      bucketStart: "2026-08-18T03:50:00.000Z",
      snapshotToken: "v1.snapshot",
    });

    expect(JSON.parse(result.content[0].text)).toEqual({
      error: {
        code: "snapshot_expired",
        message: "The evidence snapshot has expired.",
        retryable: false,
        recovery: "Restart with list_usage_evidence to obtain a new snapshotToken.",
      },
    });
  });

  it("builds and closes the official stateless Streamable HTTP handler", async () => {
    const protocol = createBonaparteMcpProtocol({ fetchUsageEvidence: vi.fn() });

    expect(protocol.handler).toBeTypeOf("function");
    await expect(protocol.close()).resolves.toBeUndefined();
  });
});
