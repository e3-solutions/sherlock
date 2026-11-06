import { URL as FileURL } from "node:url";
import { readFileSync } from "node:fs";
import { expect } from "vitest";

import {
  COVERAGE_SQL, PRECOMPUTED_USAGE_SQL, QUERY_USAGE_SQL, USAGE_CONTRIBUTION_STATE_SQL,
} from "../mcp-query-source.js";

// Frozen queries from 04491385f921e692982c188ba1027c5e6bbf4e1a provide an
// independent pre-optimization oracle. Keep them frozen when editing live SQL.
const oldUsage = readFileSync(new FileURL("./usage-query-before.sql", import.meta.url), "utf8");
const oldCoverage = readFileSync(new FileURL("./coverage-query-before.sql", import.meta.url), "utf8");
const versions = [
  "sherlock.codex-rollout.v1", "sherlock.codex-rollout.v2",
  "sherlock.codex-rollout.v3", "sherlock.claude-code-transcript.v1",
];
const normalized = (rows) => rows.map((row) => Object.fromEntries(
  Object.entries(row).map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]),
)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export async function expectUsageQueryParity(sql, workspaceId, { start, end }) {
  const params = [workspaceId, start, end, "e3group.ai"];
  // Smoke the minute refresh: it must complete, including clearing dirty
  // marks. Run it first; its first pass for a new workspace clears that
  // workspace's stored rows.
  await sql.unsafe("select analytics.refresh_usage_contributions(5)");
  // COR-5178: the Heartbeat presence read must run (no sherlock_access in CI).
  expect(Array.isArray([...await sql.unsafe("select * from heartbeat_api.coding_presence(60)")])).toBe(true);
  // COR-5162: the stored per-event contributions must answer identically.
  await sql.unsafe(`select analytics.compute_usage_contributions($1::uuid, array(
    select s.id from telemetry.sessions s where s.workspace_id = $1::uuid))`, [workspaceId]);
  await sql.begin(async (tx) => {
    await tx.unsafe("set transaction isolation level repeatable read, read only; set local role sherlock_reader");
    const before = await tx.unsafe(oldUsage, params);
    const after = await tx.unsafe(QUERY_USAGE_SQL, params);
    expect(normalized(after)).toEqual(normalized(before));
    expect(normalized(await tx.unsafe(PRECOMPUTED_USAGE_SQL, params))).toEqual(normalized(after));
    const coverageParams = [...params, versions];
    expect([...await tx.unsafe(COVERAGE_SQL, coverageParams)])
      .toEqual([...await tx.unsafe(oldCoverage, coverageParams)]);
  });
  await expectDayCheckHealsGaps(sql, workspaceId, { start, end });
}

// COR-5214: the per-day check against raw usage finds a session that was never
// computed, keeps the window off the table until it is recomputed, and queues it.
async function expectDayCheckHealsGaps(sql, workspaceId, { start, end }) {
  const day = "($2::timestamptz at time zone 'UTC')::date";
  const check = () => sql.unsafe(
    `select * from analytics.check_usage_contribution_day($1::uuid, ${day})`, [workspaceId, start],
  ).then((rows) => rows[0]);
  const gapOpen = () => sql.begin(async (tx) => {
    await tx.unsafe("set local role sherlock_reader");
    // The reader can run the gate and the whole freshness check.
    await tx.unsafe(USAGE_CONTRIBUTION_STATE_SQL, [workspaceId, start, end]);
    const [row] = await tx.unsafe(
      "select analytics.usage_contribution_gap_open($1::uuid, $2::timestamptz, $3::timestamptz) open",
      [workspaceId, start, end],
    );
    return row.open;
  });
  await sql.unsafe("delete from analytics.usage_contribution_dirty where workspace_id = $1::uuid", [workspaceId]);
  const clean = await check();
  expect(Number(clean.missing_sessions)).toBe(0);
  expect(Number(clean.stale_sessions)).toBe(0);
  expect(clean.gap_session_ids).toEqual([]);
  expect(await gapOpen()).toBe(false);
  if (Number(clean.raw_sessions) === 0) return;

  // Lose one session's computed state without a dirty mark.
  const [{ session_id: lost }] = await sql.unsafe(`
    select e.session_id from telemetry.events e
     where e.workspace_id = $1::uuid and e.event_kind = 'usage' and not e.is_replay
       and e.occurred_at >= $2::timestamptz and e.occurred_at < $2::timestamptz + interval '1 day'
       and (e.occurred_at at time zone 'UTC')::date = ${day}
     order by e.session_id limit 1`, [workspaceId, start]);
  await sql.unsafe(
    "delete from analytics.usage_contribution_sessions where workspace_id = $1::uuid and session_id = $2::uuid",
    [workspaceId, lost],
  );
  const flagged = await check();
  expect(Number(flagged.missing_sessions)).toBe(1);
  expect(flagged.gap_session_ids).toEqual([lost]);
  expect(await gapOpen()).toBe(true);
  const [{ queued }] = await sql.unsafe(
    "select count(*)::int queued from analytics.usage_contribution_dirty where workspace_id = $1::uuid and session_id = $2::uuid",
    [workspaceId, lost],
  );
  expect(queued).toBe(1);

  // The refresh recomputes it; the gap closes without another check.
  await sql.unsafe("select analytics.compute_usage_contributions($1::uuid, array[$2::uuid])", [workspaceId, lost]);
  expect(await gapOpen()).toBe(false);
  expect(Number((await check()).missing_sessions)).toBe(0);
}
