import { describe, expect, it, vi } from "vitest";

import { MCP_TOKEN_MIN_LENGTH, createMcpHttpRoute } from "./mcp-http.js";

const TOKEN = "s".repeat(MCP_TOKEN_MIN_LENGTH);

function responseRecorder() {
  return {
    status: null,
    headers: null,
    setHeaders: {},
    body: null,
    setHeader(name, value) {
      this.setHeaders[name] = value;
    },
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

describe("Bonaparte MCP HTTP route", () => {
  it("answers unauthorized requests without invoking the protocol handler", async () => {
    const protocolHandler = vi.fn();
    const route = createMcpHttpRoute({ protocolHandler, token: TOKEN });
    const response = responseRecorder();

    await route({ headers: {} }, response);

    expect(protocolHandler).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    expect(response.headers["WWW-Authenticate"]).toBe("Bearer");
    expect(JSON.parse(response.body)).toEqual({ error: "mcp_unauthorized" });
  });

  it("forwards an authorized origin-free request to the protocol handler", async () => {
    const protocolHandler = vi.fn().mockResolvedValue(undefined);
    const route = createMcpHttpRoute({ protocolHandler, token: TOKEN });
    const request = { headers: { authorization: `Bearer ${TOKEN}` } };
    const response = responseRecorder();

    await route(request, response);

    expect(protocolHandler).toHaveBeenCalledWith(request, response);
    expect(response.headers).toBeNull();
    expect(response.setHeaders).toMatchObject({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("rejects browser origins before protocol parsing", async () => {
    const protocolHandler = vi.fn();
    const route = createMcpHttpRoute({ protocolHandler, token: TOKEN });
    const response = responseRecorder();

    await route({
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: "https://example.test",
      },
    }, response);

    expect(protocolHandler).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "mcp_origin_forbidden" });
  });

  it("contains unexpected protocol failures behind a safe response", async () => {
    const protocolHandler = vi.fn().mockRejectedValue(new Error("database secret"));
    const route = createMcpHttpRoute({ protocolHandler, token: TOKEN });
    const response = responseRecorder();

    await route({ headers: { authorization: `Bearer ${TOKEN}` } }, response);

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "mcp_unavailable" });
    expect(response.body).not.toContain("database secret");
  });
});
