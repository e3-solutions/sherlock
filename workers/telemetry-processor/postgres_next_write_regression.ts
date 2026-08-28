import { EventEmitter } from "node:events";
import {
  isReservedConnectionLost,
  withReservedConnection,
} from "./database.ts";
import postgres from "./postgres.ts";

type DiagnosticPhase =
  | "synthetic"
  | "reserving"
  | "blocked_active"
  | "terminating"
  | "loss_rethrown"
  | "loss_caught"
  | "recovery_started"
  | "recovery_finished"
  | "idle_disconnect";

let phase: DiagnosticPhase = "synthetic";
const promiseLabels = new WeakMap<object, string>();
globalThis.addEventListener("unhandledrejection", (event) => {
  console.error(JSON.stringify({
    diagnostic: "postgres_unhandled_rejection",
    phase,
    promise_label: promiseLabels.get(event.promise) ?? "untracked",
    error_code: errorCode(event.reason),
  }));
});

await proveClosedSocketWriteIsGuarded();

const databaseUrl = Deno.env.get("SHERLOCK_TEST_DATABASE_URL");
if (!databaseUrl) throw new Error("SHERLOCK_TEST_DATABASE_URL is required");

const worker = postgres(databaseUrl, {
  prepare: false,
  max: 1,
  connection: { application_name: "sherlock-next-write-regression" },
  onclose: (connectionId) => {
    console.error(JSON.stringify({
      diagnostic: "postgres_connection_closed",
      phase,
      connection_id: connectionId,
    }));
  },
});
const admin = postgres(databaseUrl, { prepare: false, max: 1 });

try {
  for (let attempt = 0; attempt < 1; attempt += 1) {
    phase = "reserving";
    let disconnectError: unknown;
    try {
      const reservedRun = withReservedConnection(
        worker,
        performance.now() + 5_000,
        async (connection) => {
          const backendQuery = labelPromise(
            connection.unsafe(
              "select pg_backend_pid()::integer as pid",
            ),
            "backend_pid_query",
          );
          const [backend] = await backendQuery;
          const pid = Number(backend.pid);
          const blockedQuery = labelPromise(
            connection.unsafe("select pg_sleep(30)"),
            "blocked_query",
          );
          const blocked = labelPromise(
            blockedQuery.then(
              () => ({ ok: true as const }),
              (error) => ({ ok: false as const, error }),
            ),
            "blocked_outcome",
          );
          phase = "blocked_active";
          await labelPromise(
            waitUntilQueryIsActive(admin, pid),
            "wait_until_active",
          );
          phase = "terminating";
          await labelPromise(
            admin.unsafe("select pg_terminate_backend($1)", [pid]),
            "terminate_query",
          );
          const outcome = await blocked;
          if (outcome.ok) {
            throw new Error("terminated query unexpectedly succeeded");
          }
          phase = "loss_rethrown";
          throw outcome.error;
        },
      );
      labelPromise(reservedRun, "with_reserved_connection");
      await reservedRun;
    } catch (error) {
      phase = "loss_caught";
      disconnectError = error;
    }
    assert(
      isReservedConnectionLost(disconnectError),
      `backend termination must be a connection loss, got ${
        errorCode(disconnectError)
      }`,
    );

    phase = "recovery_started";
    const recoveryQuery = labelPromise(
      worker.unsafe("select 1::integer as value"),
      "recovery_query",
    );
    const recovered = await labelPromise(
      before(recoveryQuery, 5_000, "recovery"),
      "recovery_before",
    );
    phase = "recovery_finished";
    assert(Number(recovered[0]?.value) === 1, "the pool must reconnect");
  }
  phase = "idle_disconnect";
  await proveIdleReservedDisconnectRecovers(databaseUrl, admin);
  console.log("postgres nextWrite close/reuse regression passed");
} finally {
  await worker.end({ timeout: 1 }).catch(() => undefined);
  await admin.end({ timeout: 1 }).catch(() => undefined);
}

async function proveIdleReservedDisconnectRecovers(
  databaseUrl: string,
  admin: ReturnType<typeof postgres>,
): Promise<void> {
  let notifyClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });
  const worker = postgres(databaseUrl, {
    prepare: false,
    max: 1,
    connection: { application_name: "sherlock-idle-reserve-regression" },
    onclose: () => notifyClosed?.(),
  });
  try {
    const connection = await worker.reserve();
    let disconnectError: unknown;
    try {
      const [backend] = await connection.unsafe(
        "select pg_backend_pid()::integer as pid",
      );
      const pid = Number(backend.pid);
      await admin.unsafe("select pg_terminate_backend($1)", [pid]);
      await before(closed, 5_000);
      try {
        await before(connection.unsafe("select 1"), 5_000);
      } catch (error) {
        disconnectError = error;
      }
      assert(
        isReservedConnectionLost(disconnectError),
        `idle reserved use must reject after disconnect, got ${
          errorCode(disconnectError)
        }`,
      );
    } finally {
      connection.release();
    }
    const recovered = await before(
      worker.unsafe("select 1::integer as value"),
      5_000,
    );
    assert(
      Number(recovered[0]?.value) === 1,
      "the pool must reconnect after idle reserved release",
    );
  } finally {
    await worker.end({ timeout: 1 }).catch(() => undefined);
  }
}

async function proveClosedSocketWriteIsGuarded(): Promise<void> {
  let factoryCalls = 0;
  let closeObserved = false;
  let writes = 0;
  const pool = postgres("postgres://test:test@socket.invalid/test", {
    max: 1,
    socket: () => {
      factoryCalls += 1;
      if (factoryCalls > 1) {
        throw new Error("stop the synthetic reconnect");
      }
      const socket = new EventEmitter() as EventEmitter & {
        readyState: string;
        write: () => boolean;
        end: () => void;
        destroy: () => void;
        setKeepAlive: () => void;
      };
      socket.readyState = "open";
      socket.write = () => {
        writes += 1;
        return true;
      };
      socket.end = () => {};
      socket.destroy = () => {};
      socket.setKeepAlive = () => {};
      const on = socket.on.bind(socket);
      socket.on = ((event: string, listener: (...args: unknown[]) => void) => {
        on(event, listener);
        if (event === "data") {
          queueMicrotask(() => {
            closeObserved = true;
            socket.readyState = "closed";
            socket.emit("close", false);
          });
        }
        return socket;
      }) as typeof socket.on;
      return socket as never;
    },
  } as never);
  try {
    await before(pool.unsafe("select 1").catch(() => undefined), 1_000);
    assert(closeObserved, "the synthetic socket must close before nextWrite");
    assert(writes === 0, "nextWrite must not write after the socket closes");
  } finally {
    await pool.end({ timeout: 0 }).catch(() => undefined);
  }
}

async function waitUntilQueryIsActive(
  sql: ReturnType<typeof postgres>,
  pid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activityQuery = labelPromise(
      sql.unsafe(
        `select 1
         from pg_stat_activity
        where pid = $1 and state = 'active' and query like 'select pg_sleep%'`,
        [pid],
      ),
      `activity_query_${attempt}`,
    );
    const rows = await activityQuery;
    if (rows.length === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the terminating query");
}

async function before<T>(
  promise: PromiseLike<T>,
  milliseconds: number,
  label = "deadline",
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = labelPromise(
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("database reconnect timed out")),
          milliseconds,
        );
      }),
      `${label}_timeout`,
    );
    const race = labelPromise(
      Promise.race([
        promise,
        timeout,
      ]),
      `${label}_race`,
    );
    return await race;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function labelPromise<T extends PromiseLike<unknown>>(
  promise: T,
  label: string,
): T {
  promiseLabels.set(promise, label);
  return promise;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : error instanceof Error
    ? error.message
    : String(error);
}
