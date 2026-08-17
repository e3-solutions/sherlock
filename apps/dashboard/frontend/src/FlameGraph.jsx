import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bar,
  ComposedChart,
  Line,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  BUCKET_COUNT,
  BUCKET_MS,
  adaptPromptEvidence,
  createTimeAxisTicks,
  getGlobalPeak,
  getPersonActivityStatus,
} from "./flame-data.js";

const LANE_HEIGHT = 82;
const MIN_PROMPT_STEM_LENGTH = 4;
const MAX_PROMPT_STEM_LENGTH = 14;
const TOOLTIP_EDGE_PADDING = 8;
const TOOLTIP_GAP = 10;
const DEFAULT_TOOLTIP_SIZE = { width: 224, height: 136 };

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function formatTime(value) {
  return timeFormatter.format(new Date(value));
}

function formatSessionCount(value) {
  return `${value} observed ${value === 1 ? "session" : "sessions"}`;
}

function formatPromptCount(value) {
  return `${value} ${value === 1 ? "prompt" : "prompts"}`;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function getBucketTooltipPlacement({
  anchor,
  tooltip,
  viewport,
  gap = TOOLTIP_GAP,
  padding = TOOLTIP_EDGE_PADDING,
}) {
  const maxLeft = Math.max(padding, viewport.width - padding - tooltip.width);
  const maxTop = Math.max(padding, viewport.height - padding - tooltip.height);
  const right = anchor.x + gap;
  const left = anchor.x - gap - tooltip.width;
  const above = anchor.y - gap - tooltip.height;
  const below = anchor.y + gap;

  let horizontal = "right";
  let resolvedLeft = right;
  if (right + tooltip.width > viewport.width - padding) {
    if (left >= padding) {
      horizontal = "left";
      resolvedLeft = left;
    } else {
      horizontal = "center";
      resolvedLeft = anchor.x - tooltip.width / 2;
    }
  }

  let vertical = "above";
  let resolvedTop = above;
  if (above < padding) {
    if (below + tooltip.height <= viewport.height - padding) {
      vertical = "below";
      resolvedTop = below;
    } else {
      vertical = "center";
      resolvedTop = anchor.y - tooltip.height / 2;
    }
  }

  return {
    horizontal,
    vertical,
    left: clamp(resolvedLeft, padding, maxLeft),
    top: clamp(resolvedTop, padding, maxTop),
  };
}

export function BucketTooltip({ active, coordinate, laneRef, payload, personName }) {
  const tooltipRef = useRef(null);
  const [tooltipSize, setTooltipSize] = useState(DEFAULT_TOOLTIP_SIZE);
  const [, reposition] = useState(0);
  const point = payload?.find((entry) => entry?.payload)?.payload;

  useLayoutEffect(() => {
    if (!active || !point || !tooltipRef.current) return;
    const { width, height } = tooltipRef.current.getBoundingClientRect();
    if (width > 0 && height > 0) {
      setTooltipSize((current) => (
        current.width === width && current.height === height
          ? current
          : { width, height }
      ));
    }
  }, [active, personName]);

  useEffect(() => {
    if (!active || !point || typeof window === "undefined") return undefined;
    const update = () => reposition((revision) => revision + 1);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [active]);

  if (!active || !point) return null;

  const laneBox = laneRef?.current?.getBoundingClientRect();
  const hasAnchor = laneBox && Number.isFinite(coordinate?.x);
  const placement = hasAnchor && typeof window !== "undefined"
    ? getBucketTooltipPlacement({
        anchor: {
          x: laneBox.left + coordinate.x,
          y: laneBox.top + laneBox.height / 2,
        },
        tooltip: tooltipSize,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      })
    : null;
  const activityLabel = formatSessionCount(point.activity);
  const description = `${personName}, ${formatTime(point.startMs)} to ${formatTime(point.endMs)}: ${activityLabel}; ${point.agent} agent, ${point.subagent} subagent, ${point.unclassified} unclassified; ${point.prompts} prompts`;

  return (
    <output
      ref={tooltipRef}
      className="flame-tooltip"
      role="status"
      aria-atomic="true"
      aria-label={description}
      aria-live="polite"
      data-horizontal={placement?.horizontal}
      data-vertical={placement?.vertical}
      style={placement ? { left: placement.left, top: placement.top } : undefined}
    >
      <span className="flame-tooltip-heading">
        <strong>{personName}</strong>
        <time dateTime={new Date(point.startMs).toISOString()}>
          {formatTime(point.startMs)}–{formatTime(point.endMs)}
        </time>
      </span>
      <strong className="flame-tooltip-activity">{activityLabel}</strong>
      <span className="flame-tooltip-count"><span>Agent</span> {point.agent}</span>
      <span className="flame-tooltip-count"><span>Subagent</span> {point.subagent}</span>
      <span className="flame-tooltip-count"><span>Unclassified</span> {point.unclassified}</span>
      <span className="flame-tooltip-count"><span>Prompts</span> {point.prompts}</span>
    </output>
  );
}

function promptStemLength(prompts, promptPeak) {
  const magnitude = Math.log1p(prompts) / Math.log1p(Math.max(1, promptPeak));
  return MIN_PROMPT_STEM_LENGTH
    + magnitude * (MAX_PROMPT_STEM_LENGTH - MIN_PROMPT_STEM_LENGTH);
}

function PromptStem({ cx, cy, payload, personName, promptPeak }) {
  if (!payload?.prompts || !Number.isFinite(cx) || !Number.isFinite(cy)) {
    return null;
  }

  const length = promptStemLength(payload.prompts, promptPeak);
  const label = `${personName}, ${formatTime(payload.startMs)}–${formatTime(payload.endMs)}: ${payload.prompts} ${payload.prompts === 1 ? "prompt" : "prompts"}`;

  return (
    <g
      className="flame-prompt-stem"
      role="img"
      aria-label={label}
      data-bucket-index={payload.index}
      data-prompt-count={payload.prompts}
      data-stem-length={length.toFixed(2)}
    >
      <title>{label}</title>
      <line
        className="flame-prompt-stem__line"
        x1={cx}
        y1={cy}
        x2={cx}
        y2={cy + length}
        vectorEffect="non-scaling-stroke"
      />
      <line
        className="flame-prompt-stem__hit-area"
        x1={cx}
        y1={cy}
        x2={cx}
        y2={cy + length}
        vectorEffect="non-scaling-stroke"
        aria-hidden="true"
      />
      <circle
        className="flame-prompt-stem__cap"
        cx={cx}
        cy={cy + length}
        r={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
}

function IntervalDetail({
  person,
  point,
  closing,
  onClose,
  onCloseAnimationEnd,
  detailRef,
  promptEvidence,
  onRetryPrompts,
}) {
  const roles = [
    { key: "agent", label: "Agent", value: point.agent },
    { key: "subagent", label: "Subagent", value: point.subagent },
    { key: "unclassified", label: "Unclassified", value: point.unclassified },
  ];
  const activeRoles = roles.filter(({ value }) => value > 0);
  const headingId = `flame-detail-${person.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const handleAnimationEnd = (event) => {
    if (event.target === event.currentTarget) {
      onCloseAnimationEnd();
    }
  };

  return (
    <aside
      ref={detailRef}
      className={`flame-detail${closing ? " flame-detail--closing" : ""}`}
      aria-labelledby={headingId}
      onAnimationEnd={handleAnimationEnd}
      tabIndex={-1}
    >
      <header className="flame-detail__header">
        <div>
          <p className="flame-detail__eyebrow">Frame evidence</p>
          <h2>
            <span id={headingId}>{person.name}</span>
            <span aria-hidden="true"> · </span>
            <span className="flame-detail__range">
              <time dateTime={new Date(point.startMs).toISOString()}>{formatTime(point.startMs)}</time>
              <span aria-hidden="true">–</span>
              <time dateTime={new Date(point.endMs).toISOString()}>{formatTime(point.endMs)}</time>
            </span>
          </h2>
          <p className="flame-detail__totals">
            {point.activity} {point.activity === 1 ? "session" : "sessions"}
            <span aria-hidden="true"> · </span>
            {formatPromptCount(point.prompts)}
          </p>
        </div>
        <button
          type="button"
          className="flame-detail__close"
          disabled={closing}
          onClick={onClose}
        >
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 24 24"
          >
            <path d="M6 6 18 18M18 6 6 18" />
          </svg>
          <span className="visually-hidden">Close interval details</span>
        </button>
      </header>

      <section className="flame-detail__section" aria-labelledby={`${headingId}-prompts`}>
        <h3 id={`${headingId}-prompts`}>What happened</h3>
        {point.prompts === 0 ? (
          <p className="flame-detail__empty">No prompts in this interval.</p>
        ) : promptEvidence.state === "loading" ? (
          <p className="flame-detail__empty" role="status">Loading prompts…</p>
        ) : promptEvidence.state === "error" ? (
          <div className="flame-detail__prompt-error" role="alert">
            <p>Prompts could not be loaded.</p>
            <button type="button" onClick={onRetryPrompts}>Retry</button>
          </div>
        ) : (
          <ol className="flame-detail__prompts">
            {promptEvidence.items.map((prompt) => (
              <li key={prompt.id}>
                <header>
                  <strong>User</strong>
                  <time dateTime={new Date(prompt.atMs).toISOString()}>
                    {formatTime(prompt.atMs)}
                  </time>
                  {prompt.truncated && <span>Stored excerpt</span>}
                </header>
                <p>{prompt.content || "Prompt text was empty."}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="flame-detail__section" aria-labelledby={`${headingId}-sessions`}>
        <h3 id={`${headingId}-sessions`}>Sessions</h3>
        {activeRoles.length > 0 ? (
          <ul className="flame-detail__roles">
            {activeRoles.map(({ key, label, value }) => (
              <li key={key}>
                <i className={`flame-key flame-key--${key}`} aria-hidden="true" />
                <span>{label}</span>
                <strong>{formatSessionCount(value)}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flame-detail__empty">No sessions in this interval.</p>
        )}
      </section>
    </aside>
  );
}

function SemanticLegend() {
  return (
    <ul className="flame-legend" aria-label="Activity legend">
      <li><i className="flame-key flame-key--agent" aria-hidden="true" />Agent</li>
      <li><i className="flame-key flame-key--subagent" aria-hidden="true" />Subagent</li>
      <li><i className="flame-key flame-key--unclassified" aria-hidden="true" />Unclassified</li>
      <li><i className="flame-key flame-key--prompt" aria-hidden="true" />Prompts</li>
    </ul>
  );
}

const ACTIVITY_STATUS = {
  active: {
    label: "Active",
    description: "activity observed in the last 10 minutes",
  },
  recent: {
    label: "Recently active",
    description: "activity observed more than 10 and up to 30 minutes ago",
  },
  inactive: {
    label: "Inactive",
    description: "no observed session evidence in the trailing 30 minutes",
  },
};

function PersonRail({ person, headingId, readMs }) {
  const status = getPersonActivityStatus(person, readMs);
  const { label, description } = ACTIVITY_STATUS[status];

  return (
    <header className="flame-person-rail">
      <h2 id={headingId} title={person.name}>{person.name}</h2>
      <span
        className={`flame-person-status flame-person-status--${status}`}
        role="img"
        aria-label={`${person.name}: ${label}; ${description}`}
        title={`${label} — ${description}`}
      />
    </header>
  );
}

function PersonLane({ person, peak, promptPeak, chartWidth, selectedIndex, onSelect, readMs }) {
  const laneRef = useRef(null);
  const [keyboardIndex, setKeyboardIndex] = useState(0);
  const rawId = useId();
  const id = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const headingId = `flame-person-${id}`;
  const points = useMemo(
    () => person.buckets.map((point) => ({
      ...point,
      promptMarker: point.prompts > 0 ? 0 : null,
    })),
    [person.buckets],
  );

  const select = (point) => {
    const target = laneRef.current?.querySelector('[role="application"]');
    onSelect(person, point, target);
  };

  const handleClick = (event) => {
    const wrapper = laneRef.current?.querySelector(".recharts-wrapper");
    const bounds = wrapper?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || !Number.isFinite(event.clientX)) return;
    const index = clamp(
      Math.floor(((event.clientX - bounds.left) / bounds.width) * points.length),
      0,
      points.length - 1,
    );
    setKeyboardIndex(index);
    select(points[index]);
  };

  const handleKeyDown = (event) => {
    if (event.key === "ArrowRight") {
      setKeyboardIndex((index) => Math.min(points.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowLeft") {
      setKeyboardIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Home") {
      setKeyboardIndex(0);
      return;
    }
    if (event.key === "End") {
      setKeyboardIndex(points.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      select(points[keyboardIndex]);
    }
  };

  return (
    <section
      className="flame-person"
      aria-labelledby={headingId}
      data-selected={selectedIndex === undefined ? undefined : "true"}
    >
      <PersonRail person={person} headingId={headingId} readMs={readMs} />
      <div
        ref={laneRef}
        className="flame-lane"
        style={{ width: chartWidth }}
        role="group"
        aria-label={`${person.name} activity timeline, 144 ten-minute buckets`}
        data-bucket-count={points.length}
        data-selected-index={selectedIndex}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <ComposedChart
          accessibilityLayer
          width={chartWidth}
          height={LANE_HEIGHT}
          data={points}
          margin={{ top: 10, right: 0, bottom: 22, left: 0 }}
          aria-label={`${person.name} activity timeline`}
        >
          <XAxis dataKey="index" type="category" hide interval={0} />
          <YAxis yAxisId="activity" hide domain={[0, peak]} allowDataOverflow />
          <YAxis yAxisId="prompts" hide domain={[0, 1]} />
          <Tooltip
            content={<BucketTooltip laneRef={laneRef} personName={person.name} />}
            cursor={false}
            isAnimationActive={false}
            portal={typeof document === "undefined" ? null : document.body}
            wrapperStyle={{
              height: 0,
              left: 0,
              outline: "none",
              pointerEvents: "none",
              position: "fixed",
              top: 0,
              width: 0,
              zIndex: 12,
            }}
          />
          <Bar
            yAxisId="activity"
            dataKey="agent"
            name="Agent"
            stackId="activity"
            fill="var(--flame-agent)"
            isAnimationActive={false}
          />
          <Bar
            yAxisId="activity"
            dataKey="subagent"
            name="Subagent"
            stackId="activity"
            fill="var(--flame-subagent)"
            isAnimationActive={false}
          />
          <Bar
            yAxisId="activity"
            dataKey="unclassified"
            name="Unclassified"
            stackId="activity"
            fill="var(--flame-unclassified)"
            isAnimationActive={false}
          />
          <Line
            yAxisId="prompts"
            dataKey="promptMarker"
            name="Prompts"
            stroke="none"
            dot={<PromptStem personName={person.name} promptPeak={promptPeak} />}
            activeDot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </div>
    </section>
  );
}

export function getAvailableChartWidth(containerWidth, railWidth) {
  return Math.max(1, containerWidth - railWidth);
}

function useSharedChartWidth(rootRef, requestedWidth) {
  const [measuredWidth, setMeasuredWidth] = useState(requestedWidth ?? 1);

  useLayoutEffect(() => {
    if (Number.isFinite(requestedWidth)) {
      setMeasuredWidth(requestedWidth);
      return undefined;
    }

    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return undefined;

    const update = () => {
      const rail = Number.parseFloat(getComputedStyle(root).getPropertyValue("--flame-rail")) || 260;
      setMeasuredWidth(getAvailableChartWidth(root.clientWidth, rail));
    };
    const observer = new ResizeObserver(update);
    observer.observe(root);
    update();
    return () => observer.disconnect();
  }, [requestedWidth, rootRef]);

  return Math.max(1, measuredWidth);
}

export default function FlameGraph({ data, chartWidth, stale = false }) {
  const rootRef = useRef(null);
  const detailRef = useRef(null);
  const selectionOriginRef = useRef(null);
  const detailClosingRef = useRef(false);
  const [selection, setSelection] = useState(null);
  const [detailClosing, setDetailClosing] = useState(false);
  const [promptRevision, setPromptRevision] = useState(0);
  const [promptEvidence, setPromptEvidence] = useState({ state: "idle", items: [] });
  const width = useSharedChartWidth(rootRef, chartWidth);
  const peak = Math.max(1, data.globalPeak ?? getGlobalPeak(data.people));
  const promptPeak = data.people.reduce(
    (peoplePeak, person) => person.buckets.reduce(
      (personPeak, { prompts }) => Math.max(personPeak, prompts),
      peoplePeak,
    ),
    1,
  );
  const ticks = data.axisTicks ?? createTimeAxisTicks(data.startMs);
  const endMs = data.startMs + BUCKET_COUNT * BUCKET_MS;
  const selectedPerson = selection
    ? data.people.find(({ id }) => id === selection.personId)
    : null;
  const selectedPoint = selectedPerson
    ? selectedPerson.buckets.find(({ startMs }) => startMs === selection.startMs)
    : null;

  const beginCloseDetail = useCallback(() => {
    if (!selection || detailClosingRef.current) return;
    detailClosingRef.current = true;
    setDetailClosing(true);
  }, [selection]);

  const finalizeCloseDetail = useCallback(() => {
    if (!detailClosingRef.current) return;
    detailClosingRef.current = false;
    setDetailClosing(false);
    setSelection(null);
    requestAnimationFrame(() => selectionOriginRef.current?.focus());
  }, []);

  useEffect(() => {
    if (selection && (!selectedPerson || !selectedPoint)) {
      detailClosingRef.current = false;
      setDetailClosing(false);
      setSelection(null);
    }
  }, [selection, selectedPerson, selectedPoint]);

  useEffect(() => {
    if (!selectedPoint) return undefined;
    detailRef.current?.focus();
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        beginCloseDetail();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [beginCloseDetail, selectedPoint]);

  useEffect(() => {
    if (!selectedPerson || !selectedPoint) {
      setPromptEvidence({ state: "idle", items: [] });
      return undefined;
    }
    if (selectedPoint.prompts === 0) {
      setPromptEvidence({ state: "ready", items: [] });
      return undefined;
    }

    const controller = new AbortController();
    setPromptEvidence({ state: "loading", items: [] });
    const query = new URLSearchParams({
      personId: selectedPerson.id,
      start: new Date(selectedPoint.startMs).toISOString(),
      snapshot: data.snapshot,
    });
    fetch(`/api/flame/prompts?${query}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Prompt request failed with HTTP ${response.status}`);
        return response.json();
      })
      .then((value) => {
        if (controller.signal.aborted) return;
        const items = adaptPromptEvidence(value, {
          personId: selectedPerson.id,
          startMs: selectedPoint.startMs,
          snapshot: data.snapshot,
        });
        if (items.length !== selectedPoint.prompts) {
          throw new Error("Prompt evidence count does not match the timeline snapshot");
        }
        setPromptEvidence({ state: "ready", items });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPromptEvidence({ state: "error", items: [] });
      });
    return () => controller.abort();
  }, [data.snapshot, promptRevision, selectedPerson, selectedPoint]);

  const selectInterval = (person, point, origin) => {
    detailClosingRef.current = false;
    setDetailClosing(false);
    selectionOriginRef.current = origin;
    setSelection({ personId: person.id, startMs: point.startMs });
  };

  return (
    <section
      ref={rootRef}
      className="flame-graph"
      data-state={stale ? "stale" : "current"}
      aria-label="Code activity over the last 24 hours"
    >
      <div className="flame-graph-scroll">
        <div className="flame-meta-row">
          <div className="flame-meta-rail">
            <SemanticLegend />
          </div>
          <div
            className="flame-time-axis"
            style={{ width }}
            aria-label={`Time from ${formatTime(data.startMs)} to ${formatTime(endMs)}`}
          >
            {ticks.map((tick, index) => {
              const at = typeof tick === "number" ? tick : (tick.atMs ?? tick.value ?? tick.startMs);
              return (
                <time
                  key={at}
                  dateTime={new Date(at).toISOString()}
                  style={{ left: `${(index / (ticks.length - 1)) * 100}%` }}
                >
                  {formatTime(at)}
                </time>
              );
            })}
          </div>
        </div>
        {data.people.map((person) => (
          <PersonLane
            key={person.id}
            person={person}
            peak={peak}
            promptPeak={promptPeak}
            chartWidth={width}
            readMs={data.readMs}
            selectedIndex={selectedPerson?.id === person.id ? selectedPoint?.index : undefined}
            onSelect={selectInterval}
          />
        ))}
      </div>
      {selectedPerson && selectedPoint && (
        <IntervalDetail
          person={selectedPerson}
          point={selectedPoint}
          closing={detailClosing}
          onClose={beginCloseDetail}
          onCloseAnimationEnd={finalizeCloseDetail}
          detailRef={detailRef}
          promptEvidence={promptEvidence}
          onRetryPrompts={() => setPromptRevision((revision) => revision + 1)}
        />
      )}
    </section>
  );
}
