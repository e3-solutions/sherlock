import { describe, expect, it } from "vitest";

import { expandSearchAliases as expandAliases } from "./search-aliases.js";

function expandSearchAliases(query, enabled = true) {
  return expandAliases(query, enabled);
}

describe("expandSearchAliases", () => {
  it("keeps alias expansion opt-in by default", () => {
    expect(expandAliases("paddleocr benchmark")).toBe("paddleocr benchmark");
  });

  it("expands the known family as complete query branches", () => {
    expect(expandSearchAliases("paddleocr benchmark")).toBe(
      'paddleocr benchmark OR paddle benchmark OR "PP-OCRv6" benchmark',
    );
    expect(expandSearchAliases("PADDLEOCR benchmark")).toBe(
      'PADDLEOCR benchmark OR paddle benchmark OR "PP-OCRv6" benchmark',
    );
  });

  it("replicates every positive AND term into every alias branch", () => {
    expect(expandSearchAliases("benchmark paddleocr logs")).toBe(
      'benchmark paddleocr logs OR benchmark paddle logs OR benchmark "PP-OCRv6" logs',
    );
  });

  it("preserves exact query bytes when disabled or when there is no alias", () => {
    for (const query of ["nothing to expand", "  PADDL E  "]) {
      expect(expandSearchAliases(query)).toBe(query);
    }
    expect(expandSearchAliases("paddleocr benchmark", false)).toBe("paddleocr benchmark");
  });

  it.each([
    '"paddleocr benchmark"',
    "-paddleocr benchmark",
    "paddleocr OR benchmark",
    "paddleocr or benchmark",
    "paddleocr-benchmark",
    "PP-OCRv6 benchmark",
  ])("leaves syntax-bearing or punctuated query %s untouched", (query) => {
    expect(expandSearchAliases(query)).toBe(query);
  });

  it("matches complete known tokens only", () => {
    for (const query of ["mypaddleocr benchmark", "paddleocrx", "unknown benchmark"]) {
      expect(expandSearchAliases(query)).toBe(query);
    }
  });

  it("preserves original whitespace in the first branch", () => {
    expect(expandSearchAliases("paddleocr\tbenchmark")).toBe(
      'paddleocr\tbenchmark OR paddle benchmark OR "PP-OCRv6" benchmark',
    );
  });

  it("bounds multi-alias Cartesian products deterministically", () => {
    const query = "paddleocr paddle";
    expect(expandSearchAliases(query)).toBe(query); // 9 branches would exceed 31 nodes.
    expect(expandSearchAliases(query)).toBe(query);
  });

  it("includes the 5-node phrase in its expansion budget", () => {
    const withinLimit = "paddleocr a b c"; // 3 branches, 4 terms plus phrase overhead: 27 nodes.
    const overLimit = "paddleocr a b c d"; // 3 branches, 5 terms plus phrase overhead: 33 nodes.
    expect(expandSearchAliases(withinLimit)).toContain('"PP-OCRv6"');
    expect(expandSearchAliases(overLimit)).toBe(overLimit);
  });

  it("recognizes ppocrv6 as an input alias", () => {
    expect(expandSearchAliases("ppocrv6 benchmark")).toBe(
      'ppocrv6 benchmark OR paddleocr benchmark OR paddle benchmark OR "PP-OCRv6" benchmark',
    );
  });

  it("accepts a 256-codepoint input and returns longer input byte-for-byte", () => {
    const atLimit = `paddleocr ${"a".repeat(246)}`;
    const overLimit = `paddleocr ${"a".repeat(247)}`;
    expect([...atLimit]).toHaveLength(256);
    expect(expandSearchAliases(atLimit)).toBe(atLimit);
    expect([...overLimit]).toHaveLength(257);
    expect(expandSearchAliases(overLimit)).toBe(overLimit);
  });

  it("returns the original when generated branches exceed 256 codepoints", () => {
    const query = `paddleocr ${"a".repeat(244)}`;
    expect([...query]).toHaveLength(254);
    expect(expandSearchAliases(query)).toBe(query);
  });
});
