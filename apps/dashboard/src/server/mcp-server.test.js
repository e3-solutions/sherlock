import { describe, expect, it, vi } from "vitest";

import { BottleneckSourceError } from "./bottleneck-source.js";
import { FlameSourceError, NORMALIZER_VERSIONS } from "./flame-source.js";
import { createBonaparteMcpProtocol, registerBonaparteTools } from "./mcp-server.js";

const START = "2026-08-20T00:00:00.000Z";
const END = "2026-08-21T00:00:00.000Z";
const READ = "2026-08-21T00:00:01.000Z";
const REPOSITORY = "https://github.com/example/repository";
const REVISION = "a".repeat(40);

function payload() {
  return {
    start: START,
    read: READ,
    snapshot: "v1.snapshot",
    normalizerVersions: NORMALIZER_VERSIONS,
    frameVersion: null,
    nextCursor: null,
    people: [],
  };
}

function method(overrides = {}) {
  return {
    usageEvidence: {
      schemaVersion: "bonaparte.usage-evidence.v2",
      snapshotToken: "v1.snapshot",
      window: { startInclusive: START, endExclusive: END, readAt: READ },
      provenance: {
        evidenceContract: "sherlock.canonical-events.v1",
        normalizerVersions: [...NORMALIZER_VERSIONS],
        frameVersion: null,
        backwardCompatible: false,
        supersedes: "bonaparte.usage-evidence.v1",
      },
    },
    promptInspection: {
      policy: "first_n_prompt_buckets_in_usage_order",
      limit: 1000,
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
    ...overrides,
  };
}

function candidate(index = 0, overrides = {}) {
  return {
    candidateKey: `candidate-${index}`,
    title: `Candidate ${index}`,
    claim: "A bounded unverified client claim.",
    evidence: [{
      type: "code_reference",
      repository: REPOSITORY,
      revision: REVISION,
      path: "src/example.js",
      lineStart: 1,
      lineEnd: 2,
      trust: "unverified_client_claim",
    }],
    ...overrides,
  };
}

function request(candidates = [candidate()]) {
  return {
    submissionId: "11111111-1111-4111-8111-111111111111",
    method: method(),
    candidates,
  };
}

function registeredTools(evidence = {}, candidateSource = {}) {
  const tools = new Map();
  registerBonaparteTools({
    registerTool: (name, config, handler) => tools.set(name, { config, handler }),
  }, evidence, candidateSource);
  return tools;
}

describe("Bonaparte MCP tools", () => {
  it("registers exactly the four accepted typed tools", () => {
    const tools = registeredTools();
    expect([...tools.keys()]).toEqual([
      "list_usage_evidence",
      "list_prompt_evidence",
      "submit_candidate_batch",
      "get_candidate_batch",
    ]);
    expect(tools.get("submit_candidate_batch").config.annotations.readOnlyHint).toBe(false);
    expect(tools.get("get_candidate_batch").config.annotations.readOnlyHint).toBe(true);
  });

  it("accepts the method, code-reference, and 50-candidate boundaries", () => {
    const schema = registeredTools().get("submit_candidate_batch").config.inputSchema;
    expect(schema.safeParse(request([])).success).toBe(true);
    expect(schema.safeParse(request(Array.from({ length: 50 }, (_, index) =>
      candidate(index)))).success).toBe(true);
    expect(schema.safeParse(request(Array.from({ length: 51 }, (_, index) =>
      candidate(index)))).success).toBe(false);
    expect(schema.safeParse({
      ...request([]),
      method: method({
        promptInspection: {
          policy: "first_n_prompt_buckets_in_usage_order",
          limit: 0,
          availablePromptBucketCount: 0,
          eligiblePromptBucketCount: 0,
          inspectedPromptBucketCount: 0,
        },
      }),
    }).success).toBe(true);

    expect(schema.safeParse({
      ...request(),
      method: method({
        repository: { identifier: REPOSITORY, revision: REVISION.toUpperCase(), workingTreeState: "clean" },
      }),
    }).success).toBe(false);
    expect(schema.safeParse({
      ...request(),
      method: method({
        repository: { identifier: REPOSITORY, revision: "b".repeat(64), workingTreeState: "dirty" },
      }),
      candidates: [candidate(0, {
        evidence: [{
          ...candidate().evidence[0], revision: "b".repeat(64),
        }],
      })],
    }).success).toBe(true);
  });

  it("rejects unsafe paths, missing code evidence, mismatched repositories, and invalid counts", () => {
    const schema = registeredTools().get("submit_candidate_batch").config.inputSchema;
    for (const path of [
      "/absolute.js", "C:/absolute.js", "../escape.js", "src/../escape.js",
      "src\\file.js", "a\0b",
    ]) {
      expect(schema.safeParse(request([candidate(0, {
        evidence: [{ ...candidate().evidence[0], path }],
      })])).success).toBe(false);
    }
    expect(schema.safeParse(request([candidate(0, {
      evidence: [{
        type: "usage_summary",
        personId: "22222222-2222-4222-8222-222222222222",
        trust: "unverified_client_claim",
      }],
    })])).success).toBe(false);
    expect(schema.safeParse(request([candidate(0, {
      evidence: [{ ...candidate().evidence[0], repository: "another" }],
    })])).success).toBe(false);
    for (const promptInspection of [
      { ...method().promptInspection, limit: 1001 },
      { ...method().promptInspection, eligiblePromptBucketCount: 1 },
      { ...method().promptInspection, inspectedPromptBucketCount: 1 },
      { ...method().promptInspection, inspectedPromptBucketCount: 3 },
    ]) {
      expect(schema.safeParse({
        ...request(), method: method({ promptInspection }),
      }).success).toBe(false);
    }
  });

  it("returns v2 provenance as text and structured content", async () => {
    const tools = registeredTools({ fetchUsageEvidence: vi.fn().mockResolvedValue(payload()) });
    const result = await tools.get("list_usage_evidence").handler({});
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.structuredContent).toMatchObject({
      schemaVersion: "bonaparte.usage-evidence.v2",
      provenance: {
        evidenceContract: "sherlock.canonical-events.v1",
        normalizerVersions: [...NORMALIZER_VERSIONS],
        backwardCompatible: false,
      },
    });
  });

  it("maps source failures to safe errors without leaking details", async () => {
    const tools = registeredTools({
      fetchPromptEvidence: vi.fn()
        .mockRejectedValueOnce(new FlameSourceError("flame_prompt_snapshot_expired"))
        .mockRejectedValueOnce(new FlameSourceError("flame_prompt_request_not_found")),
    }, {
      getCandidateBatch: vi.fn()
        .mockRejectedValueOnce(new BottleneckSourceError("not_found"))
        .mockRejectedValueOnce(new Error("postgresql://secret")),
    });
    const prompt = await tools.get("list_prompt_evidence").handler({
      snapshotToken: "v1.snapshot",
      personId: "11111111-1111-4111-8111-111111111111",
      bucketStart: START,
    });
    expect(JSON.parse(prompt.content[0].text).error.code).toBe("snapshot_expired");
    const promptMissing = await tools.get("list_prompt_evidence").handler({
      snapshotToken: "v1.snapshot",
      personId: "11111111-1111-4111-8111-111111111111",
      bucketStart: START,
    });
    expect(JSON.parse(promptMissing.content[0].text).error).toMatchObject({
      code: "not_found",
      recovery: expect.stringContaining("select an exact returned person and prompt-bearing bucket"),
    });

    const missing = await tools.get("get_candidate_batch").handler({
      submissionId: request().submissionId,
    });
    const unavailable = await tools.get("get_candidate_batch").handler({
      submissionId: request().submissionId,
    });
    expect(JSON.parse(missing.content[0].text).error).toMatchObject({
      code: "not_found",
      recovery: expect.stringContaining("receipt submissionId and workspace"),
    });
    expect(JSON.parse(unavailable.content[0].text).error.code).toBe("unavailable");
    expect(JSON.stringify(unavailable)).not.toContain("postgresql://secret");
  });

  it("builds and cleanly closes the stateless protocol", async () => {
    const protocol = createBonaparteMcpProtocol({}, {});
    expect(protocol.handler).toBeTypeOf("function");
    await expect(protocol.close()).resolves.toBeUndefined();
  });
});
