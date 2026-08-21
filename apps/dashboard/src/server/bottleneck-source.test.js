import { describe, expect, it, vi } from "vitest";

import {
  BottleneckSource,
  BottleneckSourceError,
  createBottleneckReadinessGate,
  decodeBottleneckCursor,
  encodeBottleneckCursor,
  hashCandidateBatch,
  validateBottleneckCursorSecret,
} from "./bottleneck-source.js";

const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const OTHER_WORKSPACE = "44444444-4444-4444-8444-444444444444";
const CURSOR_SECRET = "c".repeat(32);
const OTHER_SECRET = "d".repeat(32);

function request() {
  return {
    submissionId: "11111111-1111-4111-8111-111111111111",
    analysisScope: {
      usageSnapshotToken: "snapshot",
      window: {
        startInclusive: "2026-08-20T00:00:00.000Z",
        endExclusive: "2026-08-21T00:00:00.000Z",
        readAt: "2026-08-21T00:00:01.000Z",
      },
      completeness: "all_candidates_within_scope",
    },
    candidates: [{
      candidateKey: "one",
      title: "One",
      claim: "A bounded claim",
      evidence: [
        { type: "usage_summary", personId: "22222222-2222-4222-8222-222222222222" },
        {
          type: "prompt_bucket",
          personId: "22222222-2222-4222-8222-222222222222",
          bucketStart: "2026-08-20T01:00:00.000Z",
        },
      ],
    }],
  };
}

function readinessRow(overrides = {}) {
  return {
    exact_role: true,
    exact_session_user: true,
    read_only: true,
    role_posture: true,
    worker_login_posture: true,
    session_member: true,
    worker_member: true,
    reports_exist: true,
    candidates_exist: true,
    column_contract: true,
    migration_receipt: true,
    product_schema_posture: true,
    required_functions_execute: true,
    function_integrity: true,
    product_functions_not_widened: true,
    product_relations_scoped: true,
    role_memberships_absent: true,
    reports_posture: true,
    candidates_posture: true,
    column_insert_posture: true,
    reports_sequence_posture: true,
    candidates_sequence_posture: true,
    source_schemas_revoked: true,
    source_objects_revoked: true,
    fixed_claim_columns: true,
    critical_triggers: true,
    critical_constraints: true,
    critical_checks: true,
    ...overrides,
  };
}

describe("bottleneck source primitives", () => {
  it("canonicalizes object property order while preserving candidate and evidence order", () => {
    const original = request();
    const reordered = {
      candidates: original.candidates.map((candidate) => ({
        evidence: candidate.evidence.map((evidence) => Object.fromEntries(
          Object.entries(evidence).reverse(),
        )),
        claim: candidate.claim,
        title: candidate.title,
        candidateKey: candidate.candidateKey,
      })),
      analysisScope: {
        completeness: original.analysisScope.completeness,
        window: Object.fromEntries(Object.entries(original.analysisScope.window).reverse()),
        usageSnapshotToken: original.analysisScope.usageSnapshotToken,
      },
      submissionId: original.submissionId,
    };
    expect(hashCandidateBatch(reordered)).toBe(hashCandidateBatch(original));

    const reversedEvidence = structuredClone(original);
    reversedEvidence.candidates[0].evidence.reverse();
    expect(hashCandidateBatch(reversedEvidence)).not.toBe(hashCandidateBatch(original));
  });

  it("authenticates workspace-bound bigint cursor identities", () => {
    const cursor = encodeBottleneckCursor({
      workspaceId: WORKSPACE,
      highWaterId: "9223372036854775807",
      afterId: "9007199254740993",
      cursorSecret: CURSOR_SECRET,
    });
    expect(decodeBottleneckCursor(cursor, {
      workspaceId: WORKSPACE,
      cursorSecret: CURSOR_SECRET,
    })).toEqual({
      highWaterId: "9223372036854775807",
      afterId: "9007199254740993",
    });
    expect(() => decodeBottleneckCursor(cursor, {
      workspaceId: OTHER_WORKSPACE,
      cursorSecret: CURSOR_SECRET,
    })).toThrow(BottleneckSourceError);
    expect(() => decodeBottleneckCursor(cursor, {
      workspaceId: WORKSPACE,
      cursorSecret: OTHER_SECRET,
    })).toThrow(BottleneckSourceError);

    const [version, body, digest] = cursor.split(".");
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    decoded.h = "9999999999999999999";
    const forgedBody = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    expect(() => decodeBottleneckCursor(`${version}.${forgedBody}.${digest}`, {
      workspaceId: WORKSPACE,
      cursorSecret: CURSOR_SECRET,
    })).toThrow(BottleneckSourceError);
    expect(() => decodeBottleneckCursor("b2.bad.bad+", {
      workspaceId: WORKSPACE,
      cursorSecret: CURSOR_SECRET,
    })).toThrow(BottleneckSourceError);
    expect(() => encodeBottleneckCursor({
      workspaceId: WORKSPACE,
      highWaterId: "1",
      afterId: "2",
      cursorSecret: CURSOR_SECRET,
    }))
      .toThrow(BottleneckSourceError);
    expect(() => validateBottleneckCursorSecret("x".repeat(31))).toThrow(TypeError);
  });

  it("reports unsafe product posture and accepts the exact role matrix", async () => {
    const source = Object.create(BottleneckSource.prototype);
    const unsafe = vi.fn().mockResolvedValue([
      readinessRow({ source_schemas_revoked: false }),
    ]);
    source.transaction = (callback) => callback({ unsafe });

    await expect(source.readiness()).resolves.toEqual({
      status: "unavailable",
      reason: "bottleneck_database_role_unsafe",
    });

    for (const widened of [
      { role_posture: false },
      { exact_session_user: false },
      { worker_login_posture: false },
      { worker_member: false },
      { role_memberships_absent: false },
      { column_contract: false },
      { migration_receipt: false },
      { product_schema_posture: false },
      { required_functions_execute: false },
      { function_integrity: false },
      { product_functions_not_widened: false },
      { product_relations_scoped: false },
      { reports_posture: false },
      { candidates_posture: false },
      { column_insert_posture: false },
      { reports_sequence_posture: false },
      { candidates_sequence_posture: false },
      { source_objects_revoked: false },
      { fixed_claim_columns: false },
      { critical_triggers: false },
      { critical_constraints: false },
      { critical_checks: false },
    ]) {
      unsafe.mockResolvedValue([readinessRow(widened)]);
      await expect(source.readiness()).resolves.toEqual({
        status: "unavailable",
        reason: "bottleneck_database_role_unsafe",
      });
    }

    unsafe.mockResolvedValue([readinessRow()]);
    await expect(source.readiness()).resolves.toEqual({
      status: "ok",
      mode: "sherlock_bottleneck_product",
    });
  });

  it("reports unavailable before the product role or migration can be assumed", async () => {
    const source = Object.create(BottleneckSource.prototype);
    source.transaction = vi.fn().mockRejectedValue(
      new BottleneckSourceError("database_unavailable"),
    );

    await expect(source.readiness()).resolves.toEqual({
      status: "unavailable",
      reason: "bottleneck_database_unavailable",
    });
  });

  it("re-evaluates serial readiness and coalesces only concurrent checks", async () => {
    const source = {
      readiness: vi.fn()
        .mockResolvedValueOnce({ status: "ok", mode: "sherlock_bottleneck_product" })
        .mockResolvedValueOnce({ status: "unavailable", reason: "posture_changed" })
        .mockResolvedValueOnce({ status: "ok", mode: "sherlock_bottleneck_product" }),
    };
    const gate = createBottleneckReadinessGate(source);

    await expect(gate.readiness()).resolves.toEqual({
      status: "ok",
      mode: "sherlock_bottleneck_product",
    });
    await expect(gate.readiness()).resolves.toEqual({
      status: "unavailable",
      reason: "posture_changed",
    });
    await expect(gate.readiness()).resolves.toEqual({
      status: "ok",
      mode: "sherlock_bottleneck_product",
    });
    expect(source.readiness).toHaveBeenCalledTimes(3);

    let resolveReadiness;
    source.readiness.mockImplementationOnce(() => new Promise((resolve) => {
      resolveReadiness = resolve;
    }));
    const first = gate.readiness();
    const second = gate.readiness();
    await vi.waitFor(() => expect(resolveReadiness).toBeTypeOf("function"));
    resolveReadiness({ status: "ok", mode: "sherlock_bottleneck_product" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "ok", mode: "sherlock_bottleneck_product" },
      { status: "ok", mode: "sherlock_bottleneck_product" },
    ]);
    expect(source.readiness).toHaveBeenCalledTimes(4);
  });

  it("rejects a forged cursor before opening a database transaction", async () => {
    const source = Object.create(BottleneckSource.prototype);
    source.workspaceId = WORKSPACE;
    source.cursorSecret = CURSOR_SECRET;
    source.transaction = vi.fn();
    const cursor = encodeBottleneckCursor({
      workspaceId: WORKSPACE,
      highWaterId: "20",
      afterId: "10",
      cursorSecret: CURSOR_SECRET,
    });
    const [version, body, digest] = cursor.split(".");
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    value.h = "999";
    const forged = `${version}.${Buffer.from(JSON.stringify(value)).toString("base64url")}.${digest}`;

    await expect(source.listBottleneckCandidates({ cursor: forged }))
      .rejects.toMatchObject({ code: "cursor_invalid" });
    expect(source.transaction).not.toHaveBeenCalled();
  });

  it("uses read-only READ COMMITTED for candidate-list traversals", async () => {
    const source = Object.create(BottleneckSource.prototype);
    source.workspaceId = WORKSPACE;
    source.cursorSecret = CURSOR_SECRET;
    source.transaction = vi.fn(async (_callback, options) => options);

    await expect(source.listBottleneckCandidates({})).resolves.toEqual({
      signal: undefined,
      readOnly: true,
      readOnlyIsolation: "read committed",
    });
    expect(source.transaction).toHaveBeenCalledTimes(1);
  });
});
