import postgres from "npm:postgres@3.4.7";

export type Sql = ReturnType<typeof postgres>;
export type ReservedSql = Awaited<ReturnType<Sql["reserve"]>>;

export class ProcessingDeadlineError extends Error {
  readonly code = "processing_deadline_exceeded";

  constructor(message = "processing deadline exceeded") {
    super(message);
  }
}

export function createPostgresPool(
  databaseUrl: string,
  maxConnections: number,
): Sql {
  return postgres(databaseUrl, {
    prepare: false,
    max: maxConnections,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export function remainingMilliseconds(deadlineAtMs: number): number {
  const remaining = Math.floor(deadlineAtMs - performance.now());
  if (remaining <= 0) throw new ProcessingDeadlineError();
  return remaining;
}

export async function reserveBefore(
  sql: Sql,
  deadlineAtMs: number,
): Promise<ReservedSql> {
  const remaining = remainingMilliseconds(deadlineAtMs);
  const reservation = sql.reserve();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reservation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new ProcessingDeadlineError("database pool acquisition timed out"),
          );
        }, remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
      void reservation.then((connection) => connection.release(), () => {});
    }
  }
}

export async function withReservedConnection<T>(
  sql: Sql,
  deadlineAtMs: number,
  callback: (connection: ReservedSql) => Promise<T>,
): Promise<T> {
  const connection = await reserveBefore(sql, deadlineAtMs);
  try {
    return await callback(connection);
  } finally {
    connection.release();
  }
}
