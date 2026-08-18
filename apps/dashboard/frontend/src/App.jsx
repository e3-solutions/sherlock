import { useCallback, useEffect, useRef, useState } from "react";

import bonaparteLogo from "./assets/bonaparte-logo.png";
import FlameGraph from "./FlameGraph.jsx";
import { adaptFlamePayload, BUCKET_MS } from "./flame-data.js";

const REFRESH_OFFSET_MS = 90 * 1000;
const RETRY_MS = 60 * 1000;

function nextRefreshDelay(now) {
  const nextClosedBucket = (Math.floor(now / BUCKET_MS) + 1) * BUCKET_MS;
  return Math.max(1000, nextClosedBucket + REFRESH_OFFSET_MS - now);
}

export default function App() {
  const [data, setData] = useState(null);
  const [state, setState] = useState("loading");
  const [message, setMessage] = useState("");
  const lastGoodRef = useRef(null);
  const timerRef = useRef(null);
  const requestRef = useRef(null);
  const mountedRef = useRef(false);

  const load = useCallback(async ({ recentFirst = false } = {}) => {
    window.clearTimeout(timerRef.current);
    requestRef.current?.abort();

    const controller = new AbortController();
    requestRef.current = controller;

    try {
      const endpoint = recentFirst ? "/api/flame?window=recent" : "/api/flame";
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Flame request failed with HTTP ${response.status}`);
      }

      const nextData = adaptFlamePayload(await response.json());
      if (!mountedRef.current || controller.signal.aborted) return;

      lastGoodRef.current = nextData;
      setData(nextData);
      setMessage("");
      if (recentFirst) {
        setState("expanding");
        return;
      }

      setState("ready");
      timerRef.current = window.setTimeout(load, nextRefreshDelay(Date.now()));
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted) return;

      const detail = error instanceof Error ? error.message : "Unknown error";
      setMessage(detail);
      if (lastGoodRef.current) {
        setState("stale");
      } else {
        setState("error");
      }
      timerRef.current = window.setTimeout(
        () => load({ recentFirst: !lastGoodRef.current }),
        RETRY_MS,
      );
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load({ recentFirst: true });
    return () => {
      mountedRef.current = false;
      window.clearTimeout(timerRef.current);
      requestRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (state === "expanding") load();
  }, [load, state]);

  if (!data && state === "loading") {
    return (
      <>
        <PortalHeader />
        <div className="load-state" role="status">Loading timeline</div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PortalHeader />
        <div className="load-state" role="alert">
          <span>Timeline unavailable</span>
          <button type="button" onClick={() => load({ recentFirst: true })}>Retry</button>
        </div>
      </>
    );
  }

  return (
    <>
      <PortalHeader />
      {state === "expanding" && (
        <p className="refresh-warning" role="status">
          Showing the latest 2 hours while earlier intervals load.
        </p>
      )}
      {state === "stale" && (
        <p className="refresh-warning" role="status">
          Refresh failed. Showing the last successful read.
          <span className="visually-hidden"> {message}</span>
        </p>
      )}
      <FlameGraph data={data} stale={state === "stale"} />
    </>
  );
}

function PortalHeader() {
  return (
    <header className="portal-header">
      <div className="portal-header__brand">
        <img
          className="portal-header__logo"
          src={bonaparteLogo}
          alt=""
          aria-hidden="true"
        />
        <h1>Bonaparte</h1>
      </div>
      <aside className="portal-header__legend" aria-label="Timeline legend">
        <SemanticLegend />
      </aside>
    </header>
  );
}

function SemanticLegend() {
  return (
    <div className="flame-legends">
      <ul className="flame-status-legend" aria-label="Activity recency legend">
        <li aria-label="Green: activity 10 minutes ago or less">
          <i className="flame-status-key flame-person-status--active" aria-hidden="true" />
          ≤10m
        </li>
        <li aria-label="Yellow: activity more than 10 and up to 30 minutes ago">
          <i className="flame-status-key flame-person-status--recent" aria-hidden="true" />
          &gt;10m–≤30m
        </li>
        <li aria-label="Red: activity more than 30 minutes ago or no activity">
          <i className="flame-status-key flame-person-status--inactive" aria-hidden="true" />
          &gt;30m / none
        </li>
      </ul>
      <ul className="flame-legend" aria-label="Activity legend">
        <li><i className="flame-key flame-key--agent" aria-hidden="true" />Agent</li>
        <li><i className="flame-key flame-key--subagent" aria-hidden="true" />Subagent</li>
        <li><i className="flame-key flame-key--unclassified" aria-hidden="true" />Unclassified</li>
        <li><i className="flame-key flame-key--prompt" aria-hidden="true" />Prompts</li>
      </ul>
    </div>
  );
}

export { nextRefreshDelay };
