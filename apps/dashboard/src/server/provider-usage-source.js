import { FlameSourceError, PEOPLE_SQL } from "./flame-source.js";

export const PROVIDER_USAGE_SQL = `
with roster as (${PEOPLE_SQL}), latest as (
  select distinct on (s.person_id, s.native_thread_id)
    s.id::text as snapshot_id, s.person_id::text, r.display_name,
    s.native_thread_id, s.observed_at, s.raw_sha256, s.raw_response
  from telemetry.provider_usage_snapshots s
  join roster r on r.person_id = s.person_id::text
  where s.workspace_id = $1
  order by s.person_id, s.native_thread_id, (s.raw_response::jsonb ->> 'data_as_of')::timestamptz desc, s.observed_at desc, s.id desc
)
select * from latest order by observed_at desc, snapshot_id limit 100`;

function percent(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function text(value) { return typeof value === "string" ? value.slice(0, 160) : null; }
function metrics(row) {
  return {
    weeklyLimitPercent: percent(row.weekly_limit_percent),
    fiveHourLimitPercent: percent(row.five_hour_limit_percent),
    balanceUsageCredits: typeof row.balance_usage_credits === "string" && /^\d+(?:\.\d+)?(?:E[+-]?\d+)?$/i.test(row.balance_usage_credits)
      ? row.balance_usage_credits : null,
  };
}
export function projectProviderUsage(rows) {
  return { schemaVersion: "provider-plan-usage-v1", basis: "provider_reported_plan_allowance", snapshots: rows.map((row) => {
    const raw = JSON.parse(row.raw_response);
    const thread = raw.threads.find((item) => item.thread_id === row.native_thread_id);
    if (!thread || !Number.isFinite(Date.parse(raw.data_as_of))) throw new FlameSourceError("flame_database_result_invalid");
    return {
      snapshotId: row.snapshot_id, personId: row.person_id, displayName: row.display_name,
      nativeThreadId: row.native_thread_id, provider: "codex", rawSha256: row.raw_sha256,
      observedAt: new Date(row.observed_at).toISOString(), dataAsOf: new Date(raw.data_as_of).toISOString(),
      dataStatus: text(thread.data_status), usageSource: text(thread.usage_source),
      tokenCountsAvailable: false, allowanceWindowKnown: false,
      ...metrics(thread),
      relatedUnavailableThreads: raw.threads.filter((item) => item.thread_id !== row.native_thread_id && item.data_status === "unavailable").length,
      groups: (Array.isArray(thread.groups) ? thread.groups : []).slice(0, 100).map((group) => ({
        model: text(group.model), reasoningEffort: text(group.reasoning_effort), speed: text(group.speed), ...metrics(group),
      })),
    };
  }) };
}
export function createProviderUsageSource(source) {
  return { async fetchProviderUsage({ signal } = {}) {
    return source.transaction(async (tx) => projectProviderUsage(await tx.unsafe(PROVIDER_USAGE_SQL,
      [source.workspaceId, source.maxPeople, source.expectedEmailDomain])), { signal });
  } };
}
