# Confidence Report: Transient database refusal recovery

Mode: standard
Task type: bug

## Outcome

Implemented, independently reviewed SHIP, and locally verified; PR CI and production rollout remain pending.

## Goal

Keep the telemetry processor alive and self-recovering across brief Supabase/Supavisor connection refusals so canonical dashboard data resumes without consuming Railway's finite restart budget.

## Changes

- Added a narrow retryable database classifier for the exact Supavisor refusal, direct network failures, selected transient SQLSTATEs, shutdown errors, and existing capacity failures.
- Generalized the single-probe database circuit with fast 1-30 second connectivity backoff while preserving 30-120 second capacity backoff and existing alert event names.
- Added a top-level supervisor so recoverable failures escaping worker setup/control flow recreate pools in-process instead of consuming Railway restart retries.
- Extended heartbeat, processing, and failure-record paths to open the same recovery circuit without changing queue, raw telemetry, handoff, concurrency, or admission semantics.
- Added exact negative controls, deterministic supervisor coverage, and a real postgres.js refused-connection subprocess boundary.

## Proof

| ID | Claim | Status | Evidence | Captured runs | Artifacts |
| --- | --- | --- | --- | --- | --- |
| P1 | The exact production XX000/econnrefused error is recoverable while auth and unrelated database errors are not. | pass | The exact production XX000/econnrefused wrapper, direct transient codes, and selected SQLSTATEs recover; auth, 08004, serialization, statement timeout, tenant-not-found, and unrelated XX000 errors fail fast. ECHECKOUTTIMEOUT retains capacity backoff. | support: exact-refusal-pass-v2 (exit 0), support: worker-suite-v2 (exit 0), diagnostic: exact-refusal-fail (exit 1) | .confidence/cor-3891/runs/exact-refusal-pass-v2.log, .confidence/cor-3891/runs/worker-suite-v2.log |
| P2 | A transient failure escaping runWorker is retried in-process with bounded delay, and a later successful run exits normally. | pass | The supervisor retries the exact wrapped refusal with deterministic backoff. The real main.ts/postgres.js process survives two direct ECONNREFUSED attempts, receives SIGTERM during backoff, and closes cleanly with no uncaught error. | support: supervisor-pass-v2 (exit 0), support: real-refusal-boundary-v2 (exit 0) | .confidence/cor-3891/runs/supervisor-pass-v2.log, .confidence/cor-3891/runs/real-refusal-boundary-v2.log, .confidence/cor-3891/run_worker_refusal_integration.ts |
| P3 | Existing worker capacity, handoff, admission, and processing behavior remains intact. | pass | Worker suite passes 29/29. Broader Deno formatting, lint, checks, ingest, reducer, and telemetry suites pass without changing concurrency, handoff, connection budgets, raw facts, or queue semantics. | support: worker-suite-v2 (exit 0), support: deno-ci-v2 (exit 0) | .confidence/cor-3891/runs/worker-suite-v2.log, .confidence/cor-3891/runs/deno-ci-v2.log |
| P4 | The reviewed change runs in production without freshness regression or recurring connection failures. | partial | Independent integration review reached SHIP after all P1/P2 findings were fixed. PR CI, merge, deployment, and live freshness checks remain operational rollout gates. | None | .confidence/cor-3891/review.md |

## Tests

Passed:

- Exact production refusal fail-then-pass regression.
- Worker focused suite: 29 passed, 0 failed.
- Broader Deno gate: format, lint, check, ingest, reducer, and telemetry suites passed.
- Real postgres.js boundary: two ECONNREFUSED recoveries in one process and graceful SIGTERM shutdown.

Failed:

- None

Not run:

- Deliberately inducing the Supavisor XX000 wrapper in production is unsafe; the exact wrapper is covered deterministically and direct refusal is covered at the real driver boundary.
- PR-hosted full CI and post-deploy production verification.

## Simplicity

Code gate: pass
Test gate: pass

The change reuses the existing worker loop, postgres.js pools, circuit, and Railway process. It introduces no service, schema, DDL, queue mutation, or raw-data path.

## Review gate

Required: true
Reason: The change controls recovery at the external Supabase/Supavisor boundary in a production worker.

Roles:

- integration_reviewer

Findings and dispositions:

- Initial review verdict NO SHIP: overly broad retry classification, incorrect checkout-timeout backoff, broken alert event compatibility, and no real worker boundary proof.
- All findings were remediated with narrow allowlists and negative controls, capacity backoff restoration, established event names, and a real refused-connection subprocess test.
- Final independent integration review verdict: SHIP with no remaining P1/P2 findings.

## Risks

- A real Supavisor XX000 wrapper was not intentionally induced in production; exact wrapper classification and real direct ECONNREFUSED recovery provide complementary evidence.
- The supervisor intentionally retries transient infrastructure failures without a count limit at a bounded delay; production freshness monitoring must alert if an outage persists.

## User decisions

- User explicitly requested the durable fix after the process restart recovered service but did not prevent recurrence.

## Rollback

Redeploy the preceding known-good Railway image/commit; no database rollback is required because this change contains no schema or data mutation.
