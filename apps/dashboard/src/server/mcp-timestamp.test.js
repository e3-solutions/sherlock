import { describe, expect, it } from "vitest";

import { TIMESTAMP_INPUT, normalizeTimestampInput } from "./mcp-timestamp.js";

describe("MCP timestamp inputs", () => {
  it.each([
    ["2026-10-26T00:00:00.000Z", "2026-10-26T00:00:00.000Z"],
    ["2026-10-26T00:00:00Z", "2026-10-26T00:00:00.000Z"],
    ["2026-10-26T00:00Z", "2026-10-26T00:00:00.000Z"],
    ["2026-10-26T13:45:07.5Z", "2026-10-26T13:45:07.500Z"],
    ["2026-10-26T13:45:07.123456Z", "2026-10-26T13:45:07.123Z"],
    ["2026-10-26T00:00:00+00:00", "2026-10-26T00:00:00.000Z"],
    ["2026-10-26T00:00:00-00:00", "2026-10-26T00:00:00.000Z"],
    ["2026-10-26T05:30:00+05:30", "2026-10-26T00:00:00.000Z"],
    ["2026-10-25T20:00:00-0400", "2026-10-26T00:00:00.000Z"],
    ["2026-10-26 00:00:00Z", "2026-10-26T00:00:00.000Z"],
    ["2026-10-26t00:00:00z", "2026-10-26T00:00:00.000Z"],
    ["2026-10-26", "2026-10-26T00:00:00.000Z"],
    ["2028-02-29", "2028-02-29T00:00:00.000Z"],
    ["1970-01-01", "1970-01-01T00:00:00.000Z"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeTimestampInput(input)).toBe(expected);
    expect(TIMESTAMP_INPUT.parse(input)).toBe(expected);
  });

  it.each([
    "",
    "yesterday",
    "2026-10-26T00:00:00",
    "2026-10-26T00:00",
    "2026-02-30",
    "2027-02-29",
    "2026-13-01",
    "2026-10-26T24:00:00Z",
    "2026-10-26T23:60:00Z",
    "2026-10-26T23:59:60Z",
    "2026-10-26T00:00:00+24:00",
    "2026-10-26T00:00:00 UTC",
    "26-10-2026",
    "1761436800000",
    "2026-10-26T00:00:00.Z",
  ])("rejects %j with an example of an accepted value", (input) => {
    expect(normalizeTimestampInput(input)).toBeNull();
    const result = TIMESTAMP_INPUT.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain("2026-10-26T00:00:00Z");
  });

  it("rejects non-strings and oversized values", () => {
    expect(normalizeTimestampInput(1761436800000)).toBeNull();
    expect(TIMESTAMP_INPUT.safeParse(1761436800000).success).toBe(false);
    expect(TIMESTAMP_INPUT.safeParse(`2026-10-26T00:00:00.${"1".repeat(80)}Z`).success).toBe(false);
  });
});
