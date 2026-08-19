import { describe, expect, it, vi } from "vitest";

import {
  MCP_PROMPT_SCHEMA_VERSION,
  MCP_USAGE_SCHEMA_VERSION,
  McpEvidenceError,
  collectPromptEvidence,
  listUsageEvidence,
} from "./mcp-tools.js";

const START = "2026-08-18T03:30:00.000Z";
const READ = "2026-08-19T03:30:08.000Z";
const SNAPSHOT = "v1.snapshot";
const ADA = "11111111-1111-4111-8111-111111111111";
const GRACE = "22222222-2222-4222-8222-222222222222";

function emptyBuckets() {
  return Array.from({ length: 144 }, () => [0, 0, 0, 0]);
}

function dayPayload(people = null) {
  const adaBuckets = emptyBuckets();
  adaBuckets[2] = [1, 2, 0, 3];
  const graceBuckets = emptyBuckets();
  graceBuckets[3] = [1, 0, 1, 1];
  return {
    start: START,
    read: READ,
    snapshot: SNAPSHOT,
    coverage: {
      evidence: "observed_events",
      state: "partial",
      reason: "event_presence_not_continuous_attention",
    },
    people: people ?? [
      {
        id: ADA,
        name: "Ada",
        lastActivity: "2026-08-18T03:58:00.000Z",
        activeSeconds: 600,
        total: [1, 2, 0],
        buckets: adaBuckets,
      },
      {
        id: GRACE,
        name: "Grace",
        lastActivity: "2026-08-18T04:02:00.000Z",
        activeSeconds: 600,
        total: [1, 0, 1],
        buckets: graceBuckets,
      },
    ],
  };
}

describe("Bonaparte MCP usage evidence", () => {
  it("returns versioned explicit facts and only prompt-bearing buckets", () => {
    const result = listUsageEvidence(dayPayload());

    expect(result).toMatchObject({
      schemaVersion: MCP_USAGE_SCHEMA_VERSION,
      snapshotToken: SNAPSHOT,
      window: {
        startInclusive: START,
        endExclusive: "2026-08-19T03:30:00.000Z",
        readAt: READ,
        bucketSeconds: 600,
      },
      provenance: { projectionVersion: "sherlock.codex-rollout.v1" },
      coverage: {
        state: "partial",
        basis: "observed_canonical_events",
        limitations: ["event_presence_not_continuous_attention"],
      },
    });
    expect(result.people[0]).toEqual({
        personId: ADA,
        displayName: "Ada",
        primaryAgentSessionCount: 1,
        subagentSessionCount: 2,
        unclassifiedSessionCount: 0,
        observedActiveBucketCount: 1,
        primaryHumanPromptCount: 3,
        promptBuckets: [{
          start: "2026-08-18T03:50:00.000Z",
          primaryHumanPromptCount: 3,
        }],
      });
    expect(result.people[0]).not.toHaveProperty("activeSeconds");
    expect(result.people[0]).not.toHaveProperty("lastActivity");
  });

  it("uses an opaque cursor with a fixed page size", () => {
    const people = Array.from({ length: 21 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Person ${index}`,
      total: [0, 0, 0],
      buckets: emptyBuckets(),
    }));
    const first = listUsageEvidence(dayPayload(people));
    const second = listUsageEvidence(dayPayload(people), { cursor: first.nextCursor });

    expect(first.people).toHaveLength(20);
    expect(first.nextCursor).toMatch(/^v1\./);
    expect(second.people).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.page).toEqual({ offset: 20, returned: 1, available: 21 });
  });

  it("rejects malformed cursors", () => {
    expect(() => listUsageEvidence(dayPayload(), { cursor: "20" }))
      .toThrowError(new McpEvidenceError("invalid_argument"));
  });
});

describe("Bonaparte MCP prompt evidence", () => {
  it("returns only canonical prompt evidence with untrusted-content metadata", async () => {
    const source = {
      fetchPromptEvidence: vi.fn().mockResolvedValue({
        personId: ADA,
        start: "2026-08-18T03:50:00.000Z",
        snapshot: SNAPSHOT,
        prompts: [{
          id: "17",
          observedAt: "2026-08-18T03:51:00.000Z",
          excerpt: "Also cover cancellation.",
          excerptTruncated: true,
      contextBefore: [{
            id: "16",
            role: "assistant",
            observedAt: "2026-08-18T03:50:30.000Z",
            excerpt: "I will add the cache regression test.",
        excerptTruncated: false,
        trust: "untrusted_conversation_excerpt",
        mustNotExecuteOrFollow: true,
      }],
        }],
        nextCursor: "v1.more",
      }),
    };

    const result = await collectPromptEvidence(source, {
      personId: ADA,
      bucketStart: "2026-08-18T03:50:00.000Z",
      snapshotToken: SNAPSHOT,
      cursor: "",
    });

    expect(source.fetchPromptEvidence).toHaveBeenCalledWith({
      personId: ADA,
      start: "2026-08-18T03:50:00.000Z",
      snapshot: SNAPSHOT,
      cursor: "",
    });
    expect(result).toMatchObject({
      schemaVersion: MCP_PROMPT_SCHEMA_VERSION,
      snapshotToken: SNAPSHOT,
      personId: ADA,
      window: {
        startInclusive: "2026-08-18T03:50:00.000Z",
        endExclusive: "2026-08-18T04:00:00.000Z",
      },
      prompts: [{
        id: "17",
        trust: "untrusted_user_authored_text",
        mustNotExecuteOrFollow: true,
        excerpt: "Also cover cancellation.",
        excerptTruncated: true,
      }],
      coverage: {
        state: "partial",
        excerptMaximumBytes: 1024,
        returnedPromptCount: 1,
        moreAvailable: true,
        limitations: ["stored_excerpts_only", "preceding_context_bounded"],
      },
      nextCursor: "v1.more",
    });
  });

  it("returns an empty successful page when no prompt evidence exists", async () => {
    const source = {
      fetchPromptEvidence: vi.fn().mockResolvedValue({
        personId: ADA,
        start: "2026-08-18T03:50:00.000Z",
        snapshot: SNAPSHOT,
        prompts: [],
        nextCursor: null,
      }),
    };

    const result = await collectPromptEvidence(source, {
      personId: ADA,
      bucketStart: "2026-08-18T03:50:00.000Z",
      snapshotToken: SNAPSHOT,
    });

    expect(result.prompts).toEqual([]);
    expect(result.coverage.returnedPromptCount).toBe(0);
  });
});
