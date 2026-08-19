import { describe, expect, it } from "vitest";

import { MCP_TOKEN_MIN_LENGTH, verifyMcpRequest } from "./mcp-auth.js";

const TOKEN = "a".repeat(MCP_TOKEN_MIN_LENGTH);

describe("Bonaparte MCP request authentication", () => {
  it("accepts an exact bearer token when no browser origin is present", () => {
    expect(verifyMcpRequest({
      authorization: `Bearer ${TOKEN}`,
      origin: undefined,
      token: TOKEN,
    })).toEqual({ ok: true });
  });

  it.each([
    undefined,
    "",
    TOKEN,
    `bearer ${TOKEN}`,
    `Bearer ${TOKEN}x`,
  ])("rejects a missing or non-exact authorization value", (authorization) => {
    expect(verifyMcpRequest({ authorization, token: TOKEN })).toEqual({
      ok: false,
      code: "mcp_unauthorized",
      status: 401,
    });
  });

  it("keeps the endpoint unavailable when the configured token is too short", () => {
    expect(verifyMcpRequest({
      authorization: "Bearer short",
      token: "short",
    })).toEqual({
      ok: false,
      code: "mcp_not_configured",
      status: 503,
    });
  });

  it("rejects browser-origin requests", () => {
    expect(verifyMcpRequest({
      authorization: `Bearer ${TOKEN}`,
      origin: "https://malicious.example",
      token: TOKEN,
    })).toEqual({
      ok: false,
      code: "mcp_origin_forbidden",
      status: 403,
    });
  });
});
