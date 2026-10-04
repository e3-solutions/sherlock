import { createHash, timingSafeEqual } from "node:crypto";

const ALLOWED_EMAILS = ["aqil@e3group.ai", "caleb@e3group.ai"];
const EMPTY_HASH = Buffer.alloc(32);
const digest = (value) => createHash("sha256").update(value).digest();

/** Credentials are email -> SHA256(password) hex; identity headers are never trusted. */
export function createPrivateAccessGate({ enabled, accountsJson } = {}) {
  const disabled = enabled === undefined || enabled === false || enabled === "false";
  const active = enabled === true || enabled === "true";
  let accounts = null;
  if (active) {
    try {
      const parsed = JSON.parse(accountsJson);
      const keys = Object.keys(parsed);
      if (parsed && !Array.isArray(parsed) && keys.length === ALLOWED_EMAILS.length &&
          ALLOWED_EMAILS.every((email) => Object.hasOwn(parsed, email) &&
            typeof parsed[email] === "string" && /^[a-f0-9]{64}$/i.test(parsed[email]))) {
        accounts = new Map(ALLOWED_EMAILS.map((email) => [email, Buffer.from(parsed[email], "hex")]));
      }
    } catch { /* An invalid configuration must never open access. */ }
  }

  function verify(request) {
    const pathname = new URL(request.url ?? "/", "http://private.internal").pathname;
    if (pathname === "/healthz" || disabled) return { ok: true };
    if (!accounts) return { ok: false, status: 503, error: "private_access_not_configured" };
    const authorization = request.headers?.authorization;
    if (typeof authorization !== "string" || authorization.length > 4096 ||
        !/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(authorization)) {
      return { ok: false, status: 401, error: "private_access_unauthorized" };
    }
    const encoded = authorization.slice(6);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) {
      return { ok: false, status: 401, error: "private_access_unauthorized" };
    }
    const credentials = bytes.toString("utf8");
    const separator = credentials.indexOf(":");
    const email = credentials.slice(0, separator).trim().toLowerCase();
    const password = credentials.slice(separator + 1);
    const expected = accounts.get(email);
    const matches = timingSafeEqual(digest(password), expected ?? EMPTY_HASH);
    return separator > 0 && expected && matches
      ? { ok: true, email }
      : { ok: false, status: 401, error: "private_access_unauthorized" };
  }

  function apply(request, response) {
    const receipt = verify(request);
    if (!receipt.ok) {
      response.writeHead(receipt.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        ...(receipt.status === 401 ? {
          "WWW-Authenticate": 'Basic realm="Sherlock private", charset="UTF-8"',
        } : {}),
      });
      response.end(JSON.stringify({ error: receipt.error }));
    }
    return receipt;
  }

  return { enabled: !disabled, configured: disabled || Boolean(accounts), verify, apply };
}
