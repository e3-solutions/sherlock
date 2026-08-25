import {
  memo,
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
  adaptIntervalEvidence,
  adaptWorkEvidence,
  createTimeAxisTicks,
  getGlobalPeak,
  getPersonActivityStatus,
} from "./flame-data.js";

const LANE_HEIGHT = 82;
const MIN_PROMPT_STEM_LENGTH = 8;
const MAX_PROMPT_STEM_LENGTH = 17;
const TOOLTIP_EDGE_PADDING = 8;
const TOOLTIP_GAP = 10;
const TOOLTIP_ARROW_CENTER_OFFSET = 17.5;
const DEFAULT_TOOLTIP_SIZE = { width: 224, height: 136 };

export const PERSON_RANK_OPTIONS = [
  { value: "roster", label: "Name" },
  { value: "active-time", label: "Active time" },
  { value: "peak-sessions", label: "Peak sessions" },
  { value: "prompts", label: "Prompts" },
  { value: "subagents", label: "Subagents" },
];

export const DEFAULT_PERSON_RANK = "active-time";

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

function personRankValue(person, rankBy) {
  if (rankBy === "active-time") return person.activeSeconds;
  if (rankBy === "peak-sessions") {
    return person.buckets.reduce(
      (peak, bucket) => Math.max(peak, bucket.activity),
      0,
    );
  }
  if (rankBy === "prompts") {
    return person.buckets.reduce((total, bucket) => total + bucket.prompts, 0);
  }
  if (rankBy === "subagents") return person.total[1];
  return 0;
}

/** Returns a ranked view without mutating the API's roster ordering. */
export function rankPeople(people, rankBy) {
  if (rankBy === "roster") return people;
  return people
    .map((person, index) => ({ person, index, value: personRankValue(person, rankBy) }))
    .sort((left, right) => right.value - left.value || left.index - right.index)
    .map(({ person }) => person);
}

async function apiFailure(response, fallback) {
  let code = fallback;
  try {
    const body = await response.json();
    if (typeof body?.error === "string") code = body.error;
  } catch {
    // The status-specific fallback still gives the drawer actionable copy.
  }
  const error = new Error(code);
  error.apiCode = code;
  return error;
}

function evidenceErrorCopy(subject, reason) {
  if (reason?.endsWith("_snapshot_expired")) {
    return `This timeline snapshot has expired. Refresh the timeline to load ${subject} evidence.`;
  }
  if (reason === "flame_database_timeout") {
    return `${subject[0].toUpperCase()}${subject.slice(1)} evidence took too long to load. Try again.`;
  }
  if (reason === "flame_evidence_mismatch") {
    return `${subject[0].toUpperCase()}${subject.slice(1)} evidence did not match this timeline snapshot. Refresh the timeline and try again.`;
  }
  if (reason?.endsWith("_request_not_found")) {
    return `This ${subject} is no longer present in the selected snapshot.`;
  }
  return `${subject[0].toUpperCase()}${subject.slice(1)} evidence is temporarily unavailable. Try again.`;
}

function evidenceFailureReason(error) {
  if (error?.apiCode) return error.apiCode;
  return error?.name === "FlameDataError" || /does not match|overlap|out of order/.test(error?.message)
    ? "flame_evidence_mismatch"
    : "flame_database_unavailable";
}

function needsTimelineRefresh(reason) {
  return reason?.endsWith("_snapshot_expired") || reason?.endsWith("_request_not_found") ||
    reason === "flame_evidence_mismatch";
}

export function formatActiveTime(seconds) {
  if (seconds === 0) return "0m active";
  if (seconds < 60) return "<1m active";

  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) return `${minutes}m active`;
  if (remainingMinutes === 0) return `${hours}h active`;
  return `${hours}h ${remainingMinutes}m active`;
}

function formatWindowDuration(windowMinutes) {
  if (windowMinutes % 60 === 0) {
    const hours = windowMinutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${windowMinutes} minutes`;
}

function describeActiveTime(seconds, windowMinutes) {
  const windowLabel = formatWindowDuration(windowMinutes);
  if (seconds === 0) return `0 minutes active in the last ${windowLabel}`;
  if (seconds < 60) return `Less than 1 minute active in the last ${windowLabel}`;

  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (remainingMinutes > 0) {
    parts.push(`${remainingMinutes} ${remainingMinutes === 1 ? "minute" : "minutes"}`);
  }
  return `${parts.join(" ")} active in the last ${windowLabel}`;
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
  const right = anchor.x - TOOLTIP_ARROW_CENTER_OFFSET;
  const left = anchor.x - tooltip.width + TOOLTIP_ARROW_CENTER_OFFSET;
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

export function getBucketCenterX(index, chartWidth, bucketCount = BUCKET_COUNT) {
  const boundedIndex = clamp(index, 0, bucketCount - 1);
  return ((boundedIndex + 0.5) / bucketCount) * chartWidth;
}

export function BucketTooltip({ active, bucketCount = BUCKET_COUNT, laneRef, payload, personName }) {
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
  const hasAnchor = laneBox && Number.isInteger(point.index) && laneBox.width > 0;
  const placement = hasAnchor && typeof window !== "undefined"
    ? getBucketTooltipPlacement({
        anchor: {
          x: laneBox.left + getBucketCenterX(point.index, laneBox.width, bucketCount),
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

export function BucketCursor({
  bucketCount = BUCKET_COUNT,
  payloadIndex,
  left,
  top,
  width,
  height,
}) {
  const index = Number(payloadIndex);
  if (
    payloadIndex == null
    || !Number.isInteger(index)
    || !Number.isFinite(left)
    || !Number.isFinite(top)
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
  ) {
    return null;
  }

  const x = left + getBucketCenterX(index, width, bucketCount);
  return (
    <line
      className="flame-bucket-hover"
      x1={x}
      x2={x}
      y1={top}
      y2={top + height}
      aria-hidden="true"
      pointerEvents="none"
      vectorEffect="non-scaling-stroke"
    />
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

function roleLabel(role) {
  return role === "agent" ? "Agent" : role === "subagent" ? "Subagent" : "Unclassified";
}

function EvidenceLimits() {
  return (
    <details className="flame-detail__disclosure">
      <summary>Evidence limits</summary>
      <div>
        <p>Times mark the first and last observed source events, not continuous activity.</p>
        <p>Truncated means Sherlock is showing only the stored database excerpt (up to 1,024 UTF-8 bytes), not the full source content.</p>
        <p>File-touch evidence is unavailable because tool payloads are not canonical fields.</p>
      </div>
    </details>
  );
}

function DrawerCloseButton({ closing, onClose }) {
  return (
    <button
      type="button"
      className="flame-detail__close"
      disabled={closing}
      onClick={onClose}
    >
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
        <path d="M6 6 18 18M18 6 6 18" />
      </svg>
      <span className="visually-hidden">Close interval details</span>
    </button>
  );
}

function IntervalOverview({
  person,
  point,
  onClose,
  evidence,
  onRetry,
  onRefresh,
  onOpenWork,
  showAdditionalWork,
  onToggleAdditionalWork,
  stale,
  closing,
}) {
  const headingId = `flame-detail-${person.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const promptedWork = evidence.work.filter(({ summary }) => summary !== null);
  const additionalWork = evidence.work.filter(({ summary }) => summary === null);
  const visibleWork = showAdditionalWork
    ? [...promptedWork, ...additionalWork]
    : promptedWork;

  function workRow(work) {
    const label = work.summary ?? `${roleLabel(work.role)} session`;
    const contents = (
      <>
        <i className={`flame-key flame-key--${work.role}`} aria-hidden="true" />
        <span className="flame-detail__work-copy">
          <strong className={work.summary ? undefined : "flame-detail__work-generic"}>{label}</strong>
          <span>
            <b>{roleLabel(work.role)}</b>
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(work.firstAtMs).toISOString()}>{formatTime(work.firstAtMs)}</time>
            <span aria-hidden="true">–</span>
            <time dateTime={new Date(work.lastAtMs).toISOString()}>{formatTime(work.lastAtMs)}</time>
            <span aria-hidden="true">·</span>
            <small>{work.eventCount} {work.eventCount === 1 ? "event" : "events"}</small>
          </span>
        </span>
        <span className="flame-detail__chevron" aria-hidden="true">›</span>
      </>
    );
    return (
      <li key={work.id}>
        <button type="button" onClick={() => onOpenWork(work)}>{contents}</button>
      </li>
    );
  }

  return (
    <div className="flame-detail__view" data-view="overview">
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
            {formatSessionCount(point.activity)}
            <span aria-hidden="true"> · </span>
            {formatPromptCount(point.prompts)}
          </p>
          {stale && <p className="flame-detail__stale">Showing the last successful timeline read.</p>}
        </div>
        <DrawerCloseButton closing={closing} onClose={onClose} />
      </header>

      {evidence.state === "loading" ? (
        <p className="flame-detail__state" role="status">Loading frame evidence…</p>
      ) : evidence.state === "error" ? (
        <div className="flame-detail__state flame-detail__error" role="alert">
          <p>{evidenceErrorCopy("frame", evidence.reason)}</p>
          <button
            type="button"
            onClick={needsTimelineRefresh(evidence.reason) ? onRefresh : onRetry}
          >
            {needsTimelineRefresh(evidence.reason) ? "Refresh timeline" : "Retry"}
          </button>
        </div>
      ) : evidence.state === "ready" && (
        <div className="flame-detail__body">
          {evidence.prompts.length > 0 && (
            <details className="flame-detail__prompts">
              <summary>{evidence.prompts.length} human {evidence.prompts.length === 1 ? "prompt" : "prompts"}</summary>
              <ol>
                {evidence.prompts.map((prompt) => (
                  <li key={prompt.id}>
                    <header>
                      <strong>Submitted prompt</strong>
                      <time dateTime={new Date(prompt.atMs).toISOString()}>{formatTime(prompt.atMs)}</time>
                      {prompt.truncated && <span>Excerpt</span>}
                    </header>
                    <p>{prompt.content || "Stored prompt excerpt was empty."}</p>
                  </li>
                ))}
              </ol>
            </details>
          )}
          <section className="flame-detail__section" aria-labelledby={`${headingId}-work`}>
            <h3 id={`${headingId}-work`}>Active work</h3>
            {evidence.workIncomplete && (
              <p className="flame-detail__partial" role="status">
                Some session-role evidence changed after this timeline snapshot and is omitted
                until the next timeline refresh.
              </p>
            )}
            {evidence.work.length === 0 ? (
              <p className="flame-detail__empty">No work-session evidence observed in this interval.</p>
            ) : (
              <>
                {visibleWork.length > 0 && (
                  <ul className="flame-detail__work">{visibleWork.map(workRow)}</ul>
                )}
                {additionalWork.length > 0 && (
                  <button
                    type="button"
                    className="flame-detail__work-expander"
                    aria-expanded={showAdditionalWork}
                    onClick={onToggleAdditionalWork}
                  >
                    {showAdditionalWork ? "Hide" : "Show"} {additionalWork.length} more {additionalWork.length === 1 ? "session" : "sessions"}
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function WorkDetail({
  work,
  evidence,
  onBack,
  onClose,
  onRetry,
  onRefresh,
  onLoadMore,
  stale,
  closing,
}) {
  const headingId = `flame-work-${work.workId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <div className="flame-detail__view" data-view="work">
      <header className="flame-detail__header flame-detail__header--work">
        <button type="button" className="flame-detail__back" onClick={onBack}>
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
            <path d="m15 18-6-6 6-6" />
          </svg>
          <span>Back to frame</span>
        </button>
        <DrawerCloseButton closing={closing} onClose={onClose} />
      </header>
      <div className="flame-detail__work-heading">
        <p className="flame-detail__eyebrow">Session evidence</p>
        <h2 id={headingId}>{roleLabel(work.role)} session</h2>
        <p>
          <time dateTime={new Date(work.firstAtMs).toISOString()}>{formatTime(work.firstAtMs)}</time>
          <span aria-hidden="true">–</span>
          <time dateTime={new Date(work.lastAtMs).toISOString()}>{formatTime(work.lastAtMs)}</time>
          <span aria-hidden="true"> · </span>
          {work.eventCount} observed {work.eventCount === 1 ? "event" : "events"}
        </p>
        {stale && <p className="flame-detail__stale">Showing the last successful timeline read.</p>}
      </div>

      {evidence.state === "loading" ? (
        <p className="flame-detail__state" role="status">Loading session evidence…</p>
      ) : evidence.state === "error" ? (
        <div className="flame-detail__state flame-detail__error" role="alert">
          <p>{evidenceErrorCopy("session", evidence.reason)}</p>
          <button
            type="button"
            onClick={needsTimelineRefresh(evidence.reason) ? onRefresh : onRetry}
          >
            {needsTimelineRefresh(evidence.reason) ? "Refresh timeline" : "Retry"}
          </button>
        </div>
      ) : evidence.state === "ready" && (
        <div className="flame-detail__body">
          <section className="flame-detail__section" aria-labelledby={`${headingId}-conversation`}>
            <h3 id={`${headingId}-conversation`}>Conversation</h3>
            {evidence.items.length === 0 ? (
              <p className="flame-detail__empty">No stored conversation turns were observed for this work row.</p>
            ) : (
              <ol className="flame-detail__items">
                {evidence.items.map((item) => (
                  <li key={item.id} data-role={item.role}>
                    <header>
                      <strong>{item.role}</strong>
                      <time dateTime={new Date(item.atMs).toISOString()}>{formatTime(item.atMs)}</time>
                      {item.truncated && <span>Truncated</span>}
                    </header>
                    <p>{item.content || "Stored event content was empty."}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
          {evidence.nextCursor && !evidence.moreError && (
            <button
              type="button"
              className="flame-detail__more flame-detail__more--session"
              onClick={onLoadMore}
              disabled={evidence.loadingMore}
            >
              {evidence.loadingMore ? "Loading more…" : "Load more session evidence"}
            </button>
          )}
          {evidence.moreError && (
            <div className="flame-detail__more-error flame-detail__more-error--session" role="alert">
              <p>{evidenceErrorCopy("session", evidence.moreError)}</p>
              <button
                type="button"
                className="flame-detail__more"
                onClick={needsTimelineRefresh(evidence.moreError) ? onRefresh : onLoadMore}
              >
                {needsTimelineRefresh(evidence.moreError) ? "Refresh timeline" : "Retry"}
              </button>
            </div>
          )}
          <EvidenceLimits />
        </div>
      )}
    </div>
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

function PersonRail({ person, headingId, readMs, windowMinutes }) {
  const status = getPersonActivityStatus(person, readMs);
  const { label, description } = ACTIVITY_STATUS[status];

  return (
    <header className="flame-person-rail">
      <div className="flame-person-copy">
        <div className="flame-person-heading">
          <h2 id={headingId} title={person.name}>{person.name}</h2>
          <span
            className={`flame-person-status flame-person-status--${status}`}
            role="img"
            aria-label={`${person.name}: ${label}; ${description}`}
            title={`${label} — ${description}`}
          />
        </div>
        <p
          className="flame-person-active-time"
          aria-label={describeActiveTime(person.activeSeconds, windowMinutes)}
          title={describeActiveTime(person.activeSeconds, windowMinutes)}
        >
          {formatActiveTime(person.activeSeconds)}
        </p>
      </div>
    </header>
  );
}

const PersonLane = memo(function PersonLane({
  person,
  peak,
  promptPeak,
  chartWidth,
  selectedIndex,
  onSelect,
  readMs,
  tooltipActive,
  onTooltipActivate,
  onTooltipDeactivate,
  windowMinutes,
}) {
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
    onSelect(person, point);
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
      event.preventDefault();
      setKeyboardIndex((index) => Math.min(points.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setKeyboardIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setKeyboardIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setKeyboardIndex(points.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      select(points[keyboardIndex]);
    }
  };

  const handleBlur = (event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      onTooltipDeactivate(person.id);
    }
  };

  return (
    <section
      className="flame-person"
      aria-labelledby={headingId}
      data-selected={selectedIndex === undefined ? undefined : "true"}
    >
      <PersonRail
        person={person}
        headingId={headingId}
        readMs={readMs}
        windowMinutes={windowMinutes}
      />
      <div
        ref={laneRef}
        className="flame-lane"
        style={{ width: chartWidth }}
        role="group"
        aria-label={`${person.name} activity timeline, ${points.length} ten-minute buckets`}
        data-bucket-count={points.length}
        data-selected-index={selectedIndex}
        onClick={handleClick}
        onMouseEnter={() => onTooltipActivate(person.id)}
        onMouseLeave={() => onTooltipDeactivate(person.id)}
        onFocusCapture={() => onTooltipActivate(person.id)}
        onBlurCapture={handleBlur}
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
            active={tooltipActive ? undefined : false}
            content={(
              <BucketTooltip
                bucketCount={points.length}
                laneRef={laneRef}
                personName={person.name}
              />
            )}
            cursor={<BucketCursor bucketCount={points.length} />}
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
});

export function getAvailableChartWidth(scrollportClientWidth, railWidth) {
  return Math.max(1, scrollportClientWidth - railWidth);
}

function useSharedChartWidth(scrollportRef, requestedWidth) {
  const [measuredWidth, setMeasuredWidth] = useState(requestedWidth ?? 1);

  useLayoutEffect(() => {
    if (Number.isFinite(requestedWidth)) {
      setMeasuredWidth(requestedWidth);
      return undefined;
    }

    const scrollport = scrollportRef.current;
    if (!scrollport || typeof ResizeObserver === "undefined") return undefined;

    const update = () => {
      const rail = Number.parseFloat(
        getComputedStyle(scrollport).getPropertyValue("--flame-rail"),
      ) || 260;
      setMeasuredWidth(getAvailableChartWidth(scrollport.clientWidth, rail));
    };
    const observer = new ResizeObserver(update);
    observer.observe(scrollport);
    update();
    return () => observer.disconnect();
  }, [requestedWidth, scrollportRef]);

  return Math.max(1, measuredWidth);
}

export default function FlameGraph({
  data,
  chartWidth,
  stale = false,
  onRefresh,
  rankBy = DEFAULT_PERSON_RANK,
  timelineMeta,
}) {
  const peopleScrollRef = useRef(null);
  const detailRef = useRef(null);
  const detailClosingRef = useRef(false);
  const workRequestRef = useRef(null);
  const [selection, setSelection] = useState(null);
  const [activeTooltipPersonId, setActiveTooltipPersonId] = useState(null);
  const [detailClosing, setDetailClosing] = useState(false);
  const [drawerView, setDrawerView] = useState({ screen: "overview" });
  const [showAdditionalWork, setShowAdditionalWork] = useState(false);
  const [intervalRevision, setIntervalRevision] = useState(0);
  const [workRevision, setWorkRevision] = useState(0);
  const [intervalEvidence, setIntervalEvidence] = useState({
    state: "idle", work: [], prompts: [], workIncomplete: false,
  });
  const [workEvidence, setWorkEvidence] = useState({
    state: "idle", items: [], nextCursor: null,
  });
  const width = useSharedChartWidth(peopleScrollRef, chartWidth);
  const peak = Math.max(1, data.globalPeak ?? getGlobalPeak(data.people));
  const promptPeak = data.people.reduce(
    (peoplePeak, person) => person.buckets.reduce(
      (personPeak, { prompts }) => Math.max(personPeak, prompts),
      peoplePeak,
    ),
    1,
  );
  const bucketCount = data.bucketCount ?? data.people[0]?.buckets.length ?? BUCKET_COUNT;
  const windowMinutes = data.windowMinutes ?? bucketCount * BUCKET_MS / (60 * 1000);
  const windowLabel = formatWindowDuration(windowMinutes);
  const ticks = data.axisTicks ?? createTimeAxisTicks(data.startMs, bucketCount);
  const endMs = data.startMs + bucketCount * BUCKET_MS;
  const rankedPeople = useMemo(
    () => rankPeople(data.people, rankBy),
    [data.people, rankBy],
  );
  const selectedPerson = selection
    ? data.people.find(({ id }) => id === selection.personId)
    : null;
  const selectedPoint = selectedPerson
    ? selectedPerson.buckets.find(({ startMs }) => startMs === selection.startMs)
    : null;
  const selectionKey = selectedPerson && selectedPoint
    ? `${selectedPerson.id}:${selectedPoint.startMs}`
    : null;

  const beginCloseDetail = useCallback(() => {
    if (!selection || detailClosingRef.current) return;
    detailClosingRef.current = true;
    workRequestRef.current?.abort();
    setDetailClosing(true);
  }, [selection]);

  const finalizeCloseDetail = useCallback(() => {
    if (!detailClosingRef.current) return;
    detailClosingRef.current = false;
    setDetailClosing(false);
    setSelection(null);
    setDrawerView({ screen: "overview" });
    requestAnimationFrame(() => peopleScrollRef.current?.focus());
  }, []);

  const handleDetailAnimationEnd = (event) => {
    if (event.target === event.currentTarget) finalizeCloseDetail();
  };

  useEffect(() => {
    if (selection && (!selectedPerson || !selectedPoint)) {
      detailClosingRef.current = false;
      workRequestRef.current?.abort();
      setDetailClosing(false);
      setDrawerView({ screen: "overview" });
      setSelection(null);
    }
  }, [selection, selectedPerson, selectedPoint]);

  useEffect(() => {
    if (!selectedPoint) return undefined;
    detailRef.current?.focus();
    const closeOnEscape = (event) => {
      if (event.key === "Escape") beginCloseDetail();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [beginCloseDetail, selectionKey]);

  useEffect(() => {
    if (!selectedPerson || !selectedPoint) {
      setIntervalEvidence({
        state: "idle", work: [], prompts: [], workIncomplete: false,
      });
      return undefined;
    }

    const controller = new AbortController();
    setIntervalEvidence({
      state: "loading", work: [], prompts: [], workIncomplete: false,
    });
    const query = new URLSearchParams({
      personId: selectedPerson.id,
      start: new Date(selectedPoint.startMs).toISOString(),
      snapshot: data.snapshot,
    });
    fetch(`/api/flame/interval?${query}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw await apiFailure(response, `flame_interval_http_${response.status}`);
        return response.json();
      })
      .then((value) => {
        if (controller.signal.aborted) return;
        const evidence = adaptIntervalEvidence(value, {
          personId: selectedPerson.id,
          startMs: selectedPoint.startMs,
          snapshot: data.snapshot,
          promptCount: selectedPoint.prompts,
        });
        if (evidence.work.length > selectedPoint.activity) {
          throw new Error("Work evidence count does not match the timeline snapshot");
        }
        setIntervalEvidence({
          state: "ready",
          ...evidence,
          workIncomplete: evidence.work.length < selectedPoint.activity,
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setIntervalEvidence({
            state: "error", work: [], prompts: [], workIncomplete: false,
            reason: evidenceFailureReason(error),
          });
        }
      });
    return () => controller.abort();
  }, [data.snapshot, intervalRevision, selectedPerson?.id, selectedPoint?.startMs]);

  useEffect(() => {
    if (!selectedPerson || !selectedPoint || drawerView.screen !== "work") {
      workRequestRef.current?.abort();
      setWorkEvidence({ state: "idle", items: [], nextCursor: null });
      return undefined;
    }

    const controller = new AbortController();
    workRequestRef.current?.abort();
    workRequestRef.current = controller;
    setWorkEvidence({ state: "loading", items: [], nextCursor: null });
    const query = new URLSearchParams({
      personId: selectedPerson.id,
      start: new Date(selectedPoint.startMs).toISOString(),
      snapshot: data.snapshot,
      sessionId: drawerView.sessionId,
      role: drawerView.role,
    });
    fetch(`/api/flame/work?${query}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw await apiFailure(response, `flame_work_http_${response.status}`);
        return response.json();
      })
      .then((value) => {
        if (controller.signal.aborted) return;
        const evidence = adaptWorkEvidence(value, {
          personId: selectedPerson.id,
          startMs: selectedPoint.startMs,
          snapshot: data.snapshot,
          workId: drawerView.workId,
          sessionId: drawerView.sessionId,
          role: drawerView.role,
        });
        setWorkEvidence({ state: "ready", ...evidence, loadingMore: false, moreError: false });
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setWorkEvidence({
            state: "error", items: [], nextCursor: null,
            reason: evidenceFailureReason(error),
          });
        }
      });
    return () => controller.abort();
  }, [
    data.snapshot,
    drawerView.role,
    drawerView.screen,
    drawerView.sessionId,
    drawerView.workId,
    selectedPerson?.id,
    selectedPoint?.startMs,
    workRevision,
  ]);

  const selectInterval = useCallback((person, point) => {
    detailClosingRef.current = false;
    setDetailClosing(false);
    setShowAdditionalWork(false);
    setDrawerView({ screen: "overview" });
    setSelection({ personId: person.id, startMs: point.startMs });
  }, []);

  const deactivateTooltip = useCallback((personId) => {
    setActiveTooltipPersonId((activePersonId) => (
      activePersonId === personId ? null : activePersonId
    ));
  }, []);

  const openWork = (work) => {
    setDrawerView({
      screen: "work",
      workId: work.id,
      sessionId: work.sessionId,
      role: work.role,
      firstAtMs: work.firstAtMs,
      lastAtMs: work.lastAtMs,
      eventCount: work.eventCount,
    });
  };

  const backToOverview = () => {
    setDrawerView({ screen: "overview" });
  };

  const refreshIntervalTimeline = () => {
    if (onRefresh) onRefresh();
    else setIntervalRevision((revision) => revision + 1);
  };

  const refreshWorkTimeline = () => {
    const reason = workEvidence.reason || workEvidence.moreError;
    if (reason?.endsWith("_request_not_found")) backToOverview();
    if (onRefresh) onRefresh();
    else setWorkRevision((revision) => revision + 1);
  };

  const loadMoreWork = async () => {
    if (drawerView.screen !== "work" || workEvidence.state !== "ready" ||
        !workEvidence.nextCursor || workEvidence.loadingMore || !selectedPerson || !selectedPoint) return;
    const controller = new AbortController();
    workRequestRef.current?.abort();
    workRequestRef.current = controller;
    setWorkEvidence((current) => ({ ...current, loadingMore: true, moreError: false }));
    const query = new URLSearchParams({
      personId: selectedPerson.id,
      start: new Date(selectedPoint.startMs).toISOString(),
      snapshot: data.snapshot,
      sessionId: drawerView.sessionId,
      role: drawerView.role,
      cursor: workEvidence.nextCursor,
    });
    try {
      const response = await fetch(`/api/flame/work?${query}`, {
        headers: { Accept: "application/json" }, cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw await apiFailure(response, `flame_work_http_${response.status}`);
      const page = adaptWorkEvidence(await response.json(), {
        personId: selectedPerson.id,
        startMs: selectedPoint.startMs,
        snapshot: data.snapshot,
        workId: drawerView.workId,
        sessionId: drawerView.sessionId,
        role: drawerView.role,
      });
      const existingIds = new Set(workEvidence.items.map(({ id }) => id));
      if (page.items.some(({ id }) => existingIds.has(id)) ||
          (page.items[0] && workEvidence.items.at(-1) &&
            page.items[0].atMs < workEvidence.items.at(-1).atMs)) {
        throw new Error("Work evidence pages overlap or are out of order");
      }
      setWorkEvidence((current) => ({
        ...current,
        items: [...current.items, ...page.items],
        nextCursor: page.nextCursor,
        loadingMore: false,
        moreError: false,
      }));
    } catch (error) {
      if (!controller.signal.aborted) {
        setWorkEvidence((current) => ({
          ...current,
          loadingMore: false,
          moreError: evidenceFailureReason(error),
        }));
      }
    }
  };
  return (
    <section
      className="flame-graph"
      data-state={stale ? "stale" : "current"}
      aria-label={`Code activity over the last ${windowLabel}`}
    >
      <div className="flame-meta-row">
        <div className="flame-meta-rail">{timelineMeta}</div>
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
      <div
        ref={peopleScrollRef}
        className="flame-people-scroll"
        role="region"
        aria-label={`People activity timelines, ${data.people.length} people`}
        tabIndex={0}
      >
        {rankedPeople.map((person) => (
          <PersonLane
            key={person.id}
            person={person}
            peak={peak}
            promptPeak={promptPeak}
            chartWidth={width}
            readMs={data.recencyReadMs ?? data.readMs}
            windowMinutes={windowMinutes}
            selectedIndex={selectedPerson?.id === person.id ? selectedPoint?.index : undefined}
            onSelect={selectInterval}
            tooltipActive={activeTooltipPersonId === person.id}
            onTooltipActivate={setActiveTooltipPersonId}
            onTooltipDeactivate={deactivateTooltip}
          />
        ))}
      </div>
      {selectedPerson && selectedPoint && (
        <aside
          ref={detailRef}
          className={`flame-detail${detailClosing ? " flame-detail--closing" : ""}`}
          aria-busy={drawerView.screen === "work"
            ? workEvidence.state === "loading" || workEvidence.loadingMore === true
            : intervalEvidence.state === "loading"}
          aria-labelledby={drawerView.screen === "work"
            ? `flame-work-${drawerView.workId.replace(/[^a-zA-Z0-9_-]/g, "")}`
            : `flame-detail-${selectedPerson.id.replace(/[^a-zA-Z0-9_-]/g, "")}`}
          onAnimationEnd={handleDetailAnimationEnd}
          tabIndex={-1}
        >
          {drawerView.screen === "work" ? (
            <WorkDetail
              work={drawerView}
              evidence={workEvidence}
              stale={stale}
              closing={detailClosing}
              onBack={backToOverview}
              onClose={beginCloseDetail}
              onRetry={() => setWorkRevision((revision) => revision + 1)}
              onRefresh={refreshWorkTimeline}
              onLoadMore={loadMoreWork}
            />
          ) : (
            <IntervalOverview
              key={`${selectedPerson.id}:${selectedPoint.startMs}`}
              person={selectedPerson}
              point={selectedPoint}
              evidence={intervalEvidence}
              stale={stale}
              closing={detailClosing}
              onClose={beginCloseDetail}
              onRetry={() => setIntervalRevision((revision) => revision + 1)}
              onRefresh={refreshIntervalTimeline}
              onOpenWork={openWork}
              showAdditionalWork={showAdditionalWork}
              onToggleAdditionalWork={() => setShowAdditionalWork((shown) => !shown)}
            />
          )}
        </aside>
      )}
    </section>
  );
}
