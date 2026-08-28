function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
const port = (listener.addr as Deno.NetAddr).port;
listener.close();

const worker = new URL(
  "../../workers/telemetry-processor/main.ts",
  import.meta.url,
);
const child = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "--allow-env",
    "--allow-net=127.0.0.1",
    "--allow-read",
    worker.pathname,
  ],
  clearEnv: true,
  env: {
    DENO_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    SUPABASE_DB_URL:
      `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
    SUPABASE_URL: "https://example.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "test-secret",
    SHERLOCK_WORKER_POLL_MS: "10",
  },
  stdout: "piped",
  stderr: "piped",
}).spawn();

const outputPromise = child.output();
const early = await Promise.race([
  outputPromise.then((output) => ({ output })),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_500)),
]);
if (early !== null) {
  const stderr = new TextDecoder().decode(early.output.stderr);
  throw new Error(
    `worker exited before recovery observation: ${early.output.code}\n${stderr}`,
  );
}

child.kill("SIGTERM");
const output = await outputPromise;
const stdout = new TextDecoder().decode(output.stdout);
const stderr = new TextDecoder().decode(output.stderr);
assert(
  output.success,
  `graceful worker shutdown failed: ${output.code}\n${stderr}`,
);
assert(
  !stderr.includes("Uncaught"),
  `worker emitted an uncaught error:\n${stderr}`,
);

const events = stdout.trim().split("\n").flatMap((line) => {
  try {
    return [JSON.parse(line) as Record<string, unknown>];
  } catch {
    return [];
  }
});
const circuitOpens = events.filter((event) =>
  event.event === "database_capacity_circuit_open" &&
  event.failure_kind === "connectivity"
);
assert(
  circuitOpens.length >= 2,
  `expected repeated in-process recovery, received:\n${stdout}`,
);
assert(
  events.some((event) => event.event === "shutdown_requested"),
  `SIGTERM was not observed:\n${stdout}`,
);
assert(
  events.some((event) => event.event === "worker_stopped"),
  `worker did not close its pools cleanly:\n${stdout}`,
);

console.log(
  JSON.stringify({
    circuit_opens: circuitOpens.length,
    error_codes: circuitOpens.map((event) => event.error_code),
    graceful_shutdown: true,
  }),
);
