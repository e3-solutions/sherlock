import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adaptMock } = vi.hoisted(() => ({
  adaptMock: vi.fn(),
}));

vi.mock("./flame-data.js", () => ({
  adaptFlamePayload: adaptMock,
  BUCKET_MS: 10 * 60 * 1000,
}));

vi.mock("./FlameGraph.jsx", () => ({
  default: ({ data, stale }) => (
    <div data-testid="flame-graph" data-stale={String(stale)}>
      {data.marker}
    </div>
  ),
}));

import App, { nextRefreshDelay } from "./App.jsx";

const payload = { raw: true };
const model = {
  marker: "adapted timeline",
  coverage: {
    evidence: "observed_events",
    state: "partial",
    reason: "event_presence_not_continuous_attention",
  },
};

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

describe("App", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:03:00Z"));
    adaptMock.mockReturnValue(model);
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
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/flame?window=recent",
      expect.objectContaining({
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/flame", expect.objectContaining({
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: expect.any(AbortSignal),
    }));
  });

  it("renders the recent window before the full timeline request completes", async () => {
    const recentPayload = { marker: "recent response" };
    const recentModel = { ...model, marker: "recent timeline" };
    let resolveFull;
    const fullRequest = new Promise((resolve) => {
      resolveFull = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ body: recentPayload }))
      .mockReturnValueOnce(fullRequest);
    adaptMock.mockImplementation((value) => (
      value === recentPayload ? recentModel : model
    ));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await settle();

    expect(screen.getByTestId("flame-graph")).toHaveTextContent("recent timeline");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing the latest 2 hours while earlier intervals load.",
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/flame?window=recent",
      "/api/flame",
    ]);

    resolveFull(response());
    await settle();
    expect(screen.getByTestId("flame-graph")).toHaveTextContent("adapted timeline");
    expect(screen.queryByText(/while earlier intervals load/)).not.toBeInTheDocument();
  });

  it("stacks recency above the role legend beneath the brand", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { container } = render(<App />);
    const header = container.querySelector(".portal-header");
    const legendRegion = within(header).getByLabelText("Timeline legend");
    const activityLegend = within(legendRegion).getByRole("list", { name: "Activity legend" });
    const statusLegend = within(legendRegion).getByRole("list", {
      name: "Activity recency legend",
    });

    expect(header.querySelector(".portal-header__brand")).toHaveTextContent("Bonaparte");
    expect(header.querySelector(".portal-header__brand + .portal-header__legend"))
      .toBe(legendRegion);
    expect(statusLegend.nextElementSibling).toBe(activityLegend);
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

  it("offers an immediate retry after the initial request fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: false, status: 503 }))
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Timeline unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByTestId("flame-graph")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retains the last-good graph and announces a failed refresh", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ ok: false, status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(nextRefreshDelay(Date.now()));
    });
    await settle();

    expect(screen.getByText(/Refresh failed\. Showing the last successful read\./)).toHaveTextContent(
      "Refresh failed. Showing the last successful read.",
    );
    expect(screen.getByTestId("flame-graph")).toHaveAttribute("data-stale", "true");
    expect(screen.getByTestId("flame-graph")).toHaveTextContent("adapted timeline");
  });

  it("keeps partial coverage chrome out of the visible timeline", async () => {
    adaptMock.mockReturnValue({
      marker: "partial timeline",
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ ok: false, status: 503 }))
      .mockResolvedValueOnce(response());
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
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
});
