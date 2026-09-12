import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { DirectFlameSource } from "./flame-source.js";

const DATABASE_URL = process.env.SHERLOCK_TEST_DATABASE_URL;
const describePostgres = DATABASE_URL ? describe : describe.skip;
const STATE_SQL = `select pg_backend_pid() as pid, current_role as role,
  current_setting('transaction_read_only') as read_only,
  current_setting('transaction_isolation') as isolation,
  current_setting('statement_timeout') as timeout`;

// Force backend reuse to detect leaked transaction-local state. These tests use
// direct disposable PostgreSQL; production Supavisor checkout/cancel behavior
// needs a separate pooler probe.
function sourceUsing(sql, workspaceId = crypto.randomUUID()) {
  const source = Object.create(DirectFlameSource.prototype);
  Object.assign(source, {
    sql, workspaceId, expectedEmailDomain: "e3group.ai",
    applicationName: `sherlock-dashboard:${workspaceId}`,
  });
  return source;
}

describe("dashboard transaction checkout cancellation", () => {
  it("does not invoke the caller when cancellation loses the final setup-query race", async () => {
    let reachedRole;
    let finishRole;
    let transactionFinished;
    const roleStarted = new Promise((resolve) => { reachedRole = resolve; });
    const roleResult = new Promise((resolve) => { finishRole = resolve; });
    const callback = vi.fn();
    const source = sourceUsing({
      begin: (beginCallback) => {
        transactionFinished = beginCallback({
          unsafe: (text) => {
            if (text === "set local role sherlock_reader") {
              reachedRole();
              // Model a completed query whose cancellation arrived too late.
              return roleResult;
            }
            return Promise.resolve([]);
          },
        });
        return transactionFinished;
      },
    });
    const controller = new AbortController();
    const result = source.transaction(callback, { signal: controller.signal })
      .then(() => "resolved", (error) => error.code);
    await roleStarted;
    controller.abort();
    finishRole([]);
    expect(await result).toBe("flame_request_aborted");
    await transactionFinished.catch(() => {});
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects an aborted request while BEGIN is waiting", async () => {
    let releaseBegin;
    const beginWaiting = new Promise((resolve) => { releaseBegin = resolve; });
    const callback = vi.fn();
    const unsafe = vi.fn();
    let lateBegin;
    const source = sourceUsing({
      begin: (beginCallback) => {
        lateBegin = beginWaiting.then(() => beginCallback({ unsafe }));
        return lateBegin;
      },
    });
    const controller = new AbortController();
    const transaction = source.transaction(callback, { signal: controller.signal });
    const outcome = transaction.then(() => "resolved", (error) => error.code);
    controller.abort();
    let timer;
    try {
      expect(await Promise.race([
        outcome,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("still waiting for BEGIN"), 100);
        }),
      ])).toBe("flame_request_aborted");
      expect(callback).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      releaseBegin();
      await outcome;
      await lateBegin.catch(() => {});
      expect(callback).not.toHaveBeenCalled();
      expect(unsafe).not.toHaveBeenCalled();
    }
  });

  it("never runs the user callback for an already aborted request", async () => {
    const callback = vi.fn();
    const unsafe = vi.fn();
    const source = sourceUsing({ begin: (beginCallback) => beginCallback({ unsafe }) });
    const controller = new AbortController();
    controller.abort();
    await expect(source.transaction(callback, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "flame_request_aborted" });
    expect(callback).not.toHaveBeenCalled();
    expect(unsafe).not.toHaveBeenCalled();
  });
});

describePostgres("dashboard transaction-pooling prerequisites", () => {
  beforeAll(async () => {
    // Supabase's postgres test login needs explicit membership. Establish it
    // here rather than relying on another test file's concurrent setup.
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      await sql.unsafe("grant sherlock_reader to postgres");
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("abandons queued BEGIN work and lets the next borrower use the connection", async () => {
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    const source = sourceUsing(sql);
    const held = await sql.reserve();
    const callback = vi.fn();
    const controller = new AbortController();
    let outcome;
    let timer;
    try {
      await held.unsafe("select 1");
      outcome = source.transaction(callback, { signal: controller.signal })
        .then(() => "resolved", (error) => error.code);
      controller.abort();
      expect(await Promise.race([
        outcome,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("still queued"), 500);
        }),
      ])).toBe("flame_request_aborted");
    } finally {
      clearTimeout(timer);
      held.release();
      await outcome;
      try {
        expect(await source.readiness()).toMatchObject({ status: "ok" });
        expect(callback).not.toHaveBeenCalled();
      } finally {
        await source.close();
      }
    }
  });

  it("holds one repeatable snapshot while a separate writer commits", async () => {
    const workspaceId = crypto.randomUUID();
    const reader = postgres(DATABASE_URL, { max: 1, prepare: false });
    const writer = postgres(DATABASE_URL, { max: 1, prepare: false });
    const source = sourceUsing(reader, workspaceId);
    const nameSql = "select name from telemetry.workspaces where id = $1";
    try {
      await writer.unsafe(
        "insert into telemetry.workspaces (id, slug, name) values ($1, $2, 'Before')",
        [workspaceId, `pooling-test-${workspaceId}`],
      );
      await source.transaction(async (tx) => {
        expect((await tx.unsafe(nameSql, [workspaceId]))[0].name).toBe("Before");
        await writer.unsafe("update telemetry.workspaces set name = 'After' where id = $1", [workspaceId]);
        expect((await tx.unsafe(nameSql, [workspaceId]))[0].name).toBe("Before");
      });
      expect(await source.transaction(async (tx) =>
        (await tx.unsafe(nameSql, [workspaceId]))[0].name,
      )).toBe("After");
    } finally {
      await source.close();
      try {
        await writer.unsafe("delete from telemetry.workspaces where id = $1", [workspaceId]);
      } finally {
        await writer.end({ timeout: 5 });
      }
    }
  });

  it.each(["commit", "rollback"])("resets role and settings after %s on the same backend", async (finish) => {
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    const source = sourceUsing(sql);
    const rollback = new Error("synthetic rollback");
    try {
      const [before] = await sql.unsafe(STATE_SQL);
      const transaction = source.transaction(async (tx) => {
        expect((await tx.unsafe(STATE_SQL))[0]).toEqual({
          pid: before.pid, role: "sherlock_reader", read_only: "on",
          isolation: "repeatable read", timeout: "937ms",
        });
        if (finish === "rollback") throw rollback;
      }, { statementTimeoutMs: 937 });
      if (finish === "rollback") {
        await expect(transaction).rejects.toMatchObject({ cause: rollback });
      } else {
        await transaction;
      }
      expect((await sql.unsafe(STATE_SQL))[0]).toEqual(before);
      expect(await source.readiness()).toMatchObject({ status: "ok" });
    } finally {
      await source.close();
    }
  });

  it("rejects writes even if the callback resets the reader role", async () => {
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    const source = sourceUsing(sql);
    try {
      await expect(source.transaction(async (tx) => {
        // The test login is privileged. Remove the read-role restriction to
        // prove the independent read-only transaction fence still rejects DML.
        await tx.unsafe("reset role");
        await tx.unsafe("update telemetry.workspaces set name = name where false");
      })).rejects.toMatchObject({ cause: { code: "25006" } });
      expect(await source.readiness()).toMatchObject({ status: "ok" });
    } finally {
      await source.close();
    }
  });

  it("rolls back a statement timeout and reuses the connection successfully", async () => {
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    const source = sourceUsing(sql);
    try {
      const [before] = await sql.unsafe(STATE_SQL);
      await expect(source.transaction(async (tx) => {
        await tx.unsafe("select pg_sleep(10)");
      }, { statementTimeoutMs: 50 })).rejects.toMatchObject({
        code: "flame_database_timeout", cause: { code: "57014" },
      });
      expect((await sql.unsafe(STATE_SQL))[0]).toEqual(before);
      expect(await source.readiness()).toMatchObject({ status: "ok" });
    } finally {
      await source.close();
    }
  });
});
