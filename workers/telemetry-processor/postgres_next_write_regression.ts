import postgres from "./postgres.ts";

const databaseUrl = Deno.env.get("SHERLOCK_TEST_DATABASE_URL");
if (!databaseUrl) throw new Error("SHERLOCK_TEST_DATABASE_URL is required");

const worker = postgres(databaseUrl, {
  prepare: false,
  max: 1,
  connection: { application_name: "sherlock-next-write-regression" },
});
const admin = postgres(databaseUrl, { prepare: false, max: 1 });

try {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const connection = await worker.reserve();
    const [backend] = await connection.unsafe(
      "select pg_backend_pid()::integer as pid",
    );
    const pid = Number(backend.pid);
    const blocked = Promise.resolve(
      connection.unsafe("select pg_sleep(30)"),
    );
    await waitUntilQueryIsActive(admin, pid);
    await admin.unsafe("select pg_terminate_backend($1)", [pid]);
    let disconnected = false;
    try {
      await blocked;
    } catch {
      disconnected = true;
    } finally {
      connection.release();
    }
    assert(disconnected, "backend termination must reject the active query");

    const recovered = await before(
      worker.unsafe("select 1::integer as value"),
      5_000,
    );
    assert(Number(recovered[0]?.value) === 1, "the pool must reconnect");
  }
  console.log("postgres nextWrite close/reuse regression passed");
} finally {
  await worker.end({ timeout: 1 }).catch(() => undefined);
  await admin.end({ timeout: 1 }).catch(() => undefined);
}

async function waitUntilQueryIsActive(
  sql: ReturnType<typeof postgres>,
  pid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await sql.unsafe(
      `select 1
         from pg_stat_activity
        where pid = $1 and state = 'active' and query like 'select pg_sleep%'`,
      [pid],
    );
    if (rows.length === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the terminating query");
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
