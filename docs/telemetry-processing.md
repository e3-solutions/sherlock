# Asynchronous telemetry processing

Sherlock acknowledges uploads after the immutable Storage object, ingest batch,
native-record locators, and one processing job are durable. Normalization and
activity reduction run in the Railway worker and are not part of receipt
latency.

## Data flow

1. `sherlock-rollout-ingest` validates the compressed bytes, decompressed
   source, and every record hash.
2. It creates the immutable object with overwrite disabled.
3. One Postgres transaction inserts `telemetry.ingest_batches` and
   `telemetry.native_records`. An `AFTER INSERT` trigger creates exactly one
   `processing.telemetry_jobs` row in the same transaction.
4. The existing committed receipt returns immediately.
5. Railway claims a job with `FOR UPDATE SKIP LOCKED`, a visibility deadline,
   and a random fencing token. It downloads the object directly from Supabase,
   revalidates it, and runs the idempotent normalizer. A successful
   normalization upserts one dirty cutoff per affected session into the same
   queue. Duplicate and concurrent batches therefore coalesce before Railway
   reduces only those targeted sessions.
6. PostgreSQL fills the generated message `tsvector` and GIN index when the
   normalized event rows are inserted. There is no separate search worker.

`processing` is private mutable operational state. Immutable receipts and
record locators stay in `telemetry`; rebuildable product projections stay in
`analytics`.

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

## Run locally

Apply the migrations to a disposable Postgres/Supabase stack, then run:

```sh
SUPABASE_DB_URL=... \
SUPABASE_URL=https://PROJECT.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... \
deno run --allow-env --allow-net workers/telemetry-processor/main.ts
```

Optional settings are `SHERLOCK_WORKER_CONCURRENCY` (default `4`),
`SHERLOCK_WORKER_LIVE_RESERVED` (default `3`),
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
`sherlock_processor`, `sherlock_normalizer`, and `sherlock_reducer`; each
transaction explicitly selects the narrow role it needs. Set or rotate its
password out of band and store it only as a sealed Railway variable. Prefer
Supabase's session pooler on port 5432 so Railway does not depend on the direct
database host's IPv6-only DNS record. Store a current Supabase secret key in
`SUPABASE_SERVICE_ROLE_KEY`; the variable name is retained for compatibility,
but a legacy service-role JWT is not required.

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

1. Apply database migrations, including the already-hosted Cron migrations and
   the later async migration. The async migration creates the queue trigger and
   unschedules the full-workspace Cron.
2. Deploy Railway with the required secrets and verify it stays healthy.
3. Deploy the async ingest function, upload a smoke batch, and verify events,
   search, and targeted spans.
4. Disable the superseded reducer Edge Function after Railway verification.

For application rollback, first redeploy the previous synchronous ingest while
Railway remains running, then let all queued/leased jobs drain and review or
requeue terminal failures. Only then may Railway be stopped. Keep the migration,
queue history, raw objects, normalized events, and activity revisions. Because
the old full-scan Cron remains disabled, stopping Railway also intentionally
disables automatic activity reduction; this is a degraded emergency mode, not
a steady state. Do not stop Railway with backlog present, delete queue/raw rows,
or re-enable the full-workspace Cron as a permanent design.

## Oversized rollout records

Deploy the ingest function and Railway worker before collectors that can emit
fragments. A rollout JSONL record over 16 MiB and up to 100 MiB is transported
as deterministic 4 MiB v1 fragments using the fragment columns already present
on `telemetry.native_records`. Each fragment remains an immutable, independently
verifiable raw fact. The normalizer emits a bounded `unknown/native_fragment`
coverage event instead of parsing a partial JSON document, so the oversized
record itself does not create product activity while later records in the same
stream continue normally. The complete raw record remains reconstructable from
its ordered fragments and full-record hash.

The collector's synchronous byte budget may be exceeded by one logical record:
all fragments of that record are published durably before its cursor advances.
This keeps crash replay stateless and idempotent at the cost of one bounded
100 MiB worst-case capture.

Rolling collectors back stops new fragments. Rolling the server back first can
reject already-spooled fragments; collectors retain that head and block only
its stream rather than discarding raw telemetry, so server-first deployment and
collector-first rollback are required.
