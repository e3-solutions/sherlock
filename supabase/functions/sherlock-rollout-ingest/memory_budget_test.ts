import { IngestError } from "./contract.ts";
import { MemoryBudget, SMALL_REQUEST_BYTES } from "./memory_budget.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

const reserved = (budget: MemoryBudget): number => budget.reservedBytes;

const settled = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(() => "granted", () => "refused"),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 20)),
  ]);

Deno.test("a request larger than the budget still runs alone", async () => {
  const budget = new MemoryBudget(10);
  const release = await budget.reserve(24, 1_000);
  assert(reserved(budget) === 24);
  release();
  release();
  assert(reserved(budget) === 0, "release must be idempotent");
});

Deno.test("a second large request waits for the first, then runs", async () => {
  const budget = new MemoryBudget(24);
  const first = await budget.reserve(16, 1_000);
  const second = budget.reserve(16, 1_000);
  assert(await settled(second) === "waiting");
  first();
  const release = await second;
  assert(reserved(budget) === 16);
  release();
});

const MiB = 1024 * 1024;

Deno.test("a small request is not held behind a waiting large one", async () => {
  const budget = new MemoryBudget(24 * MiB);
  const large = await budget.reserve(16 * MiB, 1_000);
  const waiting = budget.reserve(16 * MiB, 1_000);
  const small = budget.reserve(SMALL_REQUEST_BYTES, 1_000);
  assert(await settled(small) === "granted");
  assert(await settled(waiting) === "waiting");
  large();
  (await small)();
  (await waiting)();
  assert(reserved(budget) === 0);
});

Deno.test("a large request cannot pass an older large one that is waiting", async () => {
  const budget = new MemoryBudget(24 * MiB);
  const running = await budget.reserve(12 * MiB, 1_000);
  const older = budget.reserve(16 * MiB, 1_000);
  // 12 + 8 fits, but it would let mid-size work starve the older request.
  const newer = budget.reserve(8 * MiB, 1_000);
  assert(await settled(older) === "waiting");
  assert(await settled(newer) === "waiting");
  running();
  assert(await settled(older) === "granted");
  assert(await settled(newer) === "granted", "16 + 8 fits once 12 is done");
  (await older)();
  (await newer)();
  assert(reserved(budget) === 0);
});

Deno.test("a request that cannot get the budget in time answers 503 ingest_busy", async () => {
  const budget = new MemoryBudget(24);
  const held = await budget.reserve(20, 1_000);
  let refusal: unknown = null;
  try {
    await budget.reserve(16, 10);
  } catch (error) {
    refusal = error;
  }
  assert(
    refusal instanceof IngestError && refusal.code === "ingest_busy" &&
      refusal.status === 503,
    `received ${refusal}`,
  );
  held();
  assert(reserved(budget) === 0, "a refused wait must not hold budget");
  const later = await budget.reserve(16, 10);
  later();
});
