import { createHash, timingSafeEqual } from "node:crypto";

export const MCP_TOKEN_MIN_LENGTH = 32;
const MCP_TOKEN_MAX_LENGTH = 512;

function validToken(token) {
  return typeof token === "string" &&
    token.length >= MCP_TOKEN_MIN_LENGTH &&
    token.length <= MCP_TOKEN_MAX_LENGTH;
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function exactAuthorization(authorization, token) {
  if (typeof authorization !== "string") return false;
  return timingSafeEqual(
    digest(authorization),
    digest(`Bearer ${token}`),
  );
}

export function verifyMcpRequest({ authorization, origin, token }) {
  if (!validToken(token)) {
    return { ok: false, code: "mcp_not_configured", status: 503 };
  }
  if (origin) {
    return { ok: false, code: "mcp_origin_forbidden", status: 403 };
  }
  if (!exactAuthorization(authorization, token)) {
    return { ok: false, code: "mcp_unauthorized", status: 401 };
  }
  return { ok: true };
}
