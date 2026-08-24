import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  adaptMock,
  adaptFreshnessMock,
  flameGraphRenderMock,
  mergeFreshnessMock,
} = vi.hoisted(() => ({
  adaptMock: vi.fn(),
  adaptFreshnessMock: vi.fn(),
  flameGraphRenderMock: vi.fn(),
  mergeFreshnessMock: vi.fn(),
}));

vi.mock("./flame-data.js", () => ({
  adaptFlamePayload: adaptMock,
  adaptFlameFreshness: adaptFreshnessMock,
  mergeFlameFreshness: mergeFreshnessMock,
  BUCKET_MS: 10 * 60 * 1000,
}));

vi.mock("./FlameGraph.jsx", () => ({
  default: ({ data, rankBy, stale, onRefresh, timelineMeta }) => {
    flameGraphRenderMock();
    return (
      <div data-testid="flame-graph" data-rank-by={rankBy} data-stale={String(stale)}>
        {timelineMeta}
        {data.marker}
        <button type="button" onClick={onRefresh}>Refresh timeline</button>
      </div>
    );
  },
  PERSON_RANK_OPTIONS: [
    { value: "roster", label: "Name" },
    { value: "active-time", label: "Active time" },
    { value: "peak-sessions", label: "Peak sessions" },
    { value: "prompts", label: "Prompts" },
    { value: "subagents", label: "Subagents" },
  ],
  DEFAULT_PERSON_RANK: "active-time",
}));

import App, { expectedTimelineEnd, nextRefreshDelay, timelineFreshness } from "./App.jsx";

const payload = { raw: true };
const model = {
  marker: "adapted timeline",
  startMs: Date.parse("2026-08-13T12:00:00.000Z"),
  readMs: Date.parse("2026-08-14T12:02:00.000Z"),
  coverage: {
    evidence: "observed_events",
    state: "partial",
    reason: "event_presence_not_continuous_attention",
  },
};
const freshnessModel = { delayed: false, people: [], readMs: model.readMs };

function response({ ok = true, status = 200, body = payload } = {}) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function routedFetch(timelineResponses) {
  const queue = [...timelineResponses];
  return vi.fn((url) => Promise.resolve(
    url.startsWith("/api/flame/freshness")
      ? response({ body: { freshness: true } })
      : (queue.shift() ?? response()),
  ));
}

function timelineCalls(mock) {
  return mock.mock.calls.filter(([url]) => !url.startsWith("/api/flame/freshness"));
}

describe("App", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:03:00Z"));
    adaptMock.mockReturnValue(model);
    flameGraphRenderMock.mockClear();
    adaptFreshnessMock.mockReturnValue(freshnessModel);
    mergeFreshnessMock.mockImplementation((timeline) => timeline);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("loads, validates, and renders the flame response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<App />);
    expect(container.querySelector(".portal-header__logo")).toHaveAttribute("src");
    expect(container.querySelector(".portal-header__logo")).toHaveAttribute("alt", "");
    expect(screen.getByText("Bonaparte")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading timeline");
    await settle();

    expect(adaptMock).toHaveBeenCalledWith(payload);
    expect(screen.getByTestId("flame-graph")).toHaveTextContent("adapted timeline");
    expect(screen.getByText(/Through .* · read 1m ago/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/flame", expect.objectContaining({
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: expect.any(AbortSignal),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls the lightweight receipt and shows pipeline delay globally", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    adaptFreshnessMock.mockReturnValue({ ...freshnessModel, delayed: true });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/flame/freshness?refresh=wait",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Live telemetry is delayed. Recent activity may arrive late.",
    );
    expect(screen.getByTestId("flame-graph")).toHaveAttribute("data-stale", "true");
  });

  it("lets detail recovery request a fresh timeline snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Refresh timeline" }));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/flame?refresh=force", expect.objectContaining({
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }));
  });

  it("preserves forced recovery intent after a failed forced refresh", async () => {
    const fetchMock = routedFetch([
      response(),
      response({ ok: false, status: 503 }),
      response(),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Refresh timeline" }));
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("Timeline refresh failed.");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });
    await settle();

    expect(timelineCalls(fetchMock).at(-1)).toEqual([
      "/api/flame?refresh=force",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);
  });

  it("places the ranking selector between recency and role legends", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { container } = render(<App />);
    const header = container.querySelector(".portal-header");
    const legendRegion = within(header).getByLabelText("Timeline legend");
    const activityLegend = within(legendRegion).getByRole("list", { name: "Activity legend" });
    const statusLegend = within(legendRegion).getByRole("list", {
      name: "Activity recency legend",
    });
    const rankSelector = within(legendRegion).getByRole("group", {
      name: "Rank by",
    });

    expect(header.querySelector(".portal-header__brand")).toHaveTextContent("Bonaparte");
    expect(header.querySelector(".portal-header__brand + .portal-header__legend"))
      .toBe(legendRegion);
    expect(statusLegend.parentElement).toHaveClass("flame-legends");
    expect(activityLegend.parentElement).toBe(statusLegend.parentElement);
    expect(statusLegend.nextElementSibling).toBe(rankSelector);
    expect(rankSelector.nextElementSibling).toBe(activityLegend);
    expect(within(rankSelector).getByRole("button", { name: "Active time", pressed: true }))
      .toBeInTheDocument();
    for (const label of ["Agent", "Subagent", "Unclassified", "Prompts"]) {
      expect(within(activityLegend).getByText(label)).toBeInTheDocument();
    }
    expect(within(statusLegend).getByLabelText("Green: activity 10 minutes ago or less"))
      .toHaveTextContent("≤10m");
    expect(within(statusLegend).getByLabelText(
      "Yellow: activity more than 10 and up to 30 minutes ago",
    )).toHaveTextContent(">10m–≤30m");
    expect(within(statusLegend).getByLabelText(
      "Red: activity more than 30 minutes ago or no activity",
    )).toHaveTextContent(">30m / none");
  });

  it("updates the graph ranking from the inline selector", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    render(<App />);
    await settle();

    expect(screen.getByTestId("flame-graph")).toHaveAttribute("data-rank-by", "active-time");
    fireEvent.click(screen.getByRole("button", { name: "Peak sessions" }));
    expect(screen.getByTestId("flame-graph")).toHaveAttribute(
      "data-rank-by",
      "peak-sessions",
    );
    expect(screen.getByRole("button", { name: "Peak sessions", pressed: true }))
      .toBeInTheDocument();
  });

  it("offers an immediate retry after the initial request fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: false, status: 503 }))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Timeline unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByTestId("flame-graph")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains the last-good graph and announces a failed refresh", async () => {
    const fetchMock = routedFetch([
      response(),
      response({ ok: false, status: 503 }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(nextRefreshDelay(Date.now()));
    });
    await settle();

    expect(timelineCalls(fetchMock).at(-1)).toEqual([
      "/api/flame?refresh=wait",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);

    expect(screen.getByText(/Refresh failed\. Through/)).toBeInTheDocument();
    expect(screen.getByTestId("flame-graph")).toHaveAttribute("data-stale", "true");
    expect(screen.getByTestId("flame-graph")).toHaveTextContent("adapted timeline");
  });

  it("announces a delayed refresh immediately between minute ticks", async () => {
    const fetchMock = routedFetch([response(), response()]);
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(nextRefreshDelay(Date.now()));
    });
    await settle();

    expect(timelineCalls(fetchMock)).toHaveLength(2);
    expect(screen.getByText(/Update delayed\. Through/)).toBeInTheDocument();
    expect(screen.getByTestId("flame-graph")).toHaveAttribute("data-stale", "true");
  });

  it("keeps partial coverage chrome out of the visible timeline", async () => {
    adaptMock.mockReturnValue({
      marker: "partial timeline",
      startMs: model.startMs,
      readMs: model.readMs,
      coverage: {
        evidence: "observed_events",
        state: "partial",
        reason: "event_presence_not_continuous_attention",
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));

    render(<App />);
    await settle();

    expect(screen.getByText("Bonaparte")).toBeInTheDocument();
    expect(screen.queryByText(/Observed event evidence/)).not.toBeInTheDocument();
    expect(screen.getByTestId("flame-graph")).toHaveTextContent("partial timeline");
  });

  it("clears the stale state after a later refresh succeeds", async () => {
    adaptMock
      .mockReturnValueOnce(model)
      .mockReturnValueOnce({
        ...model,
        startMs: Date.parse("2026-08-13T12:10:00.000Z"),
        readMs: Date.parse("2026-08-14T12:11:31.000Z"),
      });
    const fetchMock = routedFetch([
      response(),
      response({ ok: false, status: 503 }),
      response(),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(nextRefreshDelay(Date.now()));
    });
    await settle();
    expect(screen.getByTestId("flame-graph")).toHaveAttribute("data-stale", "true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });
    await settle();

    expect(screen.queryByText(/Refresh failed/)).not.toBeInTheDocument();
    expect(screen.getByTestId("flame-graph")).toHaveAttribute("data-stale", "false");
    expect(timelineCalls(fetchMock)).toHaveLength(3);
  });

  it("updates the visible read age without refetching or rerendering the graph", async () => {
    const fetchMock = routedFetch([response()]);
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await settle();
    expect(screen.getByText(/read 1m ago/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await settle();
    const graphRenders = flameGraphRenderMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59 * 1000);
    });

    expect(screen.getByText(/read 2m ago/)).toBeInTheDocument();
    expect(timelineCalls(fetchMock)).toHaveLength(1);
    expect(flameGraphRenderMock).toHaveBeenCalledTimes(graphRenders);
  });

  it("aborts an in-flight request on unmount", () => {
    let requestSignal;
    vi.stubGlobal("fetch", vi.fn((_url, options) => {
      requestSignal = options.signal;
      return new Promise(() => {});
    }));

    const view = render(<App />);
    expect(requestSignal.aborted).toBe(false);
    view.unmount();
    expect(requestSignal.aborted).toBe(true);
  });
});

describe("nextRefreshDelay", () => {
  it("targets ninety seconds after the next ten-minute boundary", () => {
    const now = Date.parse("2026-08-14T12:03:00Z");
    expect(nextRefreshDelay(now)).toBe(8.5 * 60 * 1000);
  });

  it("uses the current boundary grace when the process starts just after a boundary", () => {
    const now = Date.parse("2026-08-14T12:10:30Z");
    expect(nextRefreshDelay(now)).toBe(60 * 1000);
  });
});

describe("timelineFreshness", () => {
  it("allows the normalization grace before marking the latest bucket delayed", () => {
    const now = Date.parse("2026-08-14T12:10:30Z");
    expect(expectedTimelineEnd(now)).toBe(Date.parse("2026-08-14T12:00:00Z"));
    expect(timelineFreshness({
      startMs: Date.parse("2026-08-13T12:00:00Z"),
      readMs: Date.parse("2026-08-14T12:01:30Z"),
    }, now).delayed).toBe(false);
  });

  it("marks the prior bucket delayed after the grace period", () => {
    expect(timelineFreshness({
      startMs: Date.parse("2026-08-13T12:00:00Z"),
      readMs: Date.parse("2026-08-14T12:00:01Z"),
    }, Date.parse("2026-08-14T12:11:31Z"))).toMatchObject({
      delayed: true,
      label: expect.stringContaining("read 11m ago"),
    });
  });
});
