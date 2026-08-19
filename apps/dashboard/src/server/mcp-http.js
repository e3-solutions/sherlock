import { verifyMcpRequest } from "./mcp-auth.js";

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
    await protocolHandler(request, response);
  };
}
