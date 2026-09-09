import { describe, expect, it } from "vitest";
import { linkedPrsBySession } from "./pr-context.js";

describe("declared PR context projection", () => {
  const fromRow = (r) => ({ number: r.pull_request_number,
    url: `https://github.com/e3-solutions/sherlock/pull/${r.pull_request_number}` });
  const invalid = () => new Error("invalid status");
  it("bounds display without discarding interval work when a session has over 50 PRs", () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      session_id: "session", repository_full_name: "e3-solutions/sherlock",
      pull_request_number: index + 1, status: "pending", checked_at: null,
    }));
    const { links, truncated } = linkedPrsBySession(rows, fromRow, invalid).get("session");
    expect(links).toHaveLength(50);
    expect(truncated).toBe(true);
    expect(links.every((link) => link.url === null)).toBe(true);
  });
  it("exposes a URL only for a checked observation", () => {
    const rows = ["checked", "inaccessible", "identity_mismatch", "out_of_scope"].map((status, index) => ({
      session_id: "session", repository_full_name: "e3-solutions/sherlock",
      pull_request_number: index + 1, status, checked_at: "2026-09-09T00:00:00Z",
    }));
    const { links, truncated } = linkedPrsBySession(rows, fromRow, invalid).get("session");
    expect(truncated).toBe(false);
    expect(links[0].url).toBe("https://github.com/e3-solutions/sherlock/pull/1");
    expect(links.slice(1).every((link) => link.url === null)).toBe(true);
  });
});
