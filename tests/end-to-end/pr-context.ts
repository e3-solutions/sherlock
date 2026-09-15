// Real collector -> HTTP ingest -> local Storage/Postgres -> worker -> dashboard.
// GitHub identity responses are deterministic boundary fixtures.
import postgres from "../../workers/telemetry-processor/postgres.ts";
import { handleRequest } from "../../supabase/functions/sherlock-rollout-ingest/index.ts";
import { PostgresBatchRepository } from "../../supabase/functions/sherlock-rollout-ingest/postgres.ts";
import { IngestService } from "../../supabase/functions/sherlock-rollout-ingest/service.ts";
import { SupabaseImmutableStorage } from "../../supabase/functions/sherlock-rollout-ingest/storage.ts";
import { sha256Hex } from "../../supabase/functions/sherlock-rollout-ingest/contract.ts";
import { PostgresJobQueue } from "../../workers/telemetry-processor/queue.ts";
import {
  SupabaseRawStorage,
  TelemetryProcessor,
} from "../../workers/telemetry-processor/processor.ts";
import { proveAndActivateFrameProjection } from "../../scripts/backfill-frame-evidence.ts";
import {
  lookupPrContext,
  prContextRepositoryScope,
  syncPrContexts,
} from "../../workers/telemetry-processor/pr-context-sync.ts";
import { syncPending } from "../../workers/telemetry-processor/github-sync.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const databaseUrl = Deno.env.get("SHERLOCK_TEST_DATABASE_URL")!;
const apiUrl = Deno.env.get("SHERLOCK_TEST_SUPABASE_URL")!;
const key = Deno.env.get("SHERLOCK_TEST_SERVICE_ROLE_KEY")!;
for (const url of [databaseUrl, apiUrl]) {
  assert(new URL(url).hostname === "127.0.0.1", "local services only");
}
const directory = await Deno.makeTempDir({ prefix: "sherlock-pr-context-" });
const workspaceId: string = crypto.randomUUID();
const foreignWorkspaceId: string = crypto.randomUUID();
const sql = postgres(databaseUrl, { max: 2, prepare: false });
const queue = PostgresJobQueue.connect(databaseUrl, 2);
const storage = new SupabaseRawStorage(apiUrl, key);
const processor = new TelemetryProcessor(databaseUrl, storage, 3);
const batches = PostgresBatchRepository.connect(databaseUrl);
const service = new IngestService(
  new SupabaseImmutableStorage(apiUrl, key),
  batches,
);
const receipts: Record<string, unknown>[] = [];
const requests: Record<string, unknown>[] = [];
let failNextUpload = false;
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  async (request) => {
    if (failNextUpload) {
      failNextUpload = false;
      return Response.json({ error: "synthetic temporary outage" }, {
        status: 503,
      });
    }
    requests.push(await request.clone().json());
    const response = await handleRequest(request, {
      environment: (name) =>
        ({
          SHERLOCK_E3_WORKSPACE_ID: workspaceId,
          SHERLOCK_SIXTYFOUR_WORKSPACE_ID: foreignWorkspaceId,
        } as Record<string, string>)[name],
      backendFactory: () => ({ batches, service }),
    });
    if (response.ok) receipts.push(await response.clone().json());
    return response;
  },
);
const endpoint =
  `http://127.0.0.1:${server.addr.port}/functions/v1/sherlock-rollout-ingest`;
const collector = {
  name: "PR context E2E",
  github_id: "pr-context-e2e",
  email: `context-${workspaceId}@e3group.ai`,
  installation_id: crypto.randomUUID(),
  endpoint,
};
const config = `${directory}/collector.json`;
await Deno.writeTextFile(config, JSON.stringify(collector), { mode: 0o600 });
async function python(args: string[]) {
  const result = await new Deno.Command("python3", {
    args,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
      PYTHONPATH: "packages/telemetry-collector/src",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  assert(
    result.success,
    `collector ${args.slice(0, 3).join(" ")}: ${stderr}\n${stdout}`,
  );
  return stdout.trim() ? JSON.parse(stdout) : null;
}
async function cli(
  root: string,
  provider: string,
  args: string[],
) {
  return await python([
    "-m",
    "sherlock_collector.cli",
    "--codex-home",
    `${directory}/synthetic-codex-home`,
    "--claude-home",
    `${directory}/synthetic-claude-home`,
    "--provider",
    provider,
    "--state-root",
    `${root}/state`,
    "--config",
    config,
    ...args,
  ]);
}
async function drain(root: string, provider: string) {
  return await cli(root, provider, ["drain"]);
}
async function pump(expectedFailure?: string) {
  let failures = 0;
  for (let attempts = 0; attempts < 1000; attempts++) {
    const job = await queue.claim("live", "pr-context-e2e", 60) ??
      await queue.claim("backfill", "pr-context-e2e", 60);
    if (!job) {
      const [pending] = await sql.unsafe(
        "select count(*)::int n from processing.telemetry_jobs where workspace_id in ($1,$2) and status in ('queued','leased')",
        [workspaceId, foreignWorkspaceId],
      );
      if (pending.n === 0) {
        assert(
          !expectedFailure || failures === 1,
          "expected one isolated normalization rejection",
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    assert(
      [workspaceId, foreignWorkspaceId].includes(job.workspace_id),
      "another test is using the database queue; serialize suites",
    );
    if (job.job_kind === "normalize") {
      let targets;
      try {
        targets = await processor.normalize(job);
      } catch (error) {
        if (
          !expectedFailure ||
          ((error as { code?: string }).code !== expectedFailure &&
            !String(error).includes(expectedFailure))
        ) {
          throw error;
        }
        failures++;
        await queue.fail(job, expectedFailure, String(error));
        continue;
      }
      await queue.enqueueReductions(targets.map((target) => ({
        workspaceId: target.workspace_id,
        sessionId: target.session_id,
        normalizerVersion: target.normalizer_version,
        activityVersion: target.activity_version,
        targetEventId: target.target_event_id,
        workloadClass: target.workload_class,
      })));
    } else await processor.reduce(job, 60_000);
    assert(await queue.complete(job) !== "fenced", "worker lost lease");
  }
  throw new Error("fixture queue did not drain");
}

const nativeHashes: { path: string; sha256: string }[] = [];
const commitAssociations: Record<string, number> = {};
const base = new Date(Math.floor(Date.now() / 600_000) * 600_000 - 540_000)
  .toISOString();
const scope = prContextRepositoryScope(`${workspaceId}=e3-solutions/sherlock`);
const githubRequests: string[] = [];
const fixtureFetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
  const address = String(url);
  assert(
    /^https:\/\/api.github.com\/repos\/e3-solutions\/sherlock\/pulls\/\d+$/
      .test(address),
    "unexpected GitHub target",
  );
  assert(
    options?.redirect === "manual",
    "GitHub redirects must not forward credentials",
  );
  githubRequests.push(address);
  const number = Number(address.split("/").at(-1));
  if (number === 404) {
    return Response.json({ message: "not found" }, { status: 404 });
  }
  return Response.json({
    number,
    id: number + 1000,
    state: "open",
    merged_at: null,
    closed_at: null,
    base: { repo: { id: 42, full_name: "e3-solutions/sherlock" } },
    head: { ref: "reused-branch", repo: { full_name: "fork-owner/sherlock" } },
  });
}) as typeof fetch;
async function link(
  root: string,
  provider: string,
  nativeId: string,
  number: number,
  eventId = crypto.randomUUID(),
  repository = "e3-solutions/sherlock",
) {
  await cli(root, provider, [
    "pr-context",
    "link",
    "--session-id",
    nativeId,
    "--repository",
    repository,
    "--pr-number",
    String(number),
    "--event-id",
    eventId,
    "--occurred-at",
    base,
  ]);
  return eventId;
}
async function retract(
  root: string,
  provider: string,
  nativeId: string,
  linkId: string,
  eventId = crypto.randomUUID(),
) {
  await cli(root, provider, [
    "pr-context",
    "retract",
    "--session-id",
    nativeId,
    "--link-event-id",
    linkId,
    "--event-id",
    eventId,
    "--occurred-at",
    base,
  ]);
  return eventId;
}
async function native(
  root: string,
  provider: string,
  nativeId: string,
  sha = "",
) {
  nativeHashes.push(
    await python([
      "tests/end-to-end/pr_context_collector.py",
      root,
      provider,
      nativeId,
      base,
      sha,
    ]),
  );
  await drain(root, provider);
  await pump();
}
async function ingest(body: Record<string, unknown>) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert(response.ok, `fixture ingress failed: ${await response.text()}`);
  await pump();
}
// Vary transport identity to exercise audit dedup/conflicts beyond batch replay.
async function ingestNewStream(root: string, stream: string) {
  const pending = `${root}/state/queue/pending`;
  for await (const entry of Deno.readDir(pending)) {
    const envelope = JSON.parse(
      await Deno.readTextFile(`${pending}/${entry.name}`),
    );
    envelope.manifest.source_stream_key = stream.repeat(64);
    await ingest({
      collector,
      manifest: envelope.manifest,
      stored_payload_base64: envelope.stored_payload_base64,
    });
  }
}
async function factCount(disposition?: string) {
  const [row] = await sql.unsafe(
    "select count(*)::int n from telemetry.session_pr_context_events where workspace_id=$1 and ($2::text is null or disposition=$2)",
    [workspaceId, disposition ?? null],
  );
  return row.n;
}

async function counters() {
  const [row] = await sql.unsafe(
    `select
    (select count(*)::int from telemetry.events where workspace_id=$1) events,
    (select count(*)::int from analytics.activity_spans where workspace_id=$1) spans,
    (select jsonb_agg(to_jsonb(s) order by s.id) from telemetry.sessions s where workspace_id=$1) sessions`,
    [workspaceId],
  );
  return JSON.stringify(row);
}
async function dashboard(
  expected: Record<string, [number, string][]>,
  frozenDay?: unknown,
) {
  const result = await new Deno.Command("node", {
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
      SHERLOCK_TEST_DATABASE_URL: databaseUrl,
    },
    args: [
      "tests/end-to-end/pr-context-dashboard.mjs",
      workspaceId,
      JSON.stringify(expected),
      frozenDay ? JSON.stringify(frozenDay) : "",
      JSON.stringify(commitAssociations),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(
    result.success,
    `dashboard: ${new TextDecoder().decode(result.stderr)}`,
  );
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

try {
  for (const id of [workspaceId, foreignWorkspaceId]) {
    await sql.unsafe(
      "insert into telemetry.workspaces (id,slug,name) values ($1,$2,'PR context E2E')",
      [id, `pr-context-${id}`],
    );
  }
  console.log(
    JSON.stringify({ stage: "ready", workspaceId, endpoint, directory }),
  );
  const codex = `${directory}/codex`;
  const claude = `${directory}/claude`;
  const concurrent = `${directory}/concurrent`;
  const codexId = `codex-${workspaceId}`;
  const claudeId = `claude-${workspaceId}`;
  const concurrentId = `concurrent-${workspaceId}`;
  const link91 = await link(codex, "codex", codexId, 91);
  failNextUpload = true;
  const offline = await drain(codex, "codex");
  assert(
    offline.requeued === 1 && offline.uploaded === 0,
    "offline upload must preserve the durable sidecar",
  );
  await drain(codex, "codex");
  await pump();
  const [before] = await sql.unsafe(
    "select (select count(*)::int from telemetry.sessions where workspace_id=$1) sessions,(select count(*)::int from telemetry.events where workspace_id=$1) events,(select count(*)::int from telemetry.session_pr_context_events where workspace_id=$1) facts",
    [workspaceId],
  );
  assert(
    before.sessions === 0 && before.events === 0 && before.facts === 1,
    "context before native telemetry must persist without inventing a session/activity",
  );
  await native(codex, "codex", codexId, "a".repeat(40));
  await native(claude, "claude_code", claudeId);
  await native(concurrent, "codex", concurrentId);
  await proveAndActivateFrameProjection(sql, { workspaceId, activate: true });
  const rows = await sql.unsafe(
    "select id::text,native_session_id from telemetry.sessions where workspace_id=$1",
    [workspaceId],
  );
  const ids = Object.fromEntries(
    rows.map((row) => [String(row.native_session_id), String(row.id)]),
  );
  assert(rows.length === 3, "native sessions missing");
  const commitSync = await syncPending(
    queue,
    "synthetic-token",
    [workspaceId],
    {
      fetcher: (async (url) => {
        assert(
          String(url) ===
            `https://api.github.com/repos/e3-solutions/sherlock/commits/${
              "a".repeat(40)
            }/pulls?per_page=2`,
          "unexpected legacy commit endpoint",
        );
        return Response.json([{
          number: 81,
          state: "open",
          merged_at: null,
          closed_at: null,
          base: { repo: { full_name: "e3-solutions/sherlock" } },
        }]);
      }) as typeof fetch,
    },
  );
  assert(
    commitSync.attempted === 1 && commitSync.failed === 0,
    "legacy commit A sync failed",
  );
  commitAssociations[ids[codexId]] = 81;
  const pendingExpected: Record<string, [number, string][]> = {
    [ids[codexId]]: [[91, "pending"]],
    [ids[claudeId]]: [],
    [ids[concurrentId]]: [],
  };
  const frozen = await dashboard(pendingExpected);
  const baseline = await counters();
  const link92 = await link(codex, "codex", codexId, 92);
  await link(codex, "codex", codexId, 95);
  await link(claude, "claude_code", claudeId, 93);
  await link(`${directory}/wrong-provider`, "claude_code", codexId, 999);
  await link(`${directory}/unknown-session`, "codex", "never-normalized", 998);
  const lateLink = crypto.randomUUID();
  await retract(codex, "codex", codexId, lateLink);
  await link(codex, "codex", codexId, 94, lateLink);
  await link(codex, "codex", codexId, 404);
  await link(
    codex,
    "codex",
    codexId,
    1,
    crypto.randomUUID(),
    "private-owner/restricted",
  );
  await drain(codex, "codex");
  await drain(claude, "claude_code");
  await drain(`${directory}/wrong-provider`, "claude_code");
  await drain(`${directory}/unknown-session`, "codex");
  await pump();
  assert(
    await counters() === baseline,
    "context changed activity, tokens, or session metadata",
  );
  await syncPrContexts(queue, "synthetic-token", [workspaceId], scope, {
    fetcher: fixtureFetch,
  });
  assert(
    (await queue.pendingPrContexts(100, [workspaceId])).length === 0,
    "fresh identity outcomes must honor their retry cooldown",
  );
  assert(
    !githubRequests.some((url) => url.includes("private-owner")),
    "out-of-scope repository leaked to broad token",
  );
  assert(
    !githubRequests.some((url) => url.endsWith("/94")),
    "retraction arriving before its link must suppress verification",
  );
  const expected: Record<string, [number, string][]> = {
    [ids[codexId]]: [
      [91, "checked"],
      [92, "checked"],
      [95, "checked"],
      [404, "inaccessible"],
      [1, "out_of_scope"],
    ],
    [ids[claudeId]]: [[93, "checked"]],
    [ids[concurrentId]]: [],
  };
  const checkedSnapshot = await dashboard(expected);
  const checkedExpected = structuredClone(expected);
  await dashboard(pendingExpected, frozen.day);
  const replay = requests.find((request) =>
    (request.manifest as Record<string, unknown>).source_kind === "collector"
  )!;
  const beforeReplay = await factCount();
  await ingest(replay);
  assert(await factCount() === beforeReplay, "replay duplicated facts");
  const duplicate = structuredClone(replay);
  (duplicate.manifest as Record<string, unknown>).source_stream_key = "d"
    .repeat(64);
  await ingest(duplicate);
  assert(
    await factCount("duplicate") === 1,
    "duplicate lost its source provenance",
  );
  const foreign = structuredClone(replay);
  (foreign.collector as Record<string, unknown>).email =
    `context-${workspaceId}@sixtyfour.ai`;
  await ingest(foreign);
  const [foreignCounts] = await sql.unsafe(
    "select (select count(*)::int from telemetry.sessions where workspace_id=$1) sessions,(select count(*)::int from telemetry.session_pr_context_events where workspace_id=$1) facts",
    [foreignWorkspaceId],
  );
  assert(
    foreignCounts.sessions === 0 && foreignCounts.facts === 1,
    "context crossed workspace boundary",
  );
  const outside = await syncPrContexts(
    queue,
    "synthetic-token",
    [foreignWorkspaceId],
    scope,
    { fetcher: fixtureFetch },
  );
  assert(
    outside.attempted === 0,
    "foreign workspace used scoped GitHub credential",
  );

  const [claudeLink] = await sql.unsafe(
    "select source_record_id::text from telemetry.session_pr_context_events where workspace_id=$1 and pull_request_number=93",
    [workspaceId],
  );
  const identityTarget = {
    workspaceId,
    sourceRecordId: String(claudeLink.source_record_id),
    repositoryFullName: "e3-solutions/sherlock",
    pullRequestNumber: 93,
  };
  // Canonical names can stay unchanged while stable GitHub IDs drift.
  // The transaction fence must reject both repository and PR identity reuse.
  for (const [repositoryId, pullRequestId] of [[43, 1093], [42, 1094]]) {
    const verification = await lookupPrContext(
      identityTarget,
      "synthetic-token",
      scope,
      () =>
        Promise.resolve(Response.json({
          number: 93,
          id: pullRequestId,
          state: "open",
          merged_at: null,
          closed_at: null,
          base: {
            repo: { id: repositoryId, full_name: "e3-solutions/sherlock" },
          },
        })),
    );
    assert(
      verification.outcome === "checked",
      "canonical response must reach the identity fence",
    );
    await queue.appendPrContextVerification(verification);
    await dashboard(checkedExpected, checkedSnapshot.day);
    expected[ids[claudeId]] = [[93, "identity_mismatch"]];
    await dashboard(expected);
  }

  const conflictRoot = `${directory}/conflict`;
  await link(conflictRoot, "codex", codexId, 96, link92);
  await ingestNewStream(conflictRoot, "e");
  assert(
    await factCount("conflict") === 1,
    "conflicting identity lost its audit fact",
  );
  await dashboard(checkedExpected, checkedSnapshot.day);
  expected[ids[codexId]] = expected[ids[codexId]].filter(([number]) =>
    number !== 92
  );
  await dashboard(expected);
  const retract91 = await retract(codex, "codex", codexId, link91);
  await drain(codex, "codex");
  await pump();
  expected[ids[codexId]] = expected[ids[codexId]].filter(([number]) =>
    number !== 91
  );
  const retractedSnapshot = await dashboard(expected);
  await dashboard(pendingExpected, frozen.day);
  const [link404] = await sql.unsafe(
    "select event_id::text from telemetry.session_pr_context_events where workspace_id=$1 and pull_request_number=404",
    [workspaceId],
  );
  const conflictRetractRoot = `${directory}/conflict-retract`;
  await retract(
    conflictRetractRoot,
    "codex",
    codexId,
    String(link404.event_id),
    retract91,
  );
  await ingestNewStream(conflictRetractRoot, "f");
  await dashboard(expected, retractedSnapshot.day);
  expected[ids[codexId]] = expected[ids[codexId]].filter(([number]) =>
    number !== 404
  );
  await dashboard(expected);
  assert(
    await counters() === baseline,
    "retraction changed native facts or activity",
  );
  // Legacy session uniqueness omits provider. Fail closed before any native
  // mutation; never merge a Claude session into an existing Codex session.
  const collision = `${directory}/collision`;
  nativeHashes.push(
    await python([
      "tests/end-to-end/pr_context_collector.py",
      collision,
      "claude_code",
      codexId,
      base,
      "",
    ]),
  );
  await drain(collision, "claude_code");
  await pump("native_session_provider_conflict");
  assert(
    await counters() === baseline,
    "cross-provider collision mutated native session or activity",
  );
  for (const raw of nativeHashes) {
    assert(
      await sha256Hex(await Deno.readFile(raw.path)) === raw.sha256,
      "native transcript bytes changed",
    );
  }
  for (const receipt of receipts) {
    assert(
      await sha256Hex(
        await storage.download(
          String(receipt.storage_path),
          Number(receipt.stored_byte_count),
        ),
      ) === receipt.stored_sha256,
      "immutable Storage bytes changed",
    );
  }
  console.log(
    JSON.stringify({
      passed: true,
      workspaceId,
      directory,
      sessions: 3,
      receipts: receipts.length,
      githubRequests: githubRequests.length,
      scenarios: [
        "Codex and Claude",
        "link before session",
        "PR after work starts",
        "review without commits",
        "SHA A explicit B",
        "shared checkout isolation",
        "multiple PRs",
        "wrong provider and missing session",
        "late/out-of-order retraction",
        "offline retry",
        "replay",
        "inaccessible/identity drift/scope",
        "old snapshot visibility",
        "unchanged native/Storage bytes and activity",
      ],
      githubTransport: "deterministic boundary fixtures",
    }),
  );
} finally {
  await server.shutdown();
  await batches.close();
  await processor.close();
  await queue.close();
  await sql.end({ timeout: 5 });
}
