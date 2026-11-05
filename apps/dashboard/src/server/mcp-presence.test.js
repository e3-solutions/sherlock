import { describe, expect, it, vi } from "vitest";

import {
  PRESENCE_CONTRIBUTIONS_SQL,
  PRESENCE_EVENTS_SQL,
  PRESENCE_MAX_HOURS,
  createPresenceSource,
} from "./mcp-presence.js";
import { USAGE_CONTRIBUTION_STATE_SQL } from "./mcp-query-source.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const ADA = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-11-05T20:00:00.000Z";
const ROW = {
  person_id: ADA, display_name: "Ada", sessions: "3", active_sessions: "1",
  last_activity_at: "2026-11-05T19:58:00.000Z", agents: ["codex", "claude", null],
};

function source({ state = [{ backfill_cursor: "2026-01-01T00:00:00Z" }], rows = [ROW] } = {}) {
  const calls = [];
  return {
    calls,
    value: {
      workspaceId: WORKSPACE,
      expectedEmailDomain: "e3group.ai",
      async transaction(callback, options) {
        return await callback({
          unsafe(text, params) {
            calls.push({ text, params, options });
            const result = Promise.resolve(text === USAGE_CONTRIBUTION_STATE_SQL ? state : rows);
            result.cancel = () => {};
            return result;
          },
        });
      },
    },
  };
}

describe("presence", () => {
  it("answers who is active now from the last 15 minutes of raw usage", async () => {
    const { calls, value } = source();
    const result = await createPresenceSource(value).fetchPresence({ now: NOW });
    expect(calls.map((call) => call.text)).toEqual([PRESENCE_EVENTS_SQL]);
    expect(calls[0].params.slice(1, 3)).toEqual(["2026-11-05T19:45:00.000Z", NOW]);
    expect(result).toMatchObject({
      mode: "now", activeWithinMinutes: 15,
      people: [{
        personId: ADA, displayName: "Ada", active: true, activeSessions: 1, sessions: 3,
        lastActivityAt: "2026-11-05T19:58:00.000Z", agents: ["claude", "codex"],
      }],
    });
  });

  it("reads history from the precomputed table when it covers the window, else raw usage", async () => {
    const covered = source();
    const result = await createPresenceSource(covered.value).fetchPresence({ hours: 24, now: NOW });
    expect(covered.calls.map((call) => call.text)).toEqual([USAGE_CONTRIBUTION_STATE_SQL, PRESENCE_CONTRIBUTIONS_SQL]);
    expect(result.mode).toBe("history");
    expect(result.window.startInclusive).toBe("2026-11-04T20:00:00.000Z");

    const uncovered = source({ state: [] });
    await createPresenceSource(uncovered.value).fetchPresence({ hours: 24, now: NOW });
    expect(uncovered.calls.at(-1).text).toBe(PRESENCE_EVENTS_SQL);
  });

  it("looks up one person by id or by an unambiguous name, defaulting to a 30-day window", async () => {
    const { calls, value } = source();
    const resolvePerson = vi.fn().mockResolvedValue({ matches: [{ personId: ADA, displayName: "Ada" }], ambiguous: false });
    const presence = createPresenceSource(value, { resolvePerson });
    const byName = await presence.fetchPresence({ person: "ada", now: NOW });
    expect(resolvePerson).toHaveBeenCalledWith(expect.objectContaining({ name: "ada" }));
    expect(byName).toMatchObject({ mode: "person", found: true, personId: ADA });
    expect(calls.at(-1).params[4]).toBe(ADA);
    expect(byName.window.startInclusive).toBe(new Date(Date.parse(NOW) - PRESENCE_MAX_HOURS * 3_600_000).toISOString());

    await presence.fetchPresence({ person: ADA.toUpperCase(), now: NOW });
    expect(resolvePerson).toHaveBeenCalledTimes(1);
    expect(calls.at(-1).params[4]).toBe(ADA);
  });

  it("returns matches instead of guessing an ambiguous name, and found false for no activity", async () => {
    const { value } = source({ rows: [] });
    const resolvePerson = vi.fn().mockResolvedValue({
      matches: [{ personId: ADA, displayName: "Ada" }, { personId: "44444444-4444-4444-8444-444444444444", displayName: "Adam" }],
      ambiguous: true,
    });
    const presence = createPresenceSource(value, { resolvePerson });
    expect(await presence.fetchPresence({ person: "ad", now: NOW })).toMatchObject({
      found: false, ambiguous: true, people: [], matches: [{ personId: ADA }, {}],
    });
    expect(await presence.fetchPresence({ person: ADA, now: NOW })).toMatchObject({ found: false, people: [] });
  });

  it("rejects out-of-range hours", async () => {
    const presence = createPresenceSource(source().value);
    for (const hours of [0, PRESENCE_MAX_HOURS + 1, 1.5]) {
      await expect(presence.fetchPresence({ hours, now: NOW })).rejects.toMatchObject({ code: "flame_mcp_query_request_invalid" });
    }
  });

  it("counts only top-level sessions and never selects content columns", () => {
    for (const sql of [PRESENCE_EVENTS_SQL, PRESENCE_CONTRIBUTIONS_SQL]) {
      expect(sql).toContain("s.parent_session_id is null and s.parent_native_session_id is null");
      expect(sql).toContain("s.actor_role not in ('guardian', 'automation')");
      expect(sql).not.toMatch(/content|title|branch|cwd|repo_remote/);
    }
  });
});
