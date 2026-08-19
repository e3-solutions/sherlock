import { describe, expect, it, vi } from "vitest";

import {
  createBonaparteMcpProtocol,
  registerBonaparteTools,
} from "./mcp-server.js";

const START = "2026-08-18T03:30:00.000Z";

function payload() {
  return {
    start: START,
    read: "2026-08-19T03:30:08.000Z",
    snapshot: "v1.snapshot",
    coverage: {
      evidence: "observed_events",
      state: "partial",
      reason: "event_presence_not_continuous_attention",
    },
    people: [{
      id: "11111111-1111-4111-8111-111111111111",
      name: "Ada",
      lastActivity: null,
      activeSeconds: 0,
      total: [0, 0, 0],
      buckets: Array.from({ length: 144 }, () => [0, 0, 0, 0]),
    }],
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
  it("registers two explicitly read-only agent-facing tools", () => {
    const tools = registeredTools({ fetchDay: vi.fn() });

    expect([...tools.keys()]).toEqual(["analyze_usage", "get_prompt_feedback_context"]);
    for (const { config } of tools.values()) {
      expect(config.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
    expect(tools.get("get_prompt_feedback_context").config.description)
      .toContain("calling agent");
  });

  it("returns the same usage facts as text and structured content", async () => {
    const source = { fetchDay: vi.fn().mockResolvedValue(payload()) };
    const tools = registeredTools(source);

    const result = await tools.get("analyze_usage").handler({
      personIds: [],
      includeBuckets: false,
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.structuredContent.people[0].name).toBe("Ada");
  });

  it("returns bounded tool errors that agents can correct", async () => {
    const source = { fetchDay: vi.fn().mockRejectedValue(new Error("database secret")) };
    const tools = registeredTools(source);

    const result = await tools.get("analyze_usage").handler({
      personIds: [],
      includeBuckets: false,
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "mcp_evidence_unavailable" }],
      isError: true,
    });
  });

  it("builds and closes the official stateless Streamable HTTP handler", async () => {
    const protocol = createBonaparteMcpProtocol({ fetchDay: vi.fn() });

    expect(protocol.handler).toBeTypeOf("function");
    await expect(protocol.close()).resolves.toBeUndefined();
  });
});
