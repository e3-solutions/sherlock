import { EventEmitter } from "node:events";
import { isReservedConnectionLost } from "./database.ts";
import postgres from "./postgres.ts";

await proveClosedSocketWriteIsGuarded();

const databaseUrl = Deno.env.get("SHERLOCK_TEST_DATABASE_URL");
if (!databaseUrl) throw new Error("SHERLOCK_TEST_DATABASE_URL is required");

const admin = postgres(databaseUrl, { prepare: false, max: 1 });

try {
  await proveIdleReservedDisconnectRecovers(databaseUrl, admin);
  console.log("postgres socket and reserved disconnect regression passed");
} finally {
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

async function before<T>(promise: PromiseLike<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("database reconnect timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
