// Uses only a running local Supabase stack; never loads repository .env files.
import { spawnSync } from "node:child_process";

const cli = process.env.SUPABASE_BIN ?? "supabase";
const deno = process.env.DENO_BIN ?? "deno";
const status = spawnSync(cli, ["status", "-o", "json"], {
  cwd: process.env.SHERLOCK_TEST_SUPABASE_PROJECT ?? process.cwd(),
  encoding: "utf8",
});
if (status.status !== 0) throw new Error("Start a dedicated local Supabase stack before running this test");
const local = JSON.parse(status.stdout);
for (const value of [local.DB_URL, local.API_URL]) {
  if (new URL(value).hostname !== "127.0.0.1") throw new Error("Refusing a non-local test target");
}
const result = spawnSync(deno, [
  "run", "--config", "workers/telemetry-processor/deno.json", "--allow-env",
  "--allow-net=127.0.0.1", "--allow-read", "--allow-write", "--allow-run=python3,node",
  "tests/end-to-end/pr-context.ts",
], {
  stdio: "inherit",
  env: { ...process.env,
    SHERLOCK_TEST_DATABASE_URL: local.DB_URL,
    SHERLOCK_TEST_SUPABASE_URL: local.API_URL,
    SHERLOCK_TEST_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
  },
});
process.exit(result.status ?? 1);
