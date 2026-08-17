import { useCallback, useEffect, useRef, useState } from "react";

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

  const load = useCallback(async () => {
    window.clearTimeout(timerRef.current);
    requestRef.current?.abort();

    const controller = new AbortController();
    requestRef.current = controller;

    try {
      const response = await fetch("/api/flame", {
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
      setState("ready");
      setMessage("");
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
      timerRef.current = window.setTimeout(load, RETRY_MS);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => {
      mountedRef.current = false;
      window.clearTimeout(timerRef.current);
      requestRef.current?.abort();
    };
  }, [load]);

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
          <button type="button" onClick={load}>Retry</button>
        </div>
      </>
    );
  }

  return (
    <>
      <PortalHeader />
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
      <h1>Bonaparte</h1>
    </header>
  );
}

export { nextRefreshDelay };
