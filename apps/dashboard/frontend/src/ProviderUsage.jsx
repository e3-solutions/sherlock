import { useEffect, useState } from "react";

export default function ProviderUsage() {
  const [result, setResult] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function load() {
      try {
        const response = await fetch("/api/provider-usage", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const payload = await response.json();
        if (!Array.isArray(payload.snapshots)) throw new Error("Invalid response");
        if (!controller.signal.aborted) { setResult(payload); setFailed(false); }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { if (!controller.signal.aborted) timer = window.setTimeout(load, 60_000); }
    }
    load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, []);
  return <section className="provider-usage" aria-label="Recovered provider usage">
    <h2>Recovered cloud usage</h2>
    {failed ? <p role="status">Provider usage refresh unavailable{result ? ". Showing the last successful snapshot." : ". Retrying shortly."}</p> : null}
    {!result && !failed ? <p>Loading provider usage…</p> : null}
    {result?.snapshots.length === 0 ? <p>No recovered provider usage snapshots.</p> : null}
    {result?.snapshots.map((item) => <details key={item.snapshotId}>
      <summary><strong>{item.displayName}</strong> · {item.weeklyLimitPercent === null ? "Weekly usage unavailable" : `${item.weeklyLimitPercent.toFixed(2)}% of weekly plan allowance`} · {item.dataStatus ?? "Status unknown"} · as of {new Date(item.dataAsOf).toLocaleString()} · token counts unavailable</summary>
      <p>Codex chat <code>{item.nativeThreadId}</code><br />Provider data through {new Date(item.dataAsOf).toLocaleString()} · recovered {new Date(item.observedAt).toLocaleString()}</p>
      <p>Provider-reported plan usage estimate. Token counts unavailable. Allowance window and inclusion of subagents unknown. {item.relatedUnavailableThreads} related chats have unavailable usage.</p>
      <ul>{item.groups.map((group, index) => <li key={index}>{group.model} · {group.reasoningEffort} · {group.speed}: {group.weeklyLimitPercent === null ? "unavailable" : `${group.weeklyLimitPercent.toFixed(2)}% weekly allowance`}</li>)}</ul>
    </details>)}
  </section>;
}
