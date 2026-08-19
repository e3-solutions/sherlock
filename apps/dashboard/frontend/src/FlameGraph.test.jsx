import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import FlameGraph, {
  BucketCursor,
  BucketTooltip,
  getAvailableChartWidth,
  getBucketCenterX,
  getBucketTooltipPlacement,
  formatActiveTime,
} from "./FlameGraph.jsx";
import { adaptFlamePayload, BUCKET_COUNT } from "./flame-data.js";

function emptyBuckets() {
  return Array.from({ length: BUCKET_COUNT }, () => [0, 0, 0, 0]);
}

function model() {
  const adaBuckets = emptyBuckets();
  adaBuckets[0] = [2, 1, 1, 3];
  adaBuckets[72] = [0, 0, 0, 2];
  adaBuckets[143] = [1, 0, 0, 0];

  return {
    ...adaptFlamePayload({
    start: "2026-08-14T07:00:00.000Z",
    read: "2026-08-15T07:01:00.000Z",
    snapshot: "v1.snapshot-token",
    latest: "2026-08-15T06:50:00.000Z",
    coverage: {
      evidence: "observed_events",
      state: "partial",
      reason: "event_presence_not_continuous_attention",
    },
    people: [
      {
        id: "ada",
        name: "Ada Lovelace",
        activeSeconds: 1_200,
        lastActivity: "2026-08-15T06:56:00.000Z",
        total: [2, 1, 1],
        buckets: adaBuckets,
      },
      {
        id: "zero",
        name: "Zero Activity",
        activeSeconds: 0,
        lastActivity: null,
        total: [0, 0, 0],
        buckets: emptyBuckets(),
      },
    ],
    }),
    intervalEvidenceSplit: true,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("getAvailableChartWidth", () => {
  it("uses scrollbar-adjusted scrollport space beside the person rail", () => {
    expect(getAvailableChartWidth(1_440, 260)).toBe(1_180);
    expect(getAvailableChartWidth(1_425, 260)).toBe(1_165);
    expect(getAvailableChartWidth(320, 164)).toBe(156);
  });

  it("keeps the chart renderable when the rail consumes the measured width", () => {
    expect(getAvailableChartWidth(160, 164)).toBe(1);
  });
});

describe("formatActiveTime", () => {
  it.each([
    [0, "0m active"],
    [1, "<1m active"],
    [59, "<1m active"],
    [60, "1m active"],
    [3_599, "59m active"],
    [3_600, "1h active"],
    [3_660, "1h 1m active"],
    [13_320, "3h 42m active"],
    [86_400, "24h active"],
  ])("formats %i seconds as %s", (seconds, expected) => {
    expect(formatActiveTime(seconds)).toBe(expected);
  });
});

describe("bucket hover geometry", () => {
  it("resolves exact bucket centers across the complete timeline", () => {
    expect(getBucketCenterX(0, 1008)).toBe(3.5);
    expect(getBucketCenterX(72, 1008)).toBe(507.5);
    expect(getBucketCenterX(143, 1008)).toBe(1004.5);
  });

  it("draws the guide through the indexed bucket center", () => {
    const { container } = render(
      <svg>
        <BucketCursor payloadIndex="72" left={0} top={10} width={1008} height={50} />
      </svg>,
    );
    const guide = container.querySelector(".flame-bucket-hover");

    expect(guide).toHaveAttribute("x1", "507.5");
    expect(guide).toHaveAttribute("x2", "507.5");
    expect(guide).toHaveAttribute("y1", "10");
    expect(guide).toHaveAttribute("y2", "60");
  });
});

describe("FlameGraph", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((url) => {
      const request = new URL(url, "http://dashboard.test");
      const start = request.searchParams.get("start");
      const personId = request.searchParams.get("personId");
      const snapshot = request.searchParams.get("snapshot");
      if (request.pathname === "/api/flame/work") {
        const sessionId = request.searchParams.get("sessionId");
        const role = request.searchParams.get("role");
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            personId, start, snapshot, workId: `${sessionId}:${role}`, sessionId, role,
            firstAt: start,
            lastAt: new Date(Date.parse(start) + 3000).toISOString(),
            eventCount: 3,
            items: [
              {
                id: "event-1", at: start, role: "user",
                content: "First exact prompt", truncated: false,
              },
              {
                id: "event-2", at: new Date(Date.parse(start) + 2000).toISOString(),
                role: "assistant", content: "Ready to ship", truncated: true,
              },
            ],
            nextCursor: null,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          personId,
          start,
          snapshot,
          work: [
            {
              id: "session-1:agent", sessionId: "session-1", role: "agent",
              firstAt: start, lastAt: new Date(Date.parse(start) + 3000).toISOString(),
              eventCount: 3, summary: "First exact prompt",
            },
            {
              id: "session-2:subagent", sessionId: "session-2", role: "subagent",
              firstAt: new Date(Date.parse(start) + 4000).toISOString(),
              lastAt: new Date(Date.parse(start) + 5000).toISOString(),
              eventCount: 1, summary: null,
            },
            {
              id: "session-3:agent", sessionId: "session-3", role: "agent",
              firstAt: new Date(Date.parse(start) + 6000).toISOString(),
              lastAt: new Date(Date.parse(start) + 6000).toISOString(),
              eventCount: 1, summary: null,
            },
            {
              id: "session-4:unclassified", sessionId: "session-4", role: "unclassified",
              firstAt: new Date(Date.parse(start) + 7000).toISOString(),
              lastAt: new Date(Date.parse(start) + 7000).toISOString(),
              eventCount: 1, summary: null,
            },
          ],
          prompts: [
            {
              id: "native:prompt-1", sessionId: "session-1", at: start,
              content: "First exact prompt", truncated: false,
            },
            {
              id: "native:prompt-2", sessionId: "session-3",
              at: new Date(Date.parse(start) + 1000).toISOString(),
              content: "Second prompt excerpt", truncated: true,
            },
            {
              id: "native:prompt-3", sessionId: "session-4",
              at: new Date(Date.parse(start) + 2000).toISOString(),
              content: "Repeat the exact request", truncated: false,
            },
          ],
        }),
      });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders every ordered bucket on a shared semantic time axis", () => {
    const { container } = render(
      <FlameGraph
        data={model()}
        chartWidth={1008}
        timelineMeta={<p>Through 12:10 PM · read 2m ago</p>}
      />,
    );

    expect(screen.getByLabelText("Code activity over the last 24 hours")).toBeInTheDocument();
    expect(container.querySelectorAll(".flame-time-axis time")).toHaveLength(13);

    const lanes = container.querySelectorAll(".flame-lane");
    expect(lanes).toHaveLength(2);
    expect([...lanes].map((lane) => lane.dataset.bucketCount)).toEqual(["144", "144"]);
    expect(lanes[0]).toHaveAttribute(
      "aria-label",
      "Ada Lovelace activity timeline, 144 ten-minute buckets",
    );
    expect(lanes[1]).toHaveAttribute(
      "aria-label",
      "Zero Activity activity timeline, 144 ten-minute buckets",
    );

    const axis = container.querySelector(".flame-time-axis");
    const peopleScroll = container.querySelector(".flame-people-scroll");
    expect(peopleScroll).toHaveAttribute("role", "region");
    expect(peopleScroll).toHaveAttribute("aria-label", "People activity timelines, 2 people");
    expect(peopleScroll).toHaveAttribute("tabindex", "0");
    expect(axis.parentElement).toHaveClass("flame-meta-row");
    expect(screen.getByText("Through 12:10 PM · read 2m ago").parentElement)
      .toHaveClass("flame-meta-rail");
    expect(peopleScroll.previousElementSibling).toBe(axis.parentElement);
    expect(peopleScroll).not.toContainElement(axis);
    expect(peopleScroll.querySelectorAll(".flame-person")).toHaveLength(2);
  });

  it("sizes both fixed axis and rows from the scrollbar-adjusted people scrollport", async () => {
    const observations = [];
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback) {
        this.callback = callback;
      }

      observe = (target) => {
        observe(target);
        observations.push({ callback: this.callback, target });
      };
      disconnect = disconnect;
    });

    const { container } = render(<FlameGraph data={model()} />);
    const peopleScroll = container.querySelector(".flame-people-scroll");
    Object.defineProperty(peopleScroll, "clientWidth", {
      configurable: true,
      value: 1_425,
    });

    const peopleObserver = observations.find(({ target }) => target === peopleScroll);
    expect(peopleObserver).toBeDefined();
    act(() => peopleObserver.callback());

    await waitFor(() => {
      expect(container.querySelector(".flame-time-axis")).toHaveStyle({ width: "1165px" });
      for (const lane of container.querySelectorAll(".flame-lane")) {
        expect(lane).toHaveStyle({ width: "1165px" });
      }
    });
    expect(observe).toHaveBeenCalledWith(peopleScroll);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("replaces role totals with accessible read-relative activity dots", () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);

    const active = screen.getByRole("img", {
      name: "Ada Lovelace: Active; activity observed in the last 10 minutes",
    });
    const inactive = screen.getByRole("img", {
      name: "Zero Activity: Inactive; no observed session evidence in the trailing 30 minutes",
    });

    expect(active).toHaveClass("flame-person-status--active");
    expect(active).toHaveAttribute(
      "title",
      expect.stringContaining("last 10 minutes"),
    );
    expect(inactive).toHaveClass("flame-person-status--inactive");
    expect(container.querySelector(".flame-totals")).toBeNull();
    expect(screen.queryByLabelText("Ada Lovelace totals")).not.toBeInTheDocument();
  });

  it("shows each person's compact active time beneath their name", () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const rails = container.querySelectorAll(".flame-person-rail");

    expect(within(rails[0]).getByRole("heading", { name: "Ada Lovelace" }))
      .toBeInTheDocument();
    expect(within(rails[0]).getByLabelText(
      "20 minutes active in the last 24 hours",
    )).toHaveTextContent("20m active");
    expect(within(rails[1]).getByRole("heading", { name: "Zero Activity" }))
      .toBeInTheDocument();
    expect(within(rails[1]).getByLabelText(
      "0 minutes active in the last 24 hours",
    )).toHaveTextContent("0m active");
  });

  it("uses distinct solid role colors", () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);

    expect(screen.queryByText(/24H · 10M/)).not.toBeInTheDocument();
    expect(container.querySelectorAll("pattern")).toHaveLength(0);
    expect(container.querySelector('[fill="var(--flame-subagent)"]')).toBeInTheDocument();
    expect(container.querySelector('[fill="var(--flame-unclassified)"]')).toBeInTheDocument();
    expect(container.querySelectorAll(".flame-prompt-stem")).toHaveLength(2);
  });

  it("renders bucket-aligned prompt stems with globally consistent magnitude", () => {
    const data = model();
    const { container } = render(<FlameGraph data={data} chartWidth={1008} />);

    expect(data.people[0].buckets[72]).toMatchObject({ activity: 0, prompts: 2 });
    expect(data.people[1].buckets.every(({ activity, prompts }) => activity === 0 && prompts === 0)).toBe(true);
    expect(screen.getByRole("heading", { name: "Zero Activity" })).toBeInTheDocument();

    const stems = [...container.querySelectorAll(".flame-prompt-stem")];
    expect(stems).toHaveLength(2);
    expect(stems.map((stem) => stem.dataset.bucketIndex)).toEqual(["0", "72"]);
    expect(stems.map((stem) => stem.dataset.promptCount)).toEqual(["3", "2"]);
    expect(Number(stems[0].dataset.stemLength)).toBeGreaterThan(
      Number(stems[1].dataset.stemLength),
    );
    expect(container.querySelector('.flame-person[aria-labelledby] .flame-prompt-stem[data-bucket-index="143"]')).toBeNull();
  });

  it("exposes prompt counts to screen readers without adding competing tab stops", () => {
    render(<FlameGraph data={model()} chartWidth={1008} />);

    const threePrompts = screen.getByRole("img", { name: /Ada Lovelace.*3 prompts/ });
    const twoPrompts = screen.getByRole("img", { name: /Ada Lovelace.*2 prompts/ });
    const timeline = screen.getByRole("application", {
      name: "Ada Lovelace activity timeline",
    });

    expect(timeline).toHaveAttribute("tabindex", "0");
    expect(threePrompts).not.toHaveAttribute("tabindex");
    expect(twoPrompts).not.toHaveAttribute("tabindex");
    expect(threePrompts.querySelector("title")).toHaveTextContent("3 prompts");
  });

  it("provides exact local interval and counts in tooltip content", () => {
    const point = model().people[0].buckets[0];
    render(
      <BucketTooltip
        active
        personName="Ada Lovelace"
        payload={[{ payload: point }]}
      />,
    );

    const tooltip = screen.getByRole("status");
    expect(tooltip).toHaveTextContent("Ada Lovelace");
    expect(tooltip).toHaveTextContent("4 observed sessions");
    expect(tooltip).toHaveTextContent("Agent 2");
    expect(tooltip).toHaveTextContent("Subagent 1");
    expect(tooltip).toHaveTextContent("Unclassified 1");
    expect(tooltip).toHaveTextContent("Prompts 3");
    expect(tooltip.querySelector("time")).toHaveAttribute(
      "datetime",
      new Date(point.startMs).toISOString(),
    );
  });

  it("anchors the tooltip to the same indexed bucket center as the hover guide", () => {
    vi.stubGlobal("innerWidth", 2_000);
    vi.stubGlobal("innerHeight", 1_000);
    const point = model().people[0].buckets[72];
    const laneRef = {
      current: {
        getBoundingClientRect: () => ({
          bottom: 182,
          height: 82,
          left: 100,
          right: 1108,
          top: 100,
          width: 1008,
          x: 100,
          y: 100,
          toJSON: () => ({}),
        }),
      },
    };
    render(
      <BucketTooltip
        active
        coordinate={{ x: 3.5 }}
        laneRef={laneRef}
        personName="Ada Lovelace"
        payload={[{ payload: point }]}
      />,
    );

    expect(screen.getByRole("status")).toHaveStyle({ left: "590px" });
  });

  it("places the first bucket tooltip inside the top-left viewport edges", () => {
    const placement = getBucketTooltipPlacement({
      anchor: { x: 4, y: 4 },
      tooltip: { width: 180, height: 104 },
      viewport: { width: 320, height: 240 },
    });

    expect(placement).toMatchObject({ horizontal: "right", vertical: "below" });
    expect(placement.left).toBeGreaterThanOrEqual(8);
    expect(placement.top).toBeGreaterThanOrEqual(8);
    expect(placement.left + 180).toBeLessThanOrEqual(312);
    expect(placement.top + 104).toBeLessThanOrEqual(232);
  });

  it("flips the last bucket tooltip inside the bottom-right viewport edges", () => {
    const placement = getBucketTooltipPlacement({
      anchor: { x: 316, y: 236 },
      tooltip: { width: 180, height: 104 },
      viewport: { width: 320, height: 240 },
    });

    expect(placement).toMatchObject({ horizontal: "left", vertical: "above" });
    expect(placement.left).toBeGreaterThanOrEqual(8);
    expect(placement.top).toBeGreaterThanOrEqual(8);
    expect(placement.left + 180).toBeLessThanOrEqual(312);
    expect(placement.top + 104).toBeLessThanOrEqual(232);
  });

  it("exposes the first bucket tooltip on keyboard focus and moves by bucket", async () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const adaChart = container.querySelector('.flame-person [role="application"]');

    fireEvent.focus(adaChart);
    await waitFor(() => {
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("4 observed sessions");
    });

    fireEvent.keyDown(adaChart, { key: "ArrowRight" });
    await waitFor(() => {
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("0 observed sessions");
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("Prompts 0");
    });

    fireEvent.blur(adaChart);
    await waitFor(() => {
      expect(document.querySelector(".flame-tooltip")).not.toBeInTheDocument();
    });
  });

  it("keeps chart navigation keys from scrolling the people roster", () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const roster = screen.getByRole("region", { name: "People activity timelines, 2 people" });
    const chart = container.querySelector('.flame-person [role="application"]');
    roster.scrollTop = 42;

    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      fireEvent(chart, event);
      expect(event.defaultPrevented).toBe(true);
      expect(roster.scrollTop).toBe(42);
    }
  });

  it("keeps pointer hover tied to the first and last bucket payloads", async () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const lane = container.querySelector(".flame-person .flame-lane");
    const wrapper = lane.querySelector(".recharts-wrapper");
    const scroller = container.querySelector(".flame-people-scroll");
    const bounds = {
      bottom: 82,
      height: 82,
      left: 0,
      right: 1008,
      top: 0,
      width: 1008,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(bounds);
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(bounds);
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      ...bounds,
      right: 320,
      width: 320,
    });
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 320 });
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 1008 });
    scroller.scrollLeft = 37;

    fireEvent.mouseEnter(lane);
    fireEvent.mouseMove(wrapper, { clientX: 3, clientY: 34 });
    await waitFor(() => {
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("4 observed sessions");
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("Prompts 3");
    });
    expect(container.querySelector(".flame-bucket-hover")).toHaveAttribute("x1", "3.5");

    fireEvent.mouseMove(wrapper, { clientX: 1005, clientY: 41 });
    await waitFor(() => {
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("1 observed session");
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("Prompts 0");
    });
    expect(container.querySelector(".flame-bucket-hover")).toHaveAttribute("x1", "1004.5");
    expect(scroller.scrollLeft).toBe(37);
  });

  it("keeps only the current lane tooltip open and clears it on exit", async () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const lanes = [...container.querySelectorAll(".flame-lane")];
    const wrappers = lanes.map((lane) => lane.querySelector(".recharts-wrapper"));
    const bounds = {
      bottom: 82,
      height: 82,
      left: 0,
      right: 1008,
      top: 0,
      width: 1008,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };

    for (const lane of lanes) {
      vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(bounds);
    }
    for (const wrapper of wrappers) {
      vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(bounds);
    }

    fireEvent.mouseEnter(lanes[0]);
    fireEvent.mouseMove(wrappers[0], { clientX: 3, clientY: 34 });
    await waitFor(() => {
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("status")).toHaveTextContent("Ada Lovelace");
    });

    fireEvent.mouseLeave(lanes[0]);
    fireEvent.mouseEnter(lanes[1]);
    fireEvent.mouseMove(wrappers[1], { clientX: 3, clientY: 34 });
    await waitFor(() => {
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("status")).toHaveTextContent("Zero Activity");
    });

    fireEvent.mouseLeave(lanes[1]);
    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });

  it("opens observed interval details for the exact clicked bucket", () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const lane = container.querySelector(".flame-person .flame-lane");
    const wrapper = lane.querySelector(".recharts-wrapper");
    const bounds = {
      bottom: 82,
      height: 82,
      left: 0,
      right: 1008,
      top: 0,
      width: 1008,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(bounds);

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });

    const detail = screen.getByRole("complementary", { name: "Ada Lovelace" });
    expect(detail).toHaveTextContent(/Ada Lovelace.*\d{1,2}:\d{2}.*–.*\d{1,2}:\d{2}/);
    expect(detail).toHaveTextContent("4 observed sessions");
    expect(detail).toHaveTextContent("3 prompts");
    expect(detail).toHaveTextContent("Loading frame evidence");
    expect(detail).not.toHaveTextContent("Canonical observed evidence");
    expect(detail).not.toHaveTextContent("Latest API read");
    expect(lane).toHaveAttribute("data-selected-index", "0");
    expect(lane.closest(".flame-person")).toHaveAttribute("data-selected", "true");
    expect(lane.querySelector(".flame-bucket-selected")).not.toBeInTheDocument();
  });

  it("keeps canonical prompt counts while leading the frame with active work", async () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });
    expect(screen.getByText("Loading frame evidence…")).toBeInTheDocument();

    const promptDisclosure = await screen.findByText("3 human prompts");
    const detail = screen.getByRole("complementary", { name: "Ada Lovelace" });
    expect(detail).not.toHaveTextContent("prompts recorded in this interval");
    expect(detail.querySelectorAll(".flame-detail__work li")).toHaveLength(1);
    expect(detail).not.toHaveTextContent("What happened");
    expect(promptDisclosure.closest("details")).not.toHaveAttribute("open");
    expect(detail).not.toHaveTextContent("Stored excerpt");
    expect(detail).toHaveTextContent("Active work");
    fireEvent.click(promptDisclosure);
    expect(promptDisclosure.closest("details")).toHaveAttribute("open");
    expect(screen.getByText("Second prompt excerpt")).toBeInTheDocument();
    expect(screen.getByText("Repeat the exact request")).toBeInTheDocument();
    expect(screen.getByText("Excerpt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /First exact prompt/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Subagent session evidence/ })).not.toBeInTheDocument();
    expect(screen.queryByText("No submitted user message")).not.toBeInTheDocument();

    const workExpander = screen.getByRole("button", { name: "Show 3 more sessions" });
    expect(workExpander).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(workExpander);
    expect(workExpander).toHaveAttribute("aria-expanded", "true");
    expect(detail.querySelectorAll(".flame-detail__work li")).toHaveLength(4);
    expect(screen.getByText("Subagent session")).toBeInTheDocument();
    expect(screen.getByText("Agent session")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/flame/interval/work?"),
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });

  it("starts split evidence concurrently and reveals the validated frame atomically", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    const releaseWork = deferred();
    const releasePrompts = deferred();
    vi.mocked(fetch).mockImplementation((url, options) => {
      const request = new URL(url, "http://dashboard.test");
      if (request.pathname === "/api/flame/interval/work") {
        return releaseWork.promise.then(() => defaultFetch(url, options));
      }
      if (request.pathname === "/api/flame/interval/prompts") {
        return releasePrompts.promise.then(() => defaultFetch(url, options));
      }
      return defaultFetch(url, options);
    });
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(url, "http://dashboard.test").pathname))
      .toEqual(["/api/flame/interval/work", "/api/flame/interval/prompts"]);

    releaseWork.resolve();
    await act(() => Promise.resolve());
    expect(screen.getByText("Loading frame evidence…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /First exact prompt/ })).not.toBeInTheDocument();
    expect(screen.queryByText("3 human prompts")).not.toBeInTheDocument();

    releasePrompts.resolve();
    expect(await screen.findByText("3 human prompts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /First exact prompt/ })).toBeInTheDocument();
  });

  it("falls back once and remembers combined compatibility for later frames", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    let splitRouteMissing = true;
    vi.mocked(fetch).mockImplementation((url, options) => {
      const request = new URL(url, "http://dashboard.test");
      if (request.pathname === "/api/flame/interval/work" && splitRouteMissing) {
        splitRouteMissing = false;
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: "not_found" }),
        });
      }
      return defaultFetch(url, options);
    });
    const { container, rerender } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });

    expect(await screen.findByText("3 human prompts")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(url, "http://dashboard.test").pathname))
      .toEqual([
        "/api/flame/interval/work",
        "/api/flame/interval/prompts",
        "/api/flame/interval",
      ]);

    fireEvent.click(wrapper, { clientX: 508, clientY: 34 });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(new URL(vi.mocked(fetch).mock.calls[3][0], "http://dashboard.test").pathname)
      .toBe("/api/flame/interval");

    const refreshed = model();
    rerender(<FlameGraph data={refreshed} chartWidth={1008} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
    expect(vi.mocked(fetch).mock.calls.slice(4).map(([url]) =>
      new URL(url, "http://dashboard.test").pathname)).toEqual([
      "/api/flame/interval/prompts",
    ]);
  });

  it("uses the combined endpoint immediately when the aggregate capability is absent", async () => {
    const legacy = model();
    legacy.intervalEvidenceSplit = false;
    const { container } = render(<FlameGraph data={legacy} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });

    expect(await screen.findByText("3 human prompts")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(vi.mocked(fetch).mock.calls[0][0], "http://dashboard.test").pathname)
      .toBe("/api/flame/interval");
  });

  it("does not treat an evidence-level 404 as a missing split route", async () => {
    vi.mocked(fetch).mockImplementation((url) => {
      const request = new URL(url, "http://dashboard.test");
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "flame_interval_request_not_found" }),
      });
    });
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });

    expect(await screen.findByRole("button", { name: "Refresh timeline" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(([url]) =>
      new URL(url, "http://dashboard.test").pathname !== "/api/flame/interval"))
      .toBe(true);
  });

  it("keeps successful work visible when prompt evidence fails", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    const refreshedWork = deferred();
    let promptAttempts = 0;
    vi.mocked(fetch).mockImplementation((url, options) => {
      const request = new URL(url, "http://dashboard.test");
      if (request.pathname === "/api/flame/interval/work" &&
          request.searchParams.get("snapshot") === "v1.refreshed-snapshot") {
        return refreshedWork.promise.then(() => defaultFetch(url, options));
      }
      if (request.pathname === "/api/flame/interval/prompts" && promptAttempts++ === 0) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ error: "flame_database_unavailable" }),
        });
      }
      return defaultFetch(url, options);
    });
    const { container, rerender } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });

    expect(await screen.findByRole("button", { name: /First exact prompt/ })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Prompt evidence is temporarily unavailable",
    );
    expect(screen.getByRole("button", { name: /First exact prompt/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("Loading frame evidence…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /First exact prompt/ })).not.toBeInTheDocument();
    expect(await screen.findByText("3 human prompts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /First exact prompt/ })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls.slice(1).every(([url]) =>
      new URL(url, "http://dashboard.test").pathname === "/api/flame/interval/prompts"))
      .toBe(true);

    const refreshed = model();
    refreshed.snapshot = "v1.refreshed-snapshot";
    rerender(<FlameGraph data={refreshed} chartWidth={1008} />);

    expect(screen.queryByRole("button", { name: /First exact prompt/ })).not.toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
    expect(new URL(vi.mocked(fetch).mock.calls[3][0], "http://dashboard.test").pathname)
      .toBe("/api/flame/interval/work");
    expect(new URL(vi.mocked(fetch).mock.calls[4][0], "http://dashboard.test").pathname)
      .toBe("/api/flame/interval/prompts");
    expect(screen.getByText("Loading frame evidence…")).toBeInTheDocument();

    refreshedWork.resolve();
    expect(await screen.findByText("3 human prompts")).toBeInTheDocument();
  });

  it("still loads prompts after an ordinary work failure", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation((url, options) => {
      const request = new URL(url, "http://dashboard.test");
      if (request.pathname === "/api/flame/interval/work") {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ error: "flame_database_unavailable" }),
        });
      }
      return defaultFetch(url, options);
    });
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });

    expect(await screen.findByText("3 human prompts")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Work evidence is temporarily unavailable",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("skips zero-count evidence requests without creating an N+1 path", async () => {
    const counts = model();
    counts.people[0].buckets[72].prompts = 3;
    counts.people[0].buckets[143].activity = 4;
    const { container } = render(<FlameGraph data={counts} chartWidth={1008} />);
    const wrappers = container.querySelectorAll(".flame-person .recharts-wrapper");
    for (const wrapper of wrappers) {
      vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
        bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
        x: 0, y: 0, toJSON: () => ({}),
      });
    }

    fireEvent.click(wrappers[0], { clientX: 508, clientY: 34 });
    expect(await screen.findByText("3 human prompts")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(vi.mocked(fetch).mock.calls[0][0], "http://dashboard.test").pathname)
      .toBe("/api/flame/interval/prompts");

    fireEvent.click(wrappers[0], { clientX: 1004, clientY: 34 });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(new URL(vi.mocked(fetch).mock.calls[1][0], "http://dashboard.test").pathname)
      .toBe("/api/flame/interval/work");

    fireEvent.click(wrappers[1], { clientX: 3, clientY: 34 });
    await act(() => Promise.resolve());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts immediately and never paints stale evidence after frame reselection", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    const firstWork = deferred();
    vi.mocked(fetch).mockImplementation((url, options) => {
      const request = new URL(url, "http://dashboard.test");
      if (request.pathname === "/api/flame/interval/work" && request.searchParams.get("start") ===
          "2026-08-14T07:00:00.000Z") {
        return firstWork.promise.then(() => defaultFetch(url, options));
      }
      return defaultFetch(url, options);
    });
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });
    const firstSignal = vi.mocked(fetch).mock.calls[0][1].signal;
    const chart = screen.getByRole("application", { name: "Ada Lovelace activity timeline" });
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    fireEvent.keyDown(chart, { key: "Enter" });

    expect(firstSignal.aborted).toBe(true);
    expect(screen.queryByText("Loading frame evidence…")).not.toBeInTheDocument();
    firstWork.resolve();
    await act(() => Promise.resolve());
    expect(screen.queryByRole("button", { name: /First exact prompt/ })).not.toBeInTheDocument();
  });

  it("aborts frame evidence as soon as the drawer is closed", () => {
    const pending = deferred();
    vi.mocked(fetch).mockImplementation(() => pending.promise);
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });
    const signal = vi.mocked(fetch).mock.calls[0][1].signal;
    fireEvent.click(screen.getByRole("button", { name: "Close interval details" }));

    expect(signal.aborted).toBe(true);
  });

  it("keeps prompt and stable work evidence visible when mutable role metadata is partial", async () => {
    const partialModel = model();
    partialModel.people[0].buckets[0].activity = 5;
    partialModel.people[0].buckets[0].agent = 3;
    const { container } = render(<FlameGraph data={partialModel} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });

    expect(await screen.findByText(
      /Some session-role evidence changed after this timeline snapshot/,
    )).toHaveAttribute("role", "status");
    expect(screen.getByText("Active work")).toBeInTheDocument();
    expect(screen.queryByText("What happened")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["flame_database_timeout", /evidence took too long to load/],
    ["flame_interval_snapshot_expired", /timeline snapshot has expired/],
    ["flame_database_unavailable", /temporarily unavailable/],
  ])("explains interval failure %s", async (error, copy) => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: error.endsWith("snapshot_expired") ? 410 : 503,
      json: () => Promise.resolve({ error }),
    });
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });

    await waitFor(() => {
      expect(screen.getAllByRole("alert").some((alert) => copy.test(alert.textContent))).toBe(true);
    });
  });

  it("refreshes the timeline instead of retrying an expired interval snapshot", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 410,
      json: () => Promise.resolve({ error: "flame_interval_snapshot_expired" }),
    });
    const onRefresh = vi.fn();
    const { container } = render(
      <FlameGraph data={model()} chartWidth={1008} onRefresh={onRefresh} />,
    );
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });
    fireEvent.click(await screen.findByRole("button", { name: "Refresh timeline" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes the timeline instead of retrying mismatched interval evidence", async () => {
    vi.mocked(fetch).mockImplementation((url) => {
      const request = new URL(url, "http://dashboard.test");
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          personId: request.searchParams.get("personId"),
          start: request.searchParams.get("start"),
          snapshot: request.searchParams.get("snapshot"),
          work: [],
          prompts: [],
        }),
      });
    });
    const onRefresh = vi.fn();
    const { container } = render(
      <FlameGraph data={model()} chartWidth={1008} onRefresh={onRefresh} />,
    );
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });
    fireEvent.click(await screen.findByRole("button", { name: "Refresh timeline" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps prompt text out of busy frame overviews and resets extra sessions by frame", async () => {
    const busyModel = model();
    busyModel.people[0].buckets[0].prompts = 7;
    Object.assign(busyModel.people[0].buckets[1], {
      activity: 4,
      agent: 2,
      subagent: 1,
      unclassified: 1,
      prompts: 7,
    });
    vi.mocked(fetch).mockImplementation((url) => {
      const request = new URL(url, "http://dashboard.test");
      const start = request.searchParams.get("start");
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          personId: request.searchParams.get("personId"),
          start,
          snapshot: request.searchParams.get("snapshot"),
          work: Array.from({ length: 4 }, (_, index) => ({
            id: `session-${index + 1}:agent`,
            sessionId: `session-${index + 1}`,
            role: "agent",
            firstAt: new Date(Date.parse(start) + index).toISOString(),
            lastAt: new Date(Date.parse(start) + index).toISOString(),
            eventCount: 1,
            summary: null,
          })),
          prompts: Array.from({ length: 7 }, (_, index) => ({
            id: `native:prompt-${index + 1}`,
            sessionId: `session-${(index % 4) + 1}`,
            at: new Date(Date.parse(start) + index).toISOString(),
            content: `Prompt ${index + 1}`,
            truncated: false,
          })),
        }),
      });
    });
    const { container } = render(<FlameGraph data={busyModel} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });
    const expander = await screen.findByRole("button", { name: "Show 4 more sessions" });
    expect(screen.getByText("7 human prompts").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText("What happened")).not.toBeInTheDocument();

    fireEvent.click(expander);
    expect(screen.getByRole("button", { name: "Hide 4 more sessions" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getAllByText("Agent session")).toHaveLength(4);

    const chart = screen.getByRole("application", { name: "Ada Lovelace activity timeline" });
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(await screen.findByRole("button", { name: "Show 4 more sessions" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("Agent session")).not.toBeInTheDocument();
  });

  it("drills into a session conversation and returns to the frame", async () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });
    const row = await screen.findByRole("button", { name: /First exact prompt/ });
    fireEvent.click(row);

    expect(screen.getByText("Loading session evidence…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Conversation")).toBeInTheDocument());
    expect(document.querySelector('.flame-detail__items li[data-role="user"]')).toHaveTextContent("user");
    expect(document.querySelector('.flame-detail__items li[data-role="assistant"]')).toHaveTextContent("assistant");
    expect(screen.getAllByText("First exact prompt")).toHaveLength(1);
    expect(screen.queryByText("Prompt in this frame")).not.toBeInTheDocument();
    expect(screen.getByText("Ready to ship")).toBeInTheDocument();
    expect(screen.getByText("Truncated")).toBeInTheDocument();
    expect(screen.getByText(/File-touch evidence is unavailable/)).toBeInTheDocument();
    expect(screen.getByText("Evidence limits").closest("details")).not.toHaveAttribute("open");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/flame\/work\?.*sessionId=session-1.*role=agent/),
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );

    const backButton = screen.getByRole("button", { name: "Back to frame" });
    expect(backButton.querySelector("svg")).toBeInTheDocument();
    fireEvent.click(backButton);
    expect(await screen.findByRole("button", { name: /First exact prompt/ })).toBeInTheDocument();
  });

  it("returns to the refreshed frame when a selected session is no longer present", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation((url, options) => {
      const request = new URL(url, "http://dashboard.test");
      if (request.pathname !== "/api/flame/work") return defaultFetch(url, options);
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "flame_work_request_not_found" }),
      });
    });
    const onRefresh = vi.fn();
    const { container } = render(
      <FlameGraph data={model()} chartWidth={1008} onRefresh={onRefresh} />,
    );
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });
    fireEvent.click(await screen.findByRole("button", { name: /First exact prompt/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This session is no longer present in the selected snapshot.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh timeline" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Active work")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("loads later conversation turns", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation((url, options) => {
      const request = new URL(url, "http://dashboard.test");
      if (request.pathname !== "/api/flame/work") return defaultFetch(url, options);
      const start = request.searchParams.get("start");
      const personId = request.searchParams.get("personId");
      const snapshot = request.searchParams.get("snapshot");
      const sessionId = request.searchParams.get("sessionId");
      const role = request.searchParams.get("role");
      const laterPage = request.searchParams.has("cursor");
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          personId, start, snapshot, workId: `${sessionId}:${role}`, sessionId, role,
          firstAt: start,
          lastAt: new Date(Date.parse(start) + 2000).toISOString(),
          eventCount: 2,
          items: laterPage ? [{
            id: "event-later",
            at: new Date(Date.parse(start) + 2000).toISOString(),
            role: "assistant",
            content: "Later assistant turn",
            truncated: false,
          }] : [{
            id: "event-first",
            at: start,
            role: "user",
            content: "First exact prompt",
            truncated: false,
          }],
          nextCursor: laterPage ? null : "next-page",
        }),
      });
    });

    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });
    fireEvent.click(await screen.findByRole("button", { name: /First exact prompt/ }));
    await screen.findByText("Conversation");
    fireEvent.click(screen.getByRole("button", { name: "Load more session evidence" }));

    expect(await screen.findByText("Later assistant turn")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more session evidence" })).not.toBeInTheDocument();
  });

  it("exposes stale state without replacing the last-good graph", () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} stale />);

    expect(container.querySelector(".flame-graph")).toHaveAttribute("data-state", "stale");
    expect(screen.getByRole("heading", { name: "Ada Lovelace" })).toBeInTheDocument();
  });
});
