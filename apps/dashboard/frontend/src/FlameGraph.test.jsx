import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import FlameGraph, {
  BucketTooltip,
  getBucketTooltipPlacement,
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
    latest: "2026-08-15T06:50:00.000Z",
    people: [
      {
        id: "ada",
        name: "Ada Lovelace",
        total: [2, 1, 1],
        buckets: adaBuckets,
      },
      {
        id: "zero",
        name: "Zero Activity",
        total: [0, 0, 0],
        buckets: emptyBuckets(),
      },
    ],
  });
}

describe("FlameGraph", () => {
  it("renders every ordered bucket on a shared semantic time axis", () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={720} />);

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
  });

  it("uses named legend entries and non-color-only SVG patterns", () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={720} />);
    const legend = screen.getByRole("list", { name: "Activity legend" });

    expect(screen.getByText(/24H · 10M · COMPLETE · READ .* · LATEST/))
      .toBeInTheDocument();
    for (const label of ["Agent", "Subagent", "Unclassified", "Prompts"]) {
      expect(within(legend).getByText(label)).toBeInTheDocument();
    }
    expect(container.querySelectorAll('pattern[id^="flame-subagent-"]')).toHaveLength(2);
    expect(container.querySelectorAll('pattern[id^="flame-unclassified-"]')).toHaveLength(2);
    expect(container.querySelectorAll(".flame-prompt-stem")).toHaveLength(2);
  });

  it("renders bucket-aligned prompt stems with globally consistent magnitude", () => {
    const data = model();
    const { container } = render(<FlameGraph data={data} chartWidth={720} />);

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
    render(<FlameGraph data={model()} chartWidth={720} />);

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
    expect(tooltip).toHaveTextContent("4 work threads");
    expect(tooltip).toHaveTextContent("Agent 2");
    expect(tooltip).toHaveTextContent("Subagent 1");
    expect(tooltip).toHaveTextContent("Unclassified 1");
    expect(tooltip).toHaveTextContent("Prompts 3");
    expect(tooltip.querySelector("time")).toHaveAttribute(
      "datetime",
      new Date(point.startMs).toISOString(),
    );
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
    const { container } = render(<FlameGraph data={model()} chartWidth={720} />);
    const adaChart = container.querySelector('.flame-person [role="application"]');

    fireEvent.focus(adaChart);
    await waitFor(() => {
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("4 work threads");
    });

    fireEvent.keyDown(adaChart, { key: "ArrowRight" });
    await waitFor(() => {
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("0 work threads");
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("Prompts 0");
    });

    fireEvent.blur(adaChart);
    await waitFor(() => {
      expect(document.querySelector(".flame-tooltip")).not.toBeInTheDocument();
    });
  });

  it("keeps pointer hover tied to the first and last bucket payloads", async () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={720} />);
    const lane = container.querySelector(".flame-person .flame-lane");
    const wrapper = lane.querySelector(".recharts-wrapper");
    const bounds = {
      bottom: 68,
      height: 68,
      left: 0,
      right: 720,
      top: 0,
      width: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(bounds);
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(bounds);

    fireEvent.mouseMove(wrapper, { clientX: 3, clientY: 34 });
    await waitFor(() => {
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("4 work threads");
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("Prompts 3");
    });

    fireEvent.mouseMove(wrapper, { clientX: 717, clientY: 34 });
    await waitFor(() => {
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("1 work thread");
      expect(document.querySelector(".flame-tooltip")).toHaveTextContent("Prompts 0");
    });
  });

  it("opens aggregate interval details for the exact clicked bucket", () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={720} />);
    const lane = container.querySelector(".flame-person .flame-lane");
    const wrapper = lane.querySelector(".recharts-wrapper");
    const bounds = {
      bottom: 68,
      height: 68,
      left: 0,
      right: 720,
      top: 0,
      width: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(bounds);

    fireEvent.click(wrapper, { clientX: 3, clientY: 34 });

    const detail = screen.getByRole("complementary", { name: "Ada Lovelace" });
    expect(detail).toHaveTextContent("4 work threads");
    expect(detail).toHaveTextContent("3 prompts");
    expect(detail).toHaveTextContent("Agent2 work threads");
    expect(detail).toHaveTextContent("Subagent1 work thread");
    expect(detail).toHaveTextContent("Unclassified1 work thread");
    expect(detail).toHaveTextContent("Aggregate evidence only");
    expect(lane).toHaveAttribute("data-selected-index", "0");
    expect(lane.querySelector(".flame-bucket-selected")).toBeInTheDocument();
  });

  it("selects by keyboard and restores chart focus when details close", async () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={720} />);
    const lane = container.querySelector(".flame-person .flame-lane");
    const chart = lane.querySelector('[role="application"]');

    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    fireEvent.keyDown(chart, { key: "Enter" });

    expect(screen.getByRole("complementary", { name: "Ada Lovelace" })).toHaveTextContent(
      "0 work threads",
    );
    expect(lane).toHaveAttribute("data-selected-index", "1");

    fireEvent.click(screen.getByRole("button", { name: "Close interval details" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await waitFor(() => expect(chart).toHaveFocus());
  });

  it("exposes stale state without replacing the last-good graph", () => {
    const { container } = render(<FlameGraph data={model()} chartWidth={720} stale />);

    expect(container.querySelector(".flame-graph")).toHaveAttribute("data-state", "stale");
    expect(screen.getByRole("heading", { name: "Ada Lovelace" })).toBeInTheDocument();
  });
});
