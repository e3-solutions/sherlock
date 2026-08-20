import { createHash, timingSafeEqual } from "node:crypto";

export const MCP_TOKEN_MIN_LENGTH = 32;
const MCP_TOKEN_MAX_LENGTH = 512;

function headerValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function reject(response, receipt) {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
  if (receipt.status === 401) headers["WWW-Authenticate"] = "Bearer";
  response.writeHead(receipt.status, headers);
  response.end(JSON.stringify({ error: receipt.code }));
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function verifyMcpRequest({ authorization, origin, token }) {
  if (typeof token !== "string" || token.length < MCP_TOKEN_MIN_LENGTH ||
      token.length > MCP_TOKEN_MAX_LENGTH) {
    return { ok: false, code: "mcp_not_configured", status: 503 };
  }
  if (origin) return { ok: false, code: "mcp_origin_forbidden", status: 403 };
  if (typeof authorization !== "string" || !timingSafeEqual(
    digest(authorization),
    digest(`Bearer ${token}`),
  )) {
    return { ok: false, code: "mcp_unauthorized", status: 401 };
  }
  return { ok: true };
}

export function createMcpHttpRoute({ protocolHandler, token }) {
  return async function mcpHttpRoute(request, response) {
    const receipt = verifyMcpRequest({
      authorization: headerValue(request.headers?.authorization),
      origin: headerValue(request.headers?.origin),
      token,
    });
    if (!receipt.ok) {
      reject(response, receipt);
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      await protocolHandler(request, response);
    } catch {
      if (response.headersSent) {
        response.destroy?.();
        return;
      }
      reject(response, { status: 503, code: "mcp_unavailable" });
    }
  };
}
