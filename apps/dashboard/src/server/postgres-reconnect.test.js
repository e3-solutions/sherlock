import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import { reconnectDelay } from "../../node_modules/postgres/src/connection.js";

describe("patched postgres reconnect scheduling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("clamps an idle connection's expired retry deadline instead of scheduling negatively", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(101_489.10415794971);

    expect(reconnectDelay(1_000, 500)).toBe(0);
    expect(clock).toHaveBeenCalled();
  });

  it("preserves a future retry deadline and immediate first connection", () => {
    expect(reconnectDelay(1_000, 500, 1_200)).toBe(300);
    expect(reconnectDelay(0, 500, 1_200)).toBe(0);
  });
});
