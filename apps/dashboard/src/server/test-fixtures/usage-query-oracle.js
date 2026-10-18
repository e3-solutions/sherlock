import { URL as FileURL } from "node:url";
import { readFileSync } from "node:fs";
import { expect } from "vitest";

import { COVERAGE_SQL, QUERY_USAGE_SQL } from "../mcp-query-source.js";

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
  await sql.begin(async (tx) => {
    await tx.unsafe("set transaction isolation level repeatable read, read only; set local role sherlock_reader");
    const before = await tx.unsafe(oldUsage, params);
    const after = await tx.unsafe(QUERY_USAGE_SQL, params);
    expect(normalized(after)).toEqual(normalized(before));
    const coverageParams = [...params, versions];
    expect([...await tx.unsafe(COVERAGE_SQL, coverageParams)])
      .toEqual([...await tx.unsafe(oldCoverage, coverageParams)]);
  });
}
