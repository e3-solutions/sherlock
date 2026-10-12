# Dashboard session reads

Interval and conversation reads run as `sherlock_reader`, including database
row-level privacy policies. Measure the complete query as that role: an indexed
join to a handful of `telemetry.events` can still wait on an expensive policy
subquery before returning any excerpts.

On October 12, 2026, the live interval query exceeded its 20-second timeout.
`EXPLAIN (ANALYZE, BUFFERS)` with a longer diagnostic timeout completed in
26.45 seconds. The optional privacy helper
`sherlock_access.protected_record_ids()` consumed 24.46 seconds, scanning most
of `telemetry.native_records` to construct a small protected-record set.
Analyzing the small restriction table corrected its row estimate but did not
eliminate the global scan.

The guarded migration bounds the lookup in two stages: indexed batches belonging
to each restricted person, then indexed records belonging to each batch. Both
`LATERAL` subqueries use `OFFSET 0` to prevent PostgreSQL from flattening the
lookup into a global hash join. An owner-side probe of that body completed in
232 ms using existing indexes. A same-statement `EXCEPT ALL` comparison found
no added or missing IDs. This body timing is separate from end-to-end drawer
latency; the dashboard's own projection reads also contribute to response time.

The migration only replaces the recognized existing no-argument helper. It
does not install the optional privacy schema, change policies or grants, or
rewrite telemetry. An unknown helper definition or security configuration
causes the migration to fail. `CREATE OR REPLACE` retains the function's OID,
owner, execution grants, and policy dependencies. Regression tests execute the
actual migration, compare protected sets, check security attributes, and inspect
the indexed plan with skewed synthetic data.

After applying it, verify the function's OID, owner, ACL, security configuration,
and the live interval and conversation endpoints as the dashboard login.
The lookup still scales with protected history; a large protected population
may require a different measured plan. Recheck the regression plan when
upgrading PostgreSQL.

To roll back, restore the original body with `CREATE OR REPLACE`, retaining the
same signature and attributes:

```sql
create or replace function sherlock_access.protected_record_ids()
returns setof bigint
language sql stable security definer
parallel unsafe cost 100 rows 1000
set search_path = ''
as $body$
  select n.id from sherlock_access.restricted_people r
  join telemetry.ingest_batches b
    on b.workspace_id = r.workspace_id and b.person_id = r.person_id
  join telemetry.native_records n
    on n.workspace_id = b.workspace_id and n.batch_id = b.id
$body$;
```

Restoring the original body also restores the measured slow plan. Do not drop
the function or disable privacy policies to recover performance.
