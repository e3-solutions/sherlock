import { existsSync, readFileSync } from "node:fs";
import { URL as FileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  PRECOMPUTED_USAGE_SQL,
  QUERY_USAGE_SQL,
  USAGE_ASSESSED_SQL,
  USAGE_CONTRIBUTIONS_SQL,
  USAGE_CONTRIBUTION_STATE_SQL,
  createSherlockQuerySource,
  tokenCountExistsPredicate,
} from "./mcp-query-source.js";

// The dashboard image builds and tests apps/dashboard alone; the repository
// checkout (CI and local) has the migration.
const MIGRATION_URL = new FileURL(
  "../../../../supabase/migrations/20261104214500_usage_contributions.sql", import.meta.url,
);
const MIGRATION = existsSync(MIGRATION_URL) ? readFileSync(MIGRATION_URL, "utf8") : null;
const NOW = new Date("2026-09-01T20:00:00.000Z");

function source(stateRows) {
  const unsafe = vi.fn(async (text) => {
    if (text.includes("person_count")) return [{ person_count: 0 }];
    if (text === USAGE_CONTRIBUTION_STATE_SQL) return stateRows;
    if (text.includes("read_dashboard_freshness")) {
      return [{ pending_normalize_count: 0, raw_watermark: null, canonical_watermark: null }];
    }
    return [];
  });
  return {
    unsafe,
    value: {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      expectedEmailDomain: "e3group.ai",
      maxPeople: 500,
      readiness: vi.fn(),
      transaction: vi.fn(async (callback) => await callback({ unsafe })),
    },
  };
}

describe("precomputed usage contributions", () => {
  it.skipIf(MIGRATION === null)("embeds the live assessment SQL verbatim, so the two cannot drift", () => {
    // Editing USAGE_ASSESSED_SQL / USAGE_CONTRIBUTIONS_SQL requires a new
    // migration that replaces analytics.compute_usage_contributions().
    expect(MIGRATION).toContain(`${USAGE_ASSESSED_SQL}, ${USAGE_CONTRIBUTIONS_SQL}`);
    expect(MIGRATION).toContain(tokenCountExistsPredicate("s.workspace_id", "s.id"));
    expect(QUERY_USAGE_SQL).toContain(`${USAGE_ASSESSED_SQL}, ${USAGE_CONTRIBUTIONS_SQL}`);
  });

  it("uses the table when backfill covers the window and the refresh is current", async () => {
    const { unsafe, value } = source([{ backfill_cursor: new Date(NOW - 86_400_000 * 2), refreshed_at: NOW }]);
    await createSherlockQuerySource(value).fetchUsage({ now: NOW });
    const state = unsafe.mock.calls.find(([text]) => text === USAGE_CONTRIBUTION_STATE_SQL);
    expect(state[1]).toEqual([value.workspaceId, new Date(NOW - 86_400_000).toISOString()]);
    expect(unsafe.mock.calls.at(-1)[0]).toBe(PRECOMPUTED_USAGE_SQL);
    expect(unsafe.mock.calls.some(([text]) => text === QUERY_USAGE_SQL)).toBe(false);
  });

  it("keeps the live query otherwise", async () => {
    const { unsafe, value } = source([]);
    await createSherlockQuerySource(value).fetchUsage({ now: NOW });
    expect(unsafe.mock.calls.at(-1)[0]).toBe(QUERY_USAGE_SQL);
  });

  it("applies the missing-baseline rule at query time and joins sessions under RLS", () => {
    expect(PRECOMPUTED_USAGE_SQL).toContain("from analytics.usage_contributions u");
    expect(PRECOMPUTED_USAGE_SQL).toContain(
      "join telemetry.sessions s on s.workspace_id = u.workspace_id and s.id = u.session_id",
    );
    expect(PRECOMPUTED_USAGE_SQL).toContain(
      "case when u.first_in_stream and s.started_at < p.start_at then 0 else u.total_delta end total_delta",
    );
  });
});
