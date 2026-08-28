# Telemetry processor operations

The worker keeps immutable ingest facts unchanged and acknowledges queue work
only through fenced leases. A backlog is durable work, not a reason to bypass
the rollout, connection, or shutdown gates below.

## Connection and scheduling contract

- One active replica owns an environment-and-service advisory lock.
- The control pool has two sessions. The pinned handoff lock consumes one,
  leaving one for claims, heartbeats, and the reaper.
- The shared processing pool has four sessions. Normalizer, reducer, and frame
  projection adapters borrow from it and do not close it.
- When GitHub sync is enabled, its database reads use one separately labeled
  session. Slow or blocked SCM reads cannot consume the remaining control
  session used by claims, lease heartbeats, completions, and the reaper.
- An active replica can therefore use at most seven sessions with GitHub sync
  enabled, or six without it. A compatible replacement opens exactly one control
  session before handoff, so the maximum rolling overlap is eight or seven
  sessions respectively.
- Before each claim, the worker measures PostgreSQL's usable connection limit,
  live client count, labeled worker sessions, and labeled dashboard sessions on
  the pinned handoff connection. It budgets the worker's conditional
  eight-session rolling envelope and preserves an eight-slot dashboard envelope:
  four owned by the live dashboards and four for their simultaneous
  replacements. Set `SHERLOCK_WORKER_DASHBOARD_RESERVED_CONNECTIONS` higher when
  adding readers; startup rejects values below eight. URL `application_name`
  parameters are discarded so deployment configuration cannot override these
  labels.
- Replica scaling remains disabled. Concurrency is four; overload mode reserves
  three normalization lanes and one reduction lane, permits borrowing when the
  preferred kind is empty, and pauses new backfill claims until live lag exits
  hysteresis.
- The queue-control loop updates an in-process progress watchdog every polling
  pass. If a control query remains wedged for 60 seconds, the worker emits
  `worker_progress_stalled` and exits non-zero so Railway's `ON_FAILURE` policy
  replaces the single replica. Set `SHERLOCK_WORKER_CONTROL_STALL_SECONDS` only
  above both 30 seconds and four polling intervals; job processing and the
  isolated GitHub task do not block this watchdog.

Before starting or replacing the worker, require zero active blocked database
waiters and enough measured headroom that the current total plus the sessions
the operation adds remains at or below 80% of `max_connections`. With GitHub
sync enabled, a cold start adds up to seven sessions and a compatible
replacement adds one during handoff; without GitHub sync those limits are six
and one. Do not raise concurrency, pool sizes, or replica count without a
measured load test proving arrival rate is below sustained completion rate and
the same connection gate continues to hold.

The capacity circuit opens only for PostgreSQL `53300` and pool `EMAX*`
conditions. It stops claims for a jittered 30–120 seconds and permits one
half-open claim. Processing errors, control-query errors, and heartbeat errors
all reopen the same circuit; ordinary job failures continue through fenced retry
handling.

Set `SHERLOCK_GITHUB_WORKSPACE_IDS` to a comma-separated workspace UUID
allowlist. Live lookup uses it immediately; rerun the manual backfill after
adding a workspace. Set `GITHUB_TOKEN` to a fine-grained token with pull-request
read access to enable sync; startup rejects a token without an allowlist. The
dedicated sync pool is fixed at one connection and is included in admission
accounting and shutdown. Repository changes fail closed, terminal matches are
rechecked every six hours, and auth or rate-limit pauses are logged without
creating pair failures. Sync runs each minute while backlogged, otherwise every
five minutes. Database failures retry from failure completion with exponential
backoff capped at fifteen minutes.

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
