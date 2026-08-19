import { verifyMcpRequest } from "./mcp-auth.js";

export const MAX_MCP_REQUEST_BYTES = 1_048_576;

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

function requestTooLarge(request) {
  const raw = headerValue(request.headers?.["content-length"]);
  if (raw === undefined) return false;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return true;
  const bytes = Number(raw);
  return !Number.isSafeInteger(bytes) || bytes > MAX_MCP_REQUEST_BYTES;
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
    if (requestTooLarge(request)) {
      reject(response, { status: 413, code: "mcp_request_too_large" });
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
