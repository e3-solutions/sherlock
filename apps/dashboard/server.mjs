import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DirectFlameSource,
  FlameSourceError,
  validateDashboardEmailDomain,
} from "./src/server/flame-source.js";
import {
  BOTTLENECK_CURSOR_SECRET_MAX_LENGTH,
  BOTTLENECK_CURSOR_SECRET_MIN_LENGTH,
  BottleneckSource,
  createBottleneckReadinessGate,
} from "./src/server/bottleneck-source.js";
import { createMcpHttpRoute } from "./src/server/mcp-http.js";
import { createBonaparteMcpProtocol } from "./src/server/mcp-server.js";
import { createCachedMcpSource } from "./src/server/mcp-source.js";
import { FlameDayCache } from "./src/server/flame-cache.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");
const PORT = Number.parseInt(process.env.PORT ?? "8000", 10);
const workspaceId = process.env.SHERLOCK_WORKSPACE_ID ?? "";
const dashboardEmailDomain = process.env.SHERLOCK_DASHBOARD_EMAIL_DOMAIN ?? "";
const databaseUrl = process.env.SUPABASE_DB_URL ?? "";
const mcpToken = process.env.SHERLOCK_MCP_TOKEN ?? "";
const mcpCursorSecret = process.env.SHERLOCK_MCP_CURSOR_SECRET ?? "";
const maxPeople = Number.parseInt(process.env.SHERLOCK_DASHBOARD_MAX_PEOPLE ?? "500", 10);
const projectionEnabled = process.env.SHERLOCK_FRAME_PROJECTION_ENABLED !== "false";
const validWorkspaceId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(workspaceId);
const validMaxPeople = Number.isInteger(maxPeople) && maxPeople > 0 && maxPeople <= 1000;
const validMcpToken = mcpToken.length >= 32 && mcpToken.length <= 512;
const validMcpCursorSecret =
  mcpCursorSecret.length >= BOTTLENECK_CURSOR_SECRET_MIN_LENGTH &&
  mcpCursorSecret.length <= BOTTLENECK_CURSOR_SECRET_MAX_LENGTH &&
  mcpCursorSecret !== mcpToken;
let validDashboardEmailDomain = false;
try {
  validateDashboardEmailDomain(dashboardEmailDomain);
  validDashboardEmailDomain = true;
} catch {
  validDashboardEmailDomain = false;
}
const source = databaseUrl && validWorkspaceId && validMaxPeople && validDashboardEmailDomain
  ? new DirectFlameSource({
      databaseUrl,
      workspaceId,
      expectedEmailDomain: dashboardEmailDomain,
      maxPeople,
      projectionEnabled,
    })
  : null;

let databaseVerified = false;
async function loadTimeline({ signal }) {
  if (!databaseVerified) {
    const readiness = await source.readiness({ signal });
    if (readiness.status !== "ok") throw new FlameSourceError(readiness.reason);
    databaseVerified = true;
  }
  return await source.fetchDay({ signal });
}

const cache = source
  ? new FlameDayCache({
      load: loadTimeline,
      log: (event) => console.log(JSON.stringify(event)),
    })
  : null;
cache?.start();
const bottleneckSource = databaseUrl && validWorkspaceId && validMcpCursorSecret
  ? new BottleneckSource({
      databaseUrl,
      workspaceId,
      cursorSecret: mcpCursorSecret,
    })
  : null;
const bottleneckReadiness = bottleneckSource
  ? createBottleneckReadinessGate(bottleneckSource)
  : null;
void bottleneckReadiness?.readiness();
const mcpSource = source && cache && bottleneckSource && validMcpToken
  ? createCachedMcpSource({ cache, source, candidateSource: bottleneckSource })
  : null;
const mcpProtocol = mcpSource ? createBonaparteMcpProtocol(mcpSource) : null;

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; " +
    "frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

function sendJson(response, status, body, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readyMcpProtocolHandler(request, response) {
  if (!mcpProtocol || !bottleneckReadiness) {
    sendJson(response, 503, { error: "mcp_not_configured" });
    return;
  }
  const receipt = await bottleneckReadiness.readiness();
  if (receipt.status !== "ok") {
    sendJson(response, 503, { error: receipt.reason });
    return;
  }
  await mcpProtocol.handler(request, response);
}

const mcpRoute = createMcpHttpRoute({
  protocolHandler: readyMcpProtocolHandler,
  token: mcpToken,
});

function requestAbortSignal(request, response) {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  return controller.signal;
}

function apiStatus(code, prefix) {
  if (code === `${prefix}_snapshot_expired`) return 410;
  if (code === `${prefix}_request_not_found`) return 404;
  if (code.endsWith("_result_too_large")) return 413;
  if (code.startsWith(`${prefix}_request_`) || code === "flame_work_cursor_invalid") return 400;
  return 503;
}

async function sendFile(response, filePath, cacheControl) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not_file");
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "Cache-Control": cacheControl,
      "Content-Length": info.size,
      "Content-Type": MIME_TYPES.get(path.extname(filePath)) ?? "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "not_found" });
  }
}

function configurationStatus() {
  const missing = [];
  if (!databaseUrl) missing.push("SUPABASE_DB_URL");
  if (!validWorkspaceId) missing.push("SHERLOCK_WORKSPACE_ID");
  if (!validDashboardEmailDomain) missing.push("SHERLOCK_DASHBOARD_EMAIL_DOMAIN");
  if (!validMaxPeople) missing.push("SHERLOCK_DASHBOARD_MAX_PEOPLE");
  if (!validMcpToken) missing.push("SHERLOCK_MCP_TOKEN");
  if (!validMcpCursorSecret) missing.push("SHERLOCK_MCP_CURSOR_SECRET");
  return missing.length === 0
    ? null
    : { status: "unavailable", reason: "configuration_missing", missing };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://dashboard.internal");
  if (url.pathname === "/mcp") {
    await mcpRoute(request, response);
    return;
  }
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" }, { Allow: "GET" });
    return;
  }

  if (url.pathname === "/healthz") {
    const invalid = configurationStatus();
    let receipt = invalid ?? cache.readiness();
    if (receipt.status === "ok") receipt = await bottleneckReadiness.readiness();
    sendJson(response, receipt.status === "ok" ? 200 : 503, receipt);
    return;
  }

  if (url.pathname === "/api/flame") {
    if (!source) {
      sendJson(response, 503, { error: "dashboard_not_configured" });
      return;
    }
    const signal = requestAbortSignal(request, response);
    try {
      const refresh = url.searchParams.get("refresh");
      const result = await cache.read({
        signal,
        forceRefresh: refresh === "force",
        waitForRefresh: refresh === "wait",
      });
      sendJson(response, 200, result.payload, {
        "X-Sherlock-Timeline-Cache": result.state,
      });
    } catch (error) {
      const code = error instanceof FlameSourceError
        ? error.code
        : "flame_database_unavailable";
      if (code !== "flame_request_aborted" || !signal.aborted) {
        sendJson(response, code === "flame_refresh_throttled" ? 429 : 503, { error: code },
          code === "flame_refresh_throttled" ? { "Retry-After": "60" } : {});
      }
    }
    return;
  }

  if (url.pathname === "/api/flame/interval") {
    if (!source) {
      sendJson(response, 503, { error: "dashboard_not_configured" });
      return;
    }
    const signal = requestAbortSignal(request, response);
    try {
      sendJson(response, 200, await source.fetchInterval({
        personId: url.searchParams.get("personId") ?? "",
        start: url.searchParams.get("start") ?? "",
        snapshot: url.searchParams.get("snapshot") ?? "",
        signal,
      }));
    } catch (error) {
      const code = error instanceof FlameSourceError
        ? error.code
        : "flame_database_unavailable";
      if (code !== "flame_request_aborted") {
        sendJson(response, apiStatus(code, "flame_interval"), { error: code });
      }
    }
    return;
  }

  if (url.pathname === "/api/flame/work") {
    if (!source) {
      sendJson(response, 503, { error: "dashboard_not_configured" });
      return;
    }
    const signal = requestAbortSignal(request, response);
    try {
      sendJson(response, 200, await source.fetchWork({
        personId: url.searchParams.get("personId") ?? "",
        start: url.searchParams.get("start") ?? "",
        sessionId: url.searchParams.get("sessionId") ?? "",
        role: url.searchParams.get("role") ?? "",
        snapshot: url.searchParams.get("snapshot") ?? "",
        cursor: url.searchParams.get("cursor") ?? "",
        limit: url.searchParams.get("limit") ?? "",
        signal,
      }));
    } catch (error) {
      const code = error instanceof FlameSourceError
        ? error.code
        : "flame_database_unavailable";
      if (code !== "flame_request_aborted") {
        sendJson(response, apiStatus(code, "flame_work"), { error: code });
      }
    }
    return;
  }

  if (url.pathname === "/" || url.pathname === "/flame") {
    await sendFile(response, path.join(DIST, "index.html"), "no-cache");
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    const assetRoot = path.resolve(DIST, "assets");
    const candidate = path.resolve(DIST, url.pathname.slice(1));
    if (!candidate.startsWith(`${assetRoot}${path.sep}`)) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    await sendFile(response, candidate, "public, max-age=31536000, immutable");
    return;
  }

  sendJson(response, 404, { error: "not_found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "dashboard_listening", port: PORT }));
});

async function shutdown(signal) {
  console.log(JSON.stringify({ event: "dashboard_shutdown", signal }));
  const drained = new Promise((resolve) => server.close(resolve));
  await cache?.close();
  await drained;
  await Promise.all([mcpProtocol?.close(), source?.close(), bottleneckSource?.close()]);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
