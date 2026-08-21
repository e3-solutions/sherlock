import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import {
  MAX_MCP_BODY_BYTES,
  MCP_TOKEN_MIN_LENGTH,
  createMcpHttpRoute,
} from "./mcp-http.js";

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

  it("accepts the exact declared boundary and rejects one byte more before protocol", async () => {
    expect(MAX_MCP_BODY_BYTES).toBe(2 * 1024 * 1024);
    const protocolHandler = vi.fn();
    const route = createMcpHttpRoute({ protocolHandler, token: TOKEN });
    const accepted = responseRecorder();
    await route({
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-length": String(MAX_MCP_BODY_BYTES),
      },
    }, accepted);
    expect(protocolHandler).toHaveBeenCalledTimes(1);

    const rejected = responseRecorder();
    await route({
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-length": String(MAX_MCP_BODY_BYTES + 1),
      },
    }, rejected);
    expect(protocolHandler).toHaveBeenCalledTimes(1);
    expect(rejected.status).toBe(413);
    expect(JSON.parse(rejected.body)).toEqual({ error: "mcp_body_too_large" });
  });

  it("buffers chunked requests and never invokes protocol after overflow", async () => {
    const protocolHandler = vi.fn();
    const route = createMcpHttpRoute({ protocolHandler, token: TOKEN });
    const request = Readable.from([
      Buffer.alloc(MAX_MCP_BODY_BYTES),
      Buffer.alloc(1),
    ]);
    request.headers = { authorization: `Bearer ${TOKEN}` };
    const response = responseRecorder();

    await route(request, response);

    expect(protocolHandler).not.toHaveBeenCalled();
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: "mcp_body_too_large" });
  });

  it("passes an exact-boundary chunked body only after buffering it", async () => {
    const seen = [];
    const protocolHandler = vi.fn(async (request) => {
      for await (const chunk of request) seen.push(chunk);
    });
    const route = createMcpHttpRoute({ protocolHandler, token: TOKEN });
    const request = Readable.from([Buffer.alloc(MAX_MCP_BODY_BYTES)]);
    request.method = "POST";
    request.url = "/mcp";
    request.headers = { authorization: `Bearer ${TOKEN}` };

    await route(request, responseRecorder());

    expect(protocolHandler).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(seen)).toHaveLength(MAX_MCP_BODY_BYTES);
  });
});
