import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Bonaparte logo asset", () => {
  it("stays a compact double-density RGBA PNG", () => {
    const bytes = readFileSync(
      path.join(process.cwd(), "frontend/src/assets/bonaparte-logo.png"),
    );

    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(bytes.readUInt32BE(16)).toBe(79);
    expect(bytes.readUInt32BE(20)).toBe(96);
    expect(bytes[24]).toBe(8);
    expect(bytes[25]).toBe(6);
    expect(bytes.byteLength).toBeLessThan(100 * 1024);
  });
});
