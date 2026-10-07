import { describe, it, expect, vi } from "vitest";
import { projectProviderUsage, createProviderUsageSource, PROVIDER_USAGE_SQL } from "./provider-usage-source.js";
const row = { snapshot_id: "receipt", person_id: "owner", display_name: "Person", native_thread_id: "cloud", observed_at: "2026-10-05T08:00:00Z", raw_sha256: "hash", raw_response: JSON.stringify({ data_as_of: "2026-10-05T05:26:56.586098Z", secret: "private", threads: [{ thread_id: "cloud", weekly_limit_percent: 19.44527799749026, five_hour_limit_percent: null, balance_usage_credits: "0E-10", data_status: "partial", usage_source: "included_plan", groups: [{model:"gpt-6.1-sol", weekly_limit_percent: 18.189122087295402, secret: "private"}] }, {thread_id:"child",data_status:"unavailable"}] }) };
describe("provider billing evidence", () => {
  it("preserves reported units, unknowns, cutoff and partial coverage without private fields", () => {
    const data = projectProviderUsage([row]);
    expect(data.snapshots[0]).toMatchObject({ weeklyLimitPercent:19.44527799749026, fiveHourLimitPercent:null, balanceUsageCredits:"0E-10", dataStatus:"partial", dataAsOf:"2026-10-05T05:26:56.586Z", tokenCountsAvailable:false, allowanceWindowKnown:false, relatedUnavailableThreads:1 });
    expect(JSON.stringify(data)).not.toContain("private");
    expect(JSON.stringify(data)).not.toContain("tokensTotal");
  });
  it("does not manufacture zeros for unavailable usage", () => {
    const raw=JSON.parse(row.raw_response);raw.threads[0]={thread_id:"cloud",data_status:"unavailable"};
    expect(projectProviderUsage([{...row,raw_response:JSON.stringify(raw)}]).snapshots[0].weeklyLimitPercent).toBeNull();
    expect(projectProviderUsage([]).snapshots).toEqual([]);
  });
  it("rejects mismatched source thread identity", () => { expect(()=>projectProviderUsage([{...row,native_thread_id:"absent"}])).toThrow(); });
  it("uses roster scope and existing read-only transaction with abort signal", async () => {
    const unsafe=vi.fn().mockResolvedValue([row]);const transaction=vi.fn(async(fn)=>fn({unsafe}));const signal=new AbortController().signal;
    await createProviderUsageSource({transaction,workspaceId:"workspace",maxPeople:12,expectedEmailDomain:"e3group.ai"}).fetchProviderUsage({signal});
    expect(unsafe).toHaveBeenCalledWith(PROVIDER_USAGE_SQL,["workspace",12,"e3group.ai"]);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function),{signal});
    expect(PROVIDER_USAGE_SQL).toContain("s.workspace_id = $1");expect(PROVIDER_USAGE_SQL).toContain("sherlock-smoke");
  });
});
