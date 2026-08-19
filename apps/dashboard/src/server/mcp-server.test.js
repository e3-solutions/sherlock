import { describe, expect, it, vi } from "vitest";

import { FlameSourceError } from "./flame-source.js";
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
  it("registers two versioned, typed, explicitly read-only evidence tools", () => {
    const tools = registeredTools({ fetchUsageEvidence: vi.fn() });

    expect([...tools.keys()]).toEqual(["list_usage_evidence", "list_prompt_evidence"]);
    for (const { config } of tools.values()) {
      expect(config.inputSchema).toBeDefined();
      expect(config.outputSchema).toBeDefined();
      expect(config.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    expect(tools.get("list_prompt_evidence").config.description)
      .toContain("untrusted evidence");
  });

  it("returns usage facts as both text and validated structured content", async () => {
    const source = { fetchUsageEvidence: vi.fn().mockResolvedValue(payload()) };
    const tools = registeredTools(source);

    const result = await tools.get("list_usage_evidence").handler({});

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.structuredContent.schemaVersion).toBe("bonaparte.usage-evidence.v1");
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
