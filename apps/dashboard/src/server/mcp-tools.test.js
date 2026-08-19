import { describe, expect, it, vi } from "vitest";

import {
  McpEvidenceError,
  collectPromptFeedbackContext,
  summarizeUsage,
} from "./mcp-tools.js";

const START = "2026-08-18T03:30:00.000Z";
const READ = "2026-08-19T03:30:08.000Z";
const SNAPSHOT = "v1.snapshot";
const ADA = "11111111-1111-4111-8111-111111111111";
const GRACE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

function emptyBuckets() {
  return Array.from({ length: 144 }, () => [0, 0, 0, 0]);
}

function dayPayload() {
  const adaBuckets = emptyBuckets();
  adaBuckets[2] = [1, 2, 0, 3];
  const graceBuckets = emptyBuckets();
  graceBuckets[3] = [1, 0, 1, 1];
  return {
    start: START,
    read: READ,
    snapshot: SNAPSHOT,
    latest: "2026-08-19T03:29:59.000Z",
    coverage: {
      evidence: "observed_events",
      state: "partial",
      reason: "event_presence_not_continuous_attention",
    },
    people: [
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
  it("returns bounded per-person facts without inventing an efficiency score", () => {
    const result = summarizeUsage(dayPayload(), {
      personIds: [ADA],
      includeBuckets: true,
    });

    expect(result.window).toEqual({ start: START, read: READ });
    expect(result.analysisReceipt).toBe(SNAPSHOT);
    expect(result.coverage.reason).toBe("event_presence_not_continuous_attention");
    expect(result.people).toEqual([{
      id: ADA,
      name: "Ada",
      lastActivity: "2026-08-18T03:58:00.000Z",
      activeSeconds: 600,
      activeBucketCount: 1,
      promptCount: 3,
      distinctSessions: { agent: 1, subagent: 2, unclassified: 0 },
      buckets: [{
        start: "2026-08-18T03:50:00.000Z",
        agent: 1,
        subagent: 2,
        unclassified: 0,
        prompts: 3,
      }],
    }]);
    expect(JSON.stringify(result)).not.toContain("score");
  });

  it("rejects unknown people instead of silently returning an empty analysis", () => {
    expect(() => summarizeUsage(dayPayload(), {
      personIds: ["44444444-4444-4444-8444-444444444444"],
    })).toThrowError(new McpEvidenceError("mcp_person_not_found"));
  });

  it("supports roster pagination without changing stable person IDs", () => {
    const result = summarizeUsage(dayPayload(), { offset: 1 });

    expect(result.roster).toMatchObject({ offset: 1, returned: 1, available: 2 });
    expect(result.people.map((person) => person.id)).toEqual([GRACE]);
  });
});

describe("Bonaparte MCP prompt feedback evidence", () => {
  it("returns only primary human prompt excerpts with coaching guardrails", async () => {
    const source = {
      fetchDay: vi.fn().mockResolvedValue(dayPayload()),
      fetchInterval: vi.fn().mockResolvedValue({
        personId: ADA,
        start: "2026-08-18T03:50:00.000Z",
        snapshot: SNAPSHOT,
        work: [
          { sessionId: SESSION, role: "agent", eventCount: 4 },
          {
            sessionId: "55555555-5555-4555-8555-555555555555",
            role: "subagent",
            eventCount: 2,
          },
        ],
      }),
      fetchWork: vi.fn().mockResolvedValue({
        sessionId: SESSION,
        role: "agent",
        items: [
          {
            id: "17",
            at: "2026-08-18T03:51:00.000Z",
            role: "user",
            content: "Fix the cache race. Preserve old API behavior and add a regression test.",
            truncated: false,
          },
          {
            id: "18",
            at: "2026-08-18T03:52:00.000Z",
            role: "assistant",
            content: "I will inspect the cache.",
            truncated: false,
          },
          {
            id: "19",
            at: "2026-08-18T03:53:00.000Z",
            role: "user",
            content: "Also cover cancellation.",
            truncated: true,
          },
        ],
        nextCursor: "more",
      }),
    };

    const result = await collectPromptFeedbackContext(source, {
      personId: ADA,
      bucketStart: "2026-08-18T03:50:00.000Z",
      analysisReceipt: SNAPSHOT,
      maxPrompts: 10,
    });

    expect(source.fetchWork).toHaveBeenCalledTimes(1);
    expect(source.fetchWork).toHaveBeenCalledWith(expect.objectContaining({
      personId: ADA,
      sessionId: SESSION,
      role: "agent",
      snapshot: SNAPSHOT,
    }));
    expect(result.prompts.map((prompt) => prompt.id)).toEqual(["17", "19"]);
    expect(result.prompts[1].truncated).toBe(true);
    expect(result.evidence.moreConversationAvailable).toBe(true);
    expect(result.coaching.instructions).toContain("Do not infer personal traits");
    expect(result.coaching.dimensions).toEqual([
      "goal_clarity",
      "relevant_context",
      "constraints_and_boundaries",
      "success_criteria",
      "verification_request",
    ]);
  });

  it("requires the selected bucket to contain canonical prompts for that person", async () => {
    const source = {
      fetchDay: vi.fn().mockResolvedValue(dayPayload()),
      fetchInterval: vi.fn().mockResolvedValue({ work: [] }),
    };

    await expect(collectPromptFeedbackContext(source, {
      personId: ADA,
      bucketStart: "2026-08-18T04:00:00.000Z",
      analysisReceipt: SNAPSHOT,
      maxPrompts: 5,
    })).rejects.toThrowError(new McpEvidenceError("mcp_prompt_bucket_empty"));
  });
});
