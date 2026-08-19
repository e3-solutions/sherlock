import { createServer } from "node:http";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBonaparteMcpProtocol } from "./mcp-server.js";

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
  it("discovers and calls the tools through Streamable HTTP", async () => {
    const source = {
      fetchDay: vi.fn().mockResolvedValue({
        start: "2026-08-18T03:30:00.000Z",
        read: "2026-08-19T03:30:08.000Z",
        snapshot: "v1.snapshot",
        coverage: {
          evidence: "observed_events",
          state: "partial",
          reason: "event_presence_not_continuous_attention",
        },
        people: [],
      }),
    };
    const protocol = createBonaparteMcpProtocol(source);
    openProtocols.push(protocol);
    const httpServer = createServer((request, response) => {
      void protocol.handler(request, response);
    });
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
    ));

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "analyze_usage",
      "get_prompt_feedback_context",
    ]);
    const result = await client.callTool({
      name: "analyze_usage",
      arguments: { personIds: [], includeBuckets: false },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      roster: { returned: 0, available: 0, truncated: false },
      people: [],
    });
  });
});
