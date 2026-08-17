import { parseWorkloadClassHint } from "./index.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("workload class header is optional and strictly bounded", () => {
  assert(parseWorkloadClassHint(null) === null);
  assert(parseWorkloadClassHint("") === null);
  assert(parseWorkloadClassHint("live") === "live");
  assert(parseWorkloadClassHint("backfill") === "backfill");
  let rejected = false;
  try {
    parseWorkloadClassHint("urgent");
  } catch {
    rejected = true;
  }
  assert(rejected, "unknown scheduling classes must be rejected");
});
