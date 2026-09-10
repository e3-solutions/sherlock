// Exercise the production HTTP routes against a synthetic workspace, bound to loopback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const [workspaceId, expectedJson, frozenDayJson, commitsJson = "{}"] = process.argv.slice(2);
const expected = JSON.parse(expectedJson);
const commits = JSON.parse(commitsJson);
assert.equal(new URL(process.env.SHERLOCK_TEST_DATABASE_URL).hostname, "127.0.0.1");
const server = spawn(process.execPath, ["apps/dashboard/server.mjs"], {
  env: { ...process.env, PORT: "0", HOST: "127.0.0.1", SUPABASE_DB_URL: process.env.SHERLOCK_TEST_DATABASE_URL,
    SHERLOCK_WORKSPACE_ID: workspaceId, SHERLOCK_DASHBOARD_EMAIL_DOMAIN: "e3group.ai", SHERLOCK_MCP_TOKEN: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let errors = "";
server.stderr.on("data", (chunk) => { errors += chunk; });
try {
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`dashboard startup timed out: ${errors}`)), 20_000);
    let buffer = "";
    server.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.event === "dashboard_listening") { clearTimeout(timeout); resolve(event.port); }
        } catch { /* Ordinary logs are not protocol messages. */ }
      }
    });
    server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`dashboard exited ${code}: ${errors}`)); });
  });
  const origin = `http://127.0.0.1:${port}`;
  async function json(path) {
    const response = await fetch(`${origin}${path}`);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  }
  const day = frozenDayJson ? JSON.parse(frozenDayJson) : await json("/api/flame?refresh=wait");
  const person = day.people.find((candidate) => candidate.name === "PR context E2E");
  assert.ok(person, "synthetic person missing from dashboard HTTP day");
  const work = [];
  for (let index = 0; index < person.buckets.length; index++) {
    if (!person.buckets[index].some((count) => count > 0)) continue;
    const query = new URLSearchParams({ personId: person.id, start: new Date(new Date(day.start).getTime() + index * 600_000).toISOString(), snapshot: day.snapshot });
    const interval = await json(`/api/flame/interval?${query}`);
    work.push(...interval.work);
  }
  for (const [sessionId, linkedPrs] of Object.entries(expected)) {
    const row = work.find((entry) => entry.sessionId === sessionId);
    assert.ok(row, `activity missing for session ${sessionId}`);
    assert.equal(row.pullRequest?.number ?? null, commits[sessionId] ?? null,
      "commit association A must remain separate from explicit context B");
    const actual = row.linkedPrs.map((pr) => [pr.number, pr.status]).sort();
    assert.deepEqual(actual, linkedPrs.sort(), `Linked PRs for ${sessionId}`);
    for (const pr of row.linkedPrs) {
      if (pr.status === "checked") assert.match(pr.url, /^https:\/\/github\.com\/e3-solutions\/sherlock\/pull\/\d+$/);
      else assert.ok(!pr.url, "unchecked context must not be clickable");
    }
  }
  console.log(JSON.stringify({ passed: true, day, rows: work.length }));
} finally {
  server.kill("SIGTERM");
  if (server.exitCode === null) await once(server, "exit");
}
