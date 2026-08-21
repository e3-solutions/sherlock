import { createHash, timingSafeEqual } from "node:crypto";
import { PassThrough } from "node:stream";

export const MCP_TOKEN_MIN_LENGTH = 32;
export const MAX_MCP_BODY_BYTES = 2_097_152;
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

function declaredBodyBytes(request) {
  const value = headerValue(request.headers?.["content-length"]);
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return Infinity;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Infinity;
}

async function boundedRequest(request) {
  if (typeof request?.[Symbol.asyncIterator] !== "function") return request;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_MCP_BODY_BYTES) throw new RangeError("mcp_body_too_large");
    chunks.push(buffer);
  }
  const copy = new PassThrough();
  for (const property of [
    "method", "url", "headers", "rawHeaders", "httpVersion",
    "httpVersionMajor", "httpVersionMinor", "socket", "connection",
  ]) {
    if (request[property] !== undefined) copy[property] = request[property];
  }
  copy.end(Buffer.concat(chunks, bytes));
  return copy;
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
    if (declaredBodyBytes(request) > MAX_MCP_BODY_BYTES) {
      reject(response, { status: 413, code: "mcp_body_too_large" });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      await protocolHandler(await boundedRequest(request), response);
    } catch (error) {
      if (error instanceof RangeError && error.message === "mcp_body_too_large") {
        if (response.headersSent) response.destroy?.();
        else reject(response, { status: 413, code: "mcp_body_too_large" });
        return;
      }
      if (response.headersSent) {
        response.destroy?.();
        return;
      }
      reject(response, { status: 503, code: "mcp_unavailable" });
    }
  };
}
