import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPrivateAccessGate } from "./private-access.js";

const passwords = { "aqil@e3group.ai": "a".repeat(48), "caleb@e3group.ai": "c".repeat(48) };
const accountsJson = JSON.stringify(Object.fromEntries(Object.entries(passwords).map(
  ([email, password]) => [email, createHash("sha256").update(password).digest("hex")],
)));
const gate = () => createPrivateAccessGate({ enabled: "true", accountsJson });
const request = (email, password, url = "/api/flame") => ({
  url, headers: { authorization: `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}` },
});

describe("private viewer access", () => {
  it.each(Object.entries(passwords))("authenticates %s", (email, password) => {
    expect(gate().verify(request(email.toUpperCase(), password))).toEqual({ ok: true, email });
  });
  it("rejects absent credentials and forged identity headers", () => {
    expect(gate().verify({ url: "/", headers: {
      "x-forwarded-email": "aqil@e3group.ai", "x-auth-request-email": "aqil@e3group.ai",
    } })).toMatchObject({ ok: false, status: 401 });
  });
  it("rejects a wrong username or password", () => {
    expect(gate().verify(request("other@e3group.ai", passwords["aqil@e3group.ai"])).ok).toBe(false);
    expect(gate().verify(request("aqil@e3group.ai", "wrong")).ok).toBe(false);
  });
  it.each(["Basic !!!", "Basic YQ==", "Bearer secret", "Basic YTo=garbage"])(
    "rejects malformed authorization %s", (authorization) => {
      expect(gate().verify({ headers: { authorization } })).toMatchObject({ ok: false, status: 401 });
    },
  );
  it.each([undefined, "{}", "null", JSON.stringify({ "aqil@e3group.ai": "bad", "caleb@e3group.ai": "c".repeat(64) })])(
    "fails closed with invalid account configuration", (value) => {
      const invalid = createPrivateAccessGate({ enabled: "true", accountsJson: value });
      expect(invalid.verify({ headers: {} })).toMatchObject({ ok: false, status: 503 });
    },
  );
  it("fails closed with an invalid enable setting", () => {
    expect(createPrivateAccessGate({ enabled: "yes", accountsJson }).verify({})).toMatchObject({ status: 503 });
  });
  it("rejects additional unapproved accounts instead of widening the allowlist", () => {
    const invalid = createPrivateAccessGate({ enabled: "true", accountsJson: JSON.stringify({
      ...JSON.parse(accountsJson), "other@e3group.ai": "a".repeat(64),
    }) });
    expect(invalid.verify(request("aqil@e3group.ai", passwords["aqil@e3group.ai"])))
      .toMatchObject({ ok: false, status: 503 });
  });
  it("exempts only health and protects static assets and MCP", () => {
    expect(gate().verify({ url: "/healthz", headers: {} }).ok).toBe(true);
    for (const url of ["/", "/assets/app.js", "/mcp", "/api/flame/work", "/healthz/extra"]) {
      expect(gate().verify({ url, headers: {} })).toMatchObject({ ok: false, status: 401 });
    }
  });
  it("writes a no-store Basic challenge on rejection", () => {
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    expect(gate().apply({ headers: {} }, response).ok).toBe(false);
    expect(response.status).toBe(401);
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(response.headers["WWW-Authenticate"]).toContain("Basic");
  });
});
