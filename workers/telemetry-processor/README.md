# Telemetry processor operations

The worker keeps immutable ingest facts unchanged and acknowledges queue work
only through fenced leases. A backlog is durable work, not a reason to bypass
the rollout, connection, or shutdown gates below.

## Connection and scheduling contract

- One active replica owns an environment-and-service advisory lock.
- The control pool has four sessions. The pinned handoff lock consumes one,
  leaving three for claims, heartbeats, and the reaper.
- The shared processing pool has six sessions. Normalizer, reducer, and frame
  projection adapters borrow from it and do not close it.
- An active replica can therefore use at most 10 sessions. A compatible
  replacement opens exactly one control session before handoff, so the maximum
  rolling overlap is 11 sessions.
- Replica scaling remains disabled. Concurrency is six; overload mode reserves
  five normalization lanes and one reduction lane, permits borrowing when the
  preferred kind is empty, and pauses new backfill claims until live lag exits
  hysteresis.

Before starting or replacing the worker, require zero active blocked database
waiters and enough measured headroom that the current total plus the sessions
the operation adds remains at or below 80% of `max_connections`. A cold start
adds up to 10; a compatible replacement adds one during handoff. Do not raise
concurrency, pool sizes, or replica count without a measured load test proving
arrival rate is below sustained completion rate and the same connection gate
continues to hold.

The capacity circuit opens only for PostgreSQL `53300` and pool `EMAX*`
conditions. It stops claims for a jittered 30–120 seconds and permits one
half-open claim. Processing errors, control-query errors, and heartbeat errors
all reopen the same circuit; ordinary job failures continue through fenced retry
handling.

Set `SHERLOCK_GITHUB_WORKSPACE_IDS` to a comma-separated workspace UUID
allowlist. Adding a workspace enables its backfill and live lookup without a
code deploy. Set `GITHUB_TOKEN` to a fine-grained token with pull-request read
access to enable sync; startup rejects a token without an allowlist. Repository
changes fail closed, terminal matches are rechecked every six hours, and auth or
rate-limit pauses are logged without creating pair failures. Sync runs each
minute while backlogged, otherwise every five minutes.

## First rollout and rollback

The first rollout of this protocol is **not rolling-safe**, because the old
worker does not take the handoff lock. To free connection headroom before any
schema work or replacement startup:

1. Scale the old worker to zero or otherwise stop it cold.
2. Verify the old process has exited and no unexpired lease is still executing.
   Leave queued jobs and immutable ingest rows intact; expired leases recover.
3. Apply the additive scheduler and dashboard-freshness migrations and verify
   their database tests.
4. Verify the connection gate, deploy the new worker at exactly one replica, and
   confirm it owns the handoff before processing begins.

For exact PR links, keep `GITHUB_TOKEN` unset and apply all migrations through
`20260826182052_add_exact_session_pull_request_sources.sql` before step 4. Then
set the CodeActivity-only allowlist and run
`deno run --allow-env --allow-net scripts/backfill-session-scm.ts`, wait for the
replayed jobs to finish, and enable the token. The restart-safe replay uses the
same allowlist and is limited to the dashboard's 26-hour database-received
evidence window.

Rollback to code without this protocol has the same constraint: stop the new
worker completely, wait for it to exit, then start one old replica. Never run
old and new implementations concurrently, and never delete or reset queue,
raw-ingest, event, receipt, or revision facts as part of rollout or rollback.

After every rollout, verify no worker restart or terminal-failure spike, no
persistent blocked waiter, total connections inside the gate, reduction
progress, and a non-positive live-normalization backlog slope. A compatible
new-to-new replacement may use Railway's zero-overlap deployment because the
advisory lock serializes ownership; `drainingSeconds = 120` allows active leases
to finish before process termination.
