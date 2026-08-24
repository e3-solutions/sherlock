import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chartRenderCounts = vi.hoisted(() => new Map());

vi.mock("recharts", () => ({
  Bar: () => null,
  ComposedChart: ({ "aria-label": ariaLabel }) => {
    chartRenderCounts.set(ariaLabel, (chartRenderCounts.get(ariaLabel) ?? 0) + 1);
    return (
      <div
        className="recharts-wrapper"
        role="application"
        aria-label={ariaLabel}
        tabIndex={0}
      />
    );
  },
  Line: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

import FlameGraph from "./FlameGraph.jsx";
import { adaptFlamePayload, BUCKET_COUNT } from "./flame-data.js";

function activityBuckets() {
  return Array.from(
    { length: BUCKET_COUNT },
    (_, index) => (index === 0 ? [1, 0, 0, 0] : [0, 0, 0, 0]),
  );
}

function model() {
  return adaptFlamePayload({
    start: "2026-08-14T07:00:00.000Z",
    read: "2026-08-15T07:00:00.000Z",
    snapshot: "render-isolation.snapshot",
    latest: "2026-08-14T07:00:00.000Z",
    coverage: {
      evidence: "observed_events",
      state: "complete",
      reason: null,
    },
    people: [
      {
        id: "ada",
        name: "Ada Lovelace",
        activeSeconds: 600,
        lastActivity: "2026-08-14T07:00:00.000Z",
        total: [1, 0, 0],
        buckets: activityBuckets(),
      },
      {
        id: "grace",
        name: "Grace Hopper",
        activeSeconds: 600,
        lastActivity: "2026-08-14T07:00:00.000Z",
        total: [1, 0, 0],
        buckets: activityBuckets(),
      },
    ],
  });
}

function count(name) {
  return chartRenderCounts.get(`${name} activity timeline`) ?? 0;
}

describe("FlameGraph lane render isolation", () => {
  beforeEach(() => {
    chartRenderCounts.clear();
    vi.stubGlobal("fetch", vi.fn((url) => {
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
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("rerenders only lanes whose hover or selection props change", async () => {
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
    wrappers.forEach((wrapper) => vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(bounds));

    expect([count("Ada Lovelace"), count("Grace Hopper")]).toEqual([1, 1]);

    fireEvent.mouseEnter(lanes[0]);
    expect([count("Ada Lovelace"), count("Grace Hopper")]).toEqual([2, 1]);

    fireEvent.mouseEnter(lanes[1]);
    expect([count("Ada Lovelace"), count("Grace Hopper")]).toEqual([3, 2]);

    fireEvent.mouseLeave(lanes[1]);
    expect([count("Ada Lovelace"), count("Grace Hopper")]).toEqual([3, 3]);

    fireEvent.click(wrappers[0], { clientX: 3, clientY: 34 });
    expect(screen.getByText("Loading frame evidence…")).toBeInTheDocument();
    expect([count("Ada Lovelace"), count("Grace Hopper")]).toEqual([4, 3]);

    await screen.findByText("No work-session evidence observed in this interval.");
    expect([count("Ada Lovelace"), count("Grace Hopper")]).toEqual([4, 3]);

    fireEvent.click(screen.getByRole("button", { name: "Close interval details" }));
    expect([count("Ada Lovelace"), count("Grace Hopper")]).toEqual([4, 3]);

    fireEvent.click(wrappers[1], { clientX: 3, clientY: 34 });
    expect([count("Ada Lovelace"), count("Grace Hopper")]).toEqual([5, 4]);
  });
});
