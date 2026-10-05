import {render,screen,cleanup} from "@testing-library/react";
import {it,expect,vi,afterEach} from "vitest";
import ProviderUsage from "./ProviderUsage.jsx";
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("shows partial plan usage, cutoff and unavailable token counts",async()=>{
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,json:async()=>({snapshots:[{snapshotId:"receipt",displayName:"Person",nativeThreadId:"thread",weeklyLimitPercent:19.44527799749026,dataStatus:"partial",dataAsOf:"2026-10-05T05:26:56Z",observedAt:"2026-10-05T08:00:00Z",relatedUnavailableThreads:41,groups:[]}]})}));
 render(<ProviderUsage/>);expect(await screen.findByText(/19.45% of weekly plan allowance/)).toBeInTheDocument();expect(screen.getByText(/Token counts unavailable/)).toBeInTheDocument();expect(screen.getByText(/Provider data through/)).toBeInTheDocument();
});
it("renders independent error and empty states",async()=>{
 vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error()));render(<ProviderUsage/>);expect(await screen.findByText(/refresh unavailable/)).toBeInTheDocument();cleanup();
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,json:async()=>({snapshots:[]})}));render(<ProviderUsage/>);expect(await screen.findByText(/No recovered/)).toBeInTheDocument();
});
