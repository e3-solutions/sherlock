# Asynchronous telemetry processing

Sherlock acknowledges uploads after the immutable Storage object, ingest batch,
native-record locators, and one processing job are durable. Normalization,
activity reduction, and frame projection run in the Railway worker and are not
part of receipt latency.

## Data flow

1. `sherlock-rollout-ingest` validates the provider/kind contract, compressed
   bytes, decompressed source, and every record hash. Hosted Edge Function
   connections use Supabase transaction pooling on port 6543 with one client
   per isolate; hosted direct URLs fail closed, and the persistent Railway
   worker continues to use session pooling.
2. It creates the immutable object with overwrite disabled.
3. One Postgres transaction inserts `telemetry.ingest_batches` and
   `telemetry.native_records`. An `AFTER INSERT` trigger creates exactly one
   `processing.telemetry_jobs` row in the same transaction.
4. The existing committed receipt returns immediately.
5. Railway claims a job with `FOR UPDATE SKIP LOCKED`, a visibility deadline,
   and a random fencing token. It downloads the object directly from Supabase,
   revalidates it, and runs the idempotent provider-specific normalizer. A
   successful normalization upserts one dirty cutoff per affected session into
   the same queue. Duplicate and concurrent batches therefore coalesce before
   Railway reduces only those targeted sessions. The same coalesced reduce job
   then projects the session into append-only frame receipts and evidence
   revisions before the fenced job may complete.
6. PostgreSQL fills the generated message `tsvector` and GIN index when the
   normalized event rows are inserted. There is no separate search worker.

Claude Code transcripts and terminal-hook observations remain distinct raw
sources. Transcript batches use `claude_code/transcript`; exact Stop,
SubagentStop, and SessionEnd observations use `claude_code/hook`. Both are
interpreted by the Claude normalizer, while the immutable source bytes and
provider/kind facts remain separate and auditable. Only an anchored Stop or
SubagentStop projects a completed turn.

`processing` is private mutable operational state. Immutable receipts and
record locators stay in `telemetry`; rebuildable product projections stay in
`analytics`.

Frame projection retries compare a deterministic source-state fingerprint and
append only real changes. A lower-ID late commit or repaired child parent can
therefore append a correction at the same maximum event cutoff. Projection
receipts preserve their half-open covered window, the maximum ID and exact
count of all committed non-replay events for accepted frame normalizer
versions, the observed session `updated_at`, and consumed request generation.
Their source-state SHA-256 fingerprints the bounded selected evidence and
effective session state. Evidence revisions contain selection and display metadata only; excerpts stay
normalized event facts and complete text stays in private Storage. Because the
stored actor role is effective, normalization must enqueue every child whose
previously unresolved parent is repaired.

## Scheduling and backpressure

The normal collector remains unchanged and defaults to automatic scheduling.
Historical uploaders send `x-sherlock-workload-class: backfill`; this does not
change the batch body. Legacy batches without the header are conservatively
classified by source time (older than 24 hours is backfill, otherwise live).
The default four-job worker keeps three slots exclusively available to live
work and one backfill slot; live work may borrow the backfill slot, never the
reverse. Concurrency and database pools are bounded, session reductions have a
retryable deadline, and dirty cutoffs coalesce. There is no workspace-wide
session scan or permanent record or session ceiling.

Frame projection uses the existing per-session reduce job and advisory-lock
boundary rather than a bucket queue. Workspace/anchor-time and
person/session-time indexes serve timeline and detail reads; the projector
diffs revisions through a session/anchor-time rolling-window index. Its narrow
role can read normalized
sessions/events plus only the record-adjacency, native-type, collector, stream,
and generation columns required to reproduce canonical representation pairing.
It cannot read source hashes or Storage paths.

## Run locally

Apply the migrations to a disposable Postgres/Supabase stack, then run:

```sh
SUPABASE_DB_URL=... \
SUPABASE_URL=https://PROJECT.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... \
deno run --allow-env --allow-net workers/telemetry-processor/main.ts
```

Optional settings include `SHERLOCK_WORKER_CONCURRENCY` (default `4`),
`SHERLOCK_WORKER_LIVE_RESERVED` (default `3`),
`SHERLOCK_WORKER_NORMALIZE_RESERVED` (default `3`),
`SHERLOCK_WORKER_DASHBOARD_RESERVED_CONNECTIONS` (default and minimum `8`),
`SHERLOCK_WORKER_LEASE_SECONDS` (default `120`),
`SHERLOCK_WORKER_POLL_MS` (default `250`), and retry base/max seconds
(defaults `5`/`300`). Storage reads time out after 30 seconds and targeted
reductions after 60 seconds; override them with
`SHERLOCK_WORKER_STORAGE_TIMEOUT_SECONDS` and
`SHERLOCK_WORKER_REDUCTION_TIMEOUT_SECONDS`. Secrets are server-only and never
belong in the collector.

Run focused tests with:

```sh
deno check workers/telemetry-processor/main.ts
deno test workers/telemetry-processor
SHERLOCK_TEST_DATABASE_URL=... deno test --allow-env --allow-net \
  workers/telemetry-processor/queue_integration_test.ts
```

## Railway deployment

Create one private worker service from the repository root. The checked-in
`railway.toml` fixes the Dockerfile path to
`workers/telemetry-processor/Dockerfile`; do not set the service root to the
worker subdirectory because it imports reducer and normalizer code from
`supabase/`. Configure the three required Supabase variables, expose no public
domain, keep replicas at one initially, and scale replicas only after checking
database pool headroom. Multiple replicas are safe because claims use row
locks and every completion/retry is fenced by the active lease token.

`SUPABASE_DB_URL` must use the dedicated `sherlock_worker_login`, not the
`postgres` owner. The login has `NOINHERIT` and can assume only
`sherlock_processor`, `sherlock_normalizer`, `sherlock_reducer`, and
`sherlock_frame_projector`; each transaction explicitly selects the narrow
role it needs. The projector may append receipts and revisions but cannot
update or delete them or activate a version. Set or rotate its password out of
band and store it only as a sealed Railway variable. Prefer
Supabase's session pooler on port 5432 so Railway does not depend on the direct
database host's IPv6-only DNS record. Store a current Supabase secret key in
`SUPABASE_SERVICE_ROLE_KEY`; the variable name is retained for compatibility,
but a legacy service-role JWT is not required.

Each dashboard opens and retains two labeled database sessions before serving.
Before every claim, the worker uses its pinned handoff session to read
PostgreSQL's usable limit plus live worker/dashboard client counts. It budgets
the worker's full seven-session rolling envelope and an eight-session dashboard
envelope covering both live dashboards plus simultaneous replacements, without
double-reserving sessions the dashboards already own. Conflicting database URL
`application_name` parameters are stripped so labels remain authoritative.
PostgreSQL connection-limit errors still open the jittered circuit while active
jobs finish, and one half-open probe determines whether normal admission can
resume.

## Inspect and recover

Queue health and terminal failures are visible without reading raw content:

```sql
select workload_class, job_kind, status, count(*) as jobs,
       min(available_at) as oldest_available
from processing.telemetry_jobs
group by workload_class, job_kind, status
order by workload_class, job_kind, status;

select id, workspace_id, job_kind, batch_id, session_id, target_event_id,
       attempt_count, attempt_limit,
       last_error_code, last_error, last_failed_at, completed_at
from processing.telemetry_jobs
where status = 'failed'
order by completed_at desc;
```

Using an owner/admin connection, inspect `last_error_*`, then retry one reviewed
terminal failure without deleting its history. Verify that exactly one row was
updated; the retained error fields preserve the previous failure reason.

```sql
update processing.telemetry_jobs
set status = 'queued', available_at = now(), attempt_count = 0,
    lease_token = null, lease_owner = null, lease_started_at = null,
    lease_expires_at = null, completed_at = null,
    requeue_count = requeue_count + 1, updated_at = now()
where id = :job_id and status = 'failed';
```

Caught failures use capped exponential backoff. A crash leaves the lease to
expire; another worker reclaims it. A crash on the last allowed attempt is
terminalized by the worker reaper. Normalization uniqueness, targeted reducer
locks, same-cutoff correction rows, and lease fencing make duplicate delivery
safe.

## Deploy and rollback order

1. Deploy the version-aware worker first. It treats legacy normalize jobs whose
   target version is still null as that provider's v1, so it is safe before and
   after the queue migration. Existing v1 events and raw batches stay immutable.
2. Apply the additive queue and cutover migrations. Each workspace records the
   first Codex v2 job time as its immutable session boundary. Do not enqueue
   historical Codex batches: pre-cutover sessions remain on v1 and later
   sessions use v2. During the already-started transition, a pre-cutover
   session may use an existing v2 record only when no v1 fact exists for that
   source record; this closes the live gap without replaying it.
3. Project the current 26-hour window into frame v4. In one repeatable-read
   owner transaction, prove
   each latest receipt exactly matches the session's accepted-version event
   maximum, event count, and `updated_at`, then insert the one
   workspace/version activation fact. The worker cannot self-activate.
4. Enable the dashboard's versioned projection path. Existing v1 snapshot
   tokens continue on the raw path for their bounded lifetime.
5. Upload a smoke batch and verify v2 normalized message origins, search,
   activity spans, frame receipts, revisions, and indexed frame reads.

For application rollback, stop minting projection-backed tokens before rolling
the worker back, then let all queued or leased jobs drain and review or requeue
terminal failures. An activation row is an immutable capability fact, not a
mutable on/off flag: the reader checks whether the exact workspace/version row
exists, and rollback does not delete it. A dashboard version that retains the v2
reader must continue honoring already-issued v2 tokens until their normal
25-hour expiry; a dashboard rollback that removes v2 support must reject those
tokens explicitly instead of falling back to raw reads. Keep the migration,
queue history, raw objects, normalized events, activity revisions, and frame
projection history. Never delete frame receipts or revisions to roll back a
reader. Because
the old full-scan Cron remains disabled, stopping Railway also intentionally
disables automatic activity reduction; this is a degraded emergency mode, not
a steady state. Do not stop Railway with backlog present, delete queue/raw rows,
or re-enable the full-workspace Cron as a permanent design.

## Oversized native records

Deploy the ingest function and Railway worker before collectors that can emit
fragments. A Codex rollout or Claude transcript JSONL record over 16 MiB and up
to 100 MiB is transported as deterministic 4 MiB v1 fragments using the
fragment columns already present on `telemetry.native_records`. Each fragment
remains an immutable, independently verifiable raw fact. The normalizer emits a
bounded `unknown/native_fragment` coverage event instead of parsing a partial
JSON document, so the oversized record itself does not create product activity
while later records in the same stream continue normally. The complete raw
record remains reconstructable from its ordered fragments and full-record hash.

The collector's synchronous byte budget may be exceeded by one logical record:
all fragments of that record are published durably before its cursor advances.
This keeps crash replay stateless and idempotent at the cost of one bounded
100 MiB worst-case capture.

Official collectors upload each stream in generation and source-offset order.
The worker additionally blocks a committed later range while an earlier
committed range is queued or leased, but it cannot infer a predecessor that has
not reached ingest. Direct producers must therefore preserve the same per-stream
upload order; concurrency remains available across independent streams.

Rolling collectors back stops new fragments. Rolling the server back first can
reject already-spooled fragments; collectors retain that head and block only
its stream rather than discarding raw telemetry, so server-first deployment and
collector-first rollback are required.
