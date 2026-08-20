import { useCallback, useEffect, useRef, useState } from "react";

import bonaparteLogo from "./assets/bonaparte-logo.png";
import FlameGraph, {
  DEFAULT_PERSON_RANK,
  PERSON_RANK_OPTIONS,
} from "./FlameGraph.jsx";
import { adaptFlamePayload, BUCKET_MS } from "./flame-data.js";

const REFRESH_OFFSET_MS = 90 * 1000;
const RETRY_MS = 60 * 1000;

function nextRefreshDelay(now) {
  const boundary = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const candidate = boundary + REFRESH_OFFSET_MS;
  return Math.max(1000, (candidate > now ? candidate : candidate + BUCKET_MS) - now);
}

function expectedTimelineEnd(now) {
  return Math.floor((now - REFRESH_OFFSET_MS) / BUCKET_MS) * BUCKET_MS;
}

function readAge(readMs, now) {
  const elapsed = Math.max(0, now - readMs);
  if (elapsed < 60 * 1000) return "just now";
  if (elapsed < 60 * 60 * 1000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / (60 * 60 * 1000))}h ago`;
}

function timelineFreshness(data, now) {
  const end = data.startMs + 24 * 60 * 60 * 1000;
  const through = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(end);
  return {
    delayed: end < expectedTimelineEnd(now) || (
      end === expectedTimelineEnd(now) && data.readMs < end + REFRESH_OFFSET_MS
    ),
    label: `Through ${through} · read ${readAge(data.readMs, now)}`,
  };
}

export default function App() {
  const [data, setData] = useState(null);
  const [state, setState] = useState("loading");
  const [message, setMessage] = useState("");
  const [clock, setClock] = useState(() => Date.now());
  const [rankBy, setRankBy] = useState(DEFAULT_PERSON_RANK);
  const lastGoodRef = useRef(null);
  const timerRef = useRef(null);
  const requestRef = useRef(null);
  const mountedRef = useRef(false);

  const load = useCallback(async ({ refresh = "" } = {}) => {
    window.clearTimeout(timerRef.current);
    requestRef.current?.abort();

    const controller = new AbortController();
    requestRef.current = controller;

    try {
      const response = await fetch(refresh ? `/api/flame?refresh=${refresh}` : "/api/flame", {
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
      const delayed = timelineFreshness(nextData, Date.now()).delayed;
      setClock(Date.now());
      setState(delayed ? "delayed" : "ready");
      timerRef.current = window.setTimeout(
        () => load({ refresh: "wait" }),
        delayed ? RETRY_MS : nextRefreshDelay(Date.now()),
      );
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
        () => load({ refresh: refresh === "force" ? "force" : "wait" }),
        RETRY_MS,
      );
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

  useEffect(() => {
    const ageTimer = window.setInterval(() => setClock(Date.now()), 60 * 1000);
    return () => window.clearInterval(ageTimer);
  }, []);

  if (!data && state === "loading") {
    return (
      <>
        <PortalHeader rankBy={rankBy} onRankChange={setRankBy} />
        <div className="load-state" role="status">Loading timeline</div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PortalHeader rankBy={rankBy} onRankChange={setRankBy} />
        <div className="load-state" role="alert">
          <span>Timeline unavailable</span>
          <button type="button" onClick={load}>Retry</button>
        </div>
      </>
    );
  }

  const freshness = timelineFreshness(data, clock);
  const refreshProblem = state === "stale" || freshness.delayed;

  return (
    <>
      <PortalHeader rankBy={rankBy} onRankChange={setRankBy} />
      {refreshProblem && (
        <span className="visually-hidden" role="status">
          {state === "stale" ? "Timeline refresh failed." : "Timeline update delayed."}
        </span>
      )}
      <FlameGraph
        data={data}
        rankBy={rankBy}
        stale={state === "stale" || state === "delayed"}
        onRefresh={() => load({ refresh: "force" })}
        timelineMeta={(
          <p
            className={`timeline-read${refreshProblem ? " timeline-read--delayed" : ""}`}
          >
            {state === "stale" ? "Refresh failed. " : freshness.delayed ? "Update delayed. " : ""}
            {freshness.label}
            {state === "stale" && <span className="visually-hidden"> {message}</span>}
          </p>
        )}
      />
    </>
  );
}

function PortalHeader({ rankBy, onRankChange }) {
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
        <SemanticLegend rankBy={rankBy} onRankChange={onRankChange} />
      </aside>
    </header>
  );
}

function SemanticLegend({ rankBy, onRankChange }) {
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
      <div
        className="flame-rank-selector"
        role="group"
        aria-labelledby="flame-rank-selector-label"
      >
        <span id="flame-rank-selector-label">Rank by</span>
        <div>
          {PERSON_RANK_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={rankBy === option.value}
              onClick={() => onRankChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <ul className="flame-legend" aria-label="Activity legend">
        <li><i className="flame-key flame-key--agent" aria-hidden="true" />Agent</li>
        <li><i className="flame-key flame-key--subagent" aria-hidden="true" />Subagent</li>
        <li><i className="flame-key flame-key--unclassified" aria-hidden="true" />Unclassified</li>
        <li><i className="flame-key flame-key--prompt" aria-hidden="true" />Prompts</li>
      </ul>
    </div>
  );
}

export { expectedTimelineEnd, nextRefreshDelay, timelineFreshness };
