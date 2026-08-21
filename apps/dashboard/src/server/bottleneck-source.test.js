import { describe, expect, it } from "vitest";

import { BottleneckSource, BottleneckSourceError, hashCandidateBatch } from "./bottleneck-source.js";

function batch() {
  return {
    submissionId: "11111111-1111-4111-8111-111111111111",
    method: {
      usageEvidence: { schemaVersion: "bonaparte.usage-evidence.v2" },
      repository: { identifier: "repo", revision: "a".repeat(40) },
    },
    candidates: [{
      candidateKey: "one",
      evidence: [
        { type: "usage_summary", personId: "22222222-2222-4222-8222-222222222222" },
        { type: "code_reference", path: "src/one.js", lineStart: 1, lineEnd: 2 },
      ],
    }],
  };
}

describe("candidate batch persistence primitives", () => {
  it("hashes only canonical method and candidate JSON while preserving arrays", () => {
    const original = batch();
    const reordered = {
      submissionId: "33333333-3333-4333-8333-333333333333",
      candidates: original.candidates.map((candidate) => Object.fromEntries(
        Object.entries(candidate).reverse(),
      )),
      method: Object.fromEntries(Object.entries(original.method).reverse()),
    };
    expect(hashCandidateBatch(reordered)).toBe(hashCandidateBatch(original));

    const reversed = structuredClone(original);
    reversed.candidates[0].evidence.reverse();
    expect(hashCandidateBatch(reversed)).not.toBe(hashCandidateBatch(original));
  });

  it("keeps writes disabled until the durable external throttle rollout", async () => {
    const source = Object.create(BottleneckSource.prototype);
    source.writesEnabled = false;
    source.transaction = () => {
      throw new Error("must not open a transaction");
    };
    await expect(source.submitCandidateBatch(batch()))
      .rejects.toEqual(new BottleneckSourceError("writes_disabled"));
  });
});
