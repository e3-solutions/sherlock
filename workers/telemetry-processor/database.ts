import postgres from "./postgres.ts";

export type Sql = ReturnType<typeof postgres>;
export type ReservedSql = Awaited<ReturnType<Sql["reserve"]>>;
export type TransactionSql = postgres.TransactionSql;
export interface TransactionRunner {
  <T>(callback: (tx: TransactionSql) => Promise<T>): Promise<T>;
}

export function isReservedConnectionLost(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code).toUpperCase() : "";
  if (
    code.startsWith("08") ||
    [
      "CONNECTION_CLOSED",
      "CONNECTION_DESTROYED",
      "57P01",
      "57P02",
      "57P03",
    ].includes(code)
  ) {
    return true;
  }
  return "query" in error && [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "ENETUNREACH",
    "EHOSTUNREACH",
  ].includes(code);
}

export function throwIfReservedConnectionLost(
  error: unknown,
  cause: unknown,
): void {
  if (!isReservedConnectionLost(error)) return;
  if (error instanceof Error && error.cause === undefined) {
    Object.defineProperty(error, "cause", { value: cause });
  }
  throw error;
}

export function releaseReservedConnection(
  connection: ReservedSql,
  error?: unknown,
): void {
  if (!isReservedConnectionLost(error)) connection.release();
}

export class ProcessingDeadlineError extends Error {
  readonly code = "processing_deadline_exceeded";

  constructor(message = "processing deadline exceeded") {
    super(message);
  }
}

export function databaseUrlWithoutApplicationName(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.delete("application_name");
  return url.toString();
}

export function createPostgresPool(
  databaseUrl: string,
  maxConnections: number,
  applicationName = "sherlock-worker",
): Sql {
  return postgres(databaseUrlWithoutApplicationName(databaseUrl), {
    prepare: false,
    max: maxConnections,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: { application_name: applicationName },
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
  let failure: unknown;
  try {
    return await callback(connection);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    releaseReservedConnection(connection, failure);
  }
}

export function createReservedTransactionRunner(
  connection: ReservedSql,
  beforeBoundary: () => void = () => {},
): TransactionRunner {
  let transactionOpen = false;
  return async <T>(
    callback: (tx: TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (transactionOpen) {
      throw new Error("nested reserved transactions are not supported");
    }
    transactionOpen = true;
    try {
      beforeBoundary();
      await connection.unsafe("begin");
      let result: T;
      try {
        result = await callback(connection as unknown as TransactionSql);
        beforeBoundary();
        await connection.unsafe("commit");
      } catch (error) {
        if (!isReservedConnectionLost(error)) {
          try {
            await connection.unsafe("rollback");
          } catch (rollbackError) {
            throwIfReservedConnectionLost(rollbackError, error);
            // Preserve the callback/commit/deadline error when rollback itself
            // fails without losing the connection.
          }
        }
        throw error;
      }
      return result;
    } finally {
      // BEGIN failure has no transaction to roll back. Healthy post-BEGIN
      // failures attempt ROLLBACK before the runner can be reused.
      transactionOpen = false;
    }
  };
}
