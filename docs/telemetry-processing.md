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

## Rebuild invalidation

The worker enqueues reductions in the same transaction as normalization. A
session needs rebuilding only when that transaction inserts new event facts or
changes its session metadata. Parent discovery also invalidates exactly the
children returned by the update that repairs previously unresolved parent
links. Ordinary parent batches never enumerate all previously linked children.
Identical normalization retries enqueue nothing; an enqueue failure rolls back
normalization and parent repair so a retry cannot lose the invalidation. Real
metadata changes still enqueue at an unchanged event cutoff. Existing queue
request generations continue fencing changes that arrive during a reduction.

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

Each dashboard warms two client connections before serving. Shared Supabase
pooler URLs use transaction mode, so these clients do not retain two PostgreSQL
backends while idle; worker connections remain in session mode.
Before every claim, the worker uses its pinned handoff session to read
PostgreSQL's usable limit plus live worker/dashboard client counts. It budgets
the worker's full seven-session rolling envelope and an eight-session dashboard
envelope covering both live dashboards plus simultaneous replacements, without
double-reserving sessions the dashboards already own. Conflicting database URL
`application_name` parameters are stripped. Supavisor may expose pooler-owned
backend labels instead of client labels, so the envelope remains conservative;
the global PostgreSQL budget is not proof of a Supavisor per-role pool limit.
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

The Codex v3 change is forward-only. New uploads are normalized once with v3,
including uploads from existing sessions; existing jobs and facts are unchanged.
Known runtime envelopes are excluded from human prompts. No collector update or
historical normalization replay is required.

1. Deploy the v3-capable worker and dashboard together. The worker produces only
   frame v5, selecting existing legacy facts alongside new v3 facts. The dashboard
   retains old snapshot readers and serves v4 until v5 is activated.
2. Run `scripts/backfill-frame-evidence.ts --workspace <uuid> --activate` with
   `SUPABASE_DB_URL` to project the current 26-hour window from **already normalized
   facts**. This is the existing projection handoff, not a raw-data replay or
   historical classification repair. Activation requires complete normalization
   and matching receipts covering 25 hours (the dashboard serves 24 hours).
   The 26-hour projection leaves room for live receipts to advance during handoff.
   Coordinate steps 1–2: v4 stops refreshing
   when the new worker starts and remains stale until activation completes.
3. Apply `20260915154051_codex_v3_runtime_classification.sql`. It replaces routing
   in the existing trigger so each newly committed Codex batch gets one v3 job.
   Claude retains its existing normalizer. Existing v1/v2 jobs drain unchanged.
4. Send a new human prompt and verify it appears once; verify a known runtime
   continuation appears as activity but contributes zero new human prompts.

Old false-positive counts remain as recorded. The normalizer keeps v1/v2 support
for previously queued jobs and reproducibility; it does not continually produce
those versions for new uploads.

Rollback requires a coordinated worker/reader release that still accepts v3 facts
and queued jobs. Do not deploy a v2-only worker after enabling v3 routing, delete
activation facts, rewrite old events, or reactivate v4 as a live view of v3 data.
Preserve issued snapshot support and all raw and derived history.

## Oversized native records

The ingest function and worker use the existing v1 fragment contract. A complete
Codex rollout or Claude transcript JSONL record over 16 MiB, including records
above 100 MiB, is transported as deterministic 4 MiB v1 fragments using the
fragment columns already present on `telemetry.native_records`. Each fragment
remains an immutable, independently verifiable raw fact. The normalizer emits a
bounded `unknown/native_fragment` coverage event instead of parsing a partial
JSON document, so the oversized record itself does not create product activity
while later records in the same stream continue normally. The complete raw
record remains reconstructable from its ordered fragments and full-record hash.

Fragment publication resumes across capture runs. The durable cursor stays at
the logical record start until all fragments are queued, while `pending_fragment`
stores its exact range/hash, canonical count, and next index. Each run streams
the original bytes again, rejects a changed pending range/hash, and stages only
the fragments selected for that run. Scratch disk usage is bounded by the
capture byte budget; hashing I/O still covers the whole native record. Hook
budgets may exceed the remaining budget by one 4 MiB fragment; reconcile uses a
strict budget (at least 4 MiB is needed to progress a non-final fragment).
A crash replays deterministic fragment keys without changing immutable bytes.
The reconciliation ledger reports `native_record_fragmentation_in_progress`
and `fragment_progress`; local capture is not complete until the logical cursor
advances. Unterminated records remain deferred without publishing fragments.

Deploy the relaxed ingest validator before this collector runtime: older ingest
rejects a logical range above 100 MiB even though each fragment fits its object
limits. Existing collectors, receipts, fragment schema, and worker projection
remain compatible; no migration or worker version change is required. Cursor
entries keep the legacy shape; `pending_fragment` and `recovery_reason` live in
a separate `stream_extensions` map that older runtimes ignore, so a collector
rollback keeps reading its cursors (a partial record restarts from fragment 0
with the same deterministic keys). Do not delete cursor/queue state to roll back. Also drain queued >100 MiB logical-record fragments before
returning to an older runtime: its spool validator rejects those ranges.
Product text, metadata parsing, incomplete-tail retention, and
inventory inspection limits are independent of transport fragmentation.

Official collectors upload each stream in generation and source-offset order.
The worker additionally blocks a committed later range while an earlier
committed range is queued or leased, but it cannot infer a predecessor that has
not reached ingest. Direct producers must therefore preserve the same per-stream
upload order; concurrency remains available across independent streams.

Rolling collectors back stops new fragments. Rolling the server back first can
reject already-spooled fragments; collectors retain that head and block only
its stream rather than discarding raw telemetry, so server-first deployment and
collector-first rollback are required.

## Codex v4 usage rollout and optional backfill

Deploy the v4-capable ingest normalizer, worker and dashboard readers before
applying `20261028213100_codex_v4_native_usage.sql`. New Codex batches then get
one v4 normalization job, including continued old sessions. Existing jobs drain
at their original versions. Claude routing is unchanged. No raw-data rewrite,
collector change, frame-version activation, or automatic historical replay is
required. Frame v5 accepts v4 because its message/activity interpretation is
identical to v3; usage observations never create frame evidence. Existing raw
snapshot tokens keep their original source universe; new raw tokens v7 include
v4 facts.

Historical v3 `token_usage_record` facts remain `unknown` until explicitly
reprocessed. To recover native-only historical sessions or remove input/cache
component uncertainty at a v3/v4 cumulative boundary, an operator can queue all
Codex batches for a reviewed **complete session**, with the three identity
parameters set in psql. This appends v4 facts linked to the same source records;
it never modifies receipts, locators, raw bytes, or old event facts. Do not
reprocess only the reporting window: older counter baselines/model context and
response duplicates may lie outside it.

```sql
-- Owner/admin, after deploying v4 support. Use a reviewed workspace, collector,
-- and native session identity; run in bounded session batches as backfill work.
insert into processing.telemetry_jobs (
  workspace_id, job_kind, batch_id, normalizer_version, workload_class
)
select batch.workspace_id, 'normalize', batch.id,
       'sherlock.codex-rollout.v4', 'backfill'
from telemetry.ingest_batches batch
where batch.workspace_id = :'workspace_id'::uuid
  and batch.collector_key = :'collector_key'
  and batch.observed_native_session_id = :'native_session_id'
  and batch.source_provider = 'codex'
on conflict (workspace_id, batch_id, normalizer_version)
  where job_kind = 'normalize' do nothing;
```

Observe queued/leased/failed jobs with the queries above. Completed v4 jobs need
no repeat; use the existing reviewed failed-job recovery procedure for failures.
After the queue drains, compare `coverage` and `query_usage` for the bounded
window. A session containing any valid non-replay token-count usage still uses
that stream exclusively; a mixed or incomplete counter session does not switch
to response increments to hide missing baselines. Native-only sessions use
response IDs to deduplicate increments across duplicates and reuploaded ranges.
Both facts remain available for audit. Rollback must keep v4 job/read support;
do not replace the worker with a v3-only binary after routing is enabled.
