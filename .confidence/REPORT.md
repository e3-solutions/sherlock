# Confidence Report: Prevent Sherlock dashboard starvation under worker overload

Mode: standard  
Task type: bug

## Outcome

Implemented and verified; ready for draft PR review, not yet deployed.

## Goal

Prevent database connection pressure from starving Sherlock dashboard refreshes while preserving durable telemetry ingestion and processing throughput.

## Changes

- Edge ingestion rewrites hosted Supabase session-pooler URLs to transaction mode, caps each isolate at one connection, and fails closed for hosted direct URLs.
- Each dashboard authoritatively labels, pre-opens, and retains two database sessions before serving HTTP.
- Worker control and processing pools are authoritatively labeled; admission uses the pinned handoff session to budget the full eleven-session rolling envelope and preserve eight dashboard sessions for current and replacement generations.
- Added exact-boundary, URL-conflict, unit, and real-PostgreSQL regressions without migrations or data mutations.

## Proof

| ID | Claim | Status | Evidence | Captured runs | Artifacts |
| --- | --- | --- | --- | --- | --- |
| P1 | Serverless ingestion cannot pin a two-connection session pool per Edge Function isolate. | pass | Hosted pooler URLs route to 6543 with max one; direct hosted URLs fail closed and URL credentials/query parameters are preserved. | support: release-ci-v3 (exit 0), diagnostic: focused-regression (exit 0) | .confidence/runs/release-ci-v3.log |
| P2 | Dashboard-owned sessions remain available and database pressure pauses new worker admissions before the worker consumes reconnect capacity. | pass | Exact-boundary 8/11 arithmetic passes; real PostgreSQL proves the capacity query, two retained dashboard sessions, and authoritative component labels even when the URL supplies a conflicting label. Queue integration passed 3/3 and dashboard PostgreSQL integration passed 9/9. | support: release-postgres-v3 (exit 0), diagnostic: postgres-headroom (exit 1) | .confidence/runs/release-postgres-v3.log |
| P3 | Healthy worker throughput and lane reservations are unchanged. | pass | Default concurrency remains six with five live and normalize reservations; worker and dashboard unit suites pass. | support: release-ci-v3 (exit 0) | .confidence/runs/release-ci-v3.log |
| P4 | Raw telemetry and database fact semantics are unchanged. | pass | Diff contains no migration, raw telemetry, normalization, reduction, or audit-fact mutation. Existing append-only and idempotency suites pass. | support: release-ci-v3 (exit 0) | .confidence/runs/release-ci-v3.log |

## Tests

Passed:

- Confidence release-ci-v3: Deno format/lint/check, 103 Deno unit tests passed with expected integration skips, dashboard check, 246 dashboard tests passed, and production build passed.
- Confidence release-postgres-v3: queue PostgreSQL integration 3/3 and dashboard PostgreSQL integration 9/9, including contradictory URL label regressions.
- Exact boundary: the eleven-session rolling worker envelope leaves eight dashboard slots; one unrelated connection blocks; already-owned dashboard sessions are not double-reserved.

Failed:

- None

Not run:

- None

## Simplicity

Code gate: pass  
Test gate: pass

The implementation reuses existing postgres.js pools, the pinned handoff connection, and the existing capacity circuit. No new service, table, migration, or data path was introduced.

## Review gate

Required: true
Reason: Standard-mode service/data-boundary change under the Confidence Protocol.

Roles:

- adversarial_reviewer
- integration_reviewer

Findings and dispositions:

- Initial reactive-only design received NO SHIP because it did not reserve aggregate capacity; redesigned around live PostgreSQL admission accounting.
- Second design received NO SHIP for TOCTOU, double-counting, and weak boundary tests; redesigned around dashboard-owned sessions, labeled pools, full-envelope accounting, and exact-boundary tests.
- A later review received NO SHIP because URL application_name parameters could override component labels and four dashboard slots did not cover rolling replacements; URL labels are now stripped and the reserve/envelope increased to eight/eleven with real-driver regressions.
- Final adversarial capacity review verdict: SHIP with all prior blockers resolved.
- Final independent diagnosis review verdict: SHIP with no correctness blockers; production capacity and post-deploy behavior remain operational verification items.

## Risks

- If Supabase session pooling does not forward application_name, the worker reserves conservatively and may reduce throughput near the capacity boundary rather than risk dashboard starvation.
- Hosted direct Edge database URLs now fail closed; rollout must confirm the configured URL is the hosted pooler (the function rewrites 5432 to 6543).
- Production deployment and live post-deploy verification were not performed in this task.

## User decisions

- User explicitly requested a Confidence Protocol fix for the dashboard update failure.

## Rollback

Revert the commit, stop the new worker completely, wait for active leases to finish, then deploy the previous dashboards and one previous worker replica. No database facts, migrations, queue rows, raw objects, receipts, or revisions need reversal.
