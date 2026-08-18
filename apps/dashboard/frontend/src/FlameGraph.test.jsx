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

  return adaptFlamePayload({
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
  });
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
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          personId,
          start,
          snapshot,
          prompts: [
            { id: "p1", at: start, content: "First exact prompt", truncated: false },
            { id: "p2", at: new Date(Date.parse(start) + 1000).toISOString(), content: "Second prompt excerpt", truncated: true },
            { id: "p3", at: new Date(Date.parse(start) + 2000).toISOString(), content: "Third exact prompt", truncated: false },
          ],
        }),
      });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders every ordered bucket on a shared semantic time axis", () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);

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
    expect(detail).toHaveTextContent("4 sessions");
    expect(detail).toHaveTextContent("3 prompts");
    expect(detail).toHaveTextContent("Agent2 observed sessions");
    expect(detail).toHaveTextContent("Subagent1 observed session");
    expect(detail).toHaveTextContent("Unclassified1 observed session");
    expect(detail).toHaveTextContent("What happened");
    expect(detail).toHaveTextContent("Sessions");
    expect(detail).not.toHaveTextContent("Canonical observed evidence");
    expect(detail).not.toHaveTextContent("Latest API read");
    expect(lane).toHaveAttribute("data-selected-index", "0");
    expect(lane.closest(".flame-person")).toHaveAttribute("data-selected", "true");
    expect(lane.querySelector(".flame-bucket-selected")).not.toBeInTheDocument();
  });

  it("loads and lists every canonical prompt underneath the interval count", async () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const wrapper = container.querySelector(".flame-person .recharts-wrapper");
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      bottom: 82, height: 82, left: 0, right: 1008, top: 0, width: 1008,
      x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });
    expect(screen.getByText("Loading prompts…")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("First exact prompt")).toBeInTheDocument());
    const detail = screen.getByRole("complementary", { name: "Ada Lovelace" });
    expect(detail).not.toHaveTextContent("prompts recorded in this interval");
    expect(within(detail).getAllByRole("listitem")).toHaveLength(6);
    expect(detail).toHaveTextContent("Second prompt excerpt");
    expect(detail).toHaveTextContent("Stored excerpt");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("snapshot=v1.snapshot-token"),
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects prompt details whose count disagrees with the selected snapshot", async () => {
    vi.mocked(fetch).mockImplementationOnce((url) => {
      const request = new URL(url, "http://dashboard.test");
      const start = request.searchParams.get("start");
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          personId: request.searchParams.get("personId"),
          start,
          snapshot: request.searchParams.get("snapshot"),
          prompts: [
            { id: "p1", at: start, content: "Only one row", truncated: false },
          ],
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

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Prompts could not be loaded",
      );
    });
    expect(screen.queryByText("prompts recorded in this interval")).not.toBeInTheDocument();
  });

  it("keeps the drawer mounted until close ends, then clears selection without refocusing a row", async () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const roster = screen.getByRole("region", { name: "People activity timelines, 2 people" });
    const person = container.querySelector(".flame-person");
    const lane = container.querySelector(".flame-person .flame-lane");
    const chart = lane.querySelector('[role="application"]');

    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    fireEvent.keyDown(chart, { key: "Enter" });

    expect(screen.getByRole("complementary", { name: "Ada Lovelace" })).toHaveTextContent(
      "0 sessions",
    );
    expect(lane).toHaveAttribute("data-selected-index", "1");

    const detail = screen.getByRole("complementary", { name: "Ada Lovelace" });
    const closeButton = screen.getByRole("button", { name: "Close interval details" });
    const icon = closeButton.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(closeButton).not.toHaveTextContent("×");

    fireEvent.click(closeButton);
    expect(detail).toHaveClass("flame-detail--closing");
    expect(closeButton).toBeDisabled();
    expect(detail).toBeInTheDocument();
    expect(chart).not.toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(detail).toHaveClass("flame-detail--closing");

    fireEvent(
      detail.querySelector("header"),
      new Event("webkitAnimationEnd", { bubbles: true }),
    );
    expect(detail).toBeInTheDocument();
    expect(chart).not.toHaveFocus();

    fireEvent(detail, new Event("webkitAnimationEnd", { bubbles: true }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await waitFor(() => expect(roster).toHaveFocus());
    expect(chart).not.toHaveFocus();
    expect(person).not.toHaveAttribute("data-selected");
    expect(lane).not.toHaveAttribute("data-selected-index");
  });

  it("uses the same selection-clearing focus lifecycle for Escape", async () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    const roster = screen.getByRole("region", { name: "People activity timelines, 2 people" });
    const person = container.querySelector(".flame-person");
    const lane = container.querySelector(".flame-person .flame-lane");
    const chart = lane.querySelector('[role="application"]');

    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "Enter" });

    const detail = screen.getByRole("complementary", { name: "Ada Lovelace" });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(detail).toHaveClass("flame-detail--closing");
    expect(detail).toBeInTheDocument();
    expect(chart).not.toHaveFocus();

    fireEvent(detail, new Event("webkitAnimationEnd", { bubbles: true }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await waitFor(() => expect(roster).toHaveFocus());
    expect(chart).not.toHaveFocus();
    expect(person).not.toHaveAttribute("data-selected");
    expect(lane).not.toHaveAttribute("data-selected-index");
  });

  it("exposes stale state without replacing the last-good graph", () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} stale />);

    expect(container.querySelector(".flame-graph")).toHaveAttribute("data-state", "stale");
    expect(screen.getByRole("heading", { name: "Ada Lovelace" })).toBeInTheDocument();
  });
});
