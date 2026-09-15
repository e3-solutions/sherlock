# Explicit session PR context rollout

This runbook requires separate production approval. Local tests and CI do not
establish production capacity, token permissions, or successful canary behavior.
See the [contract](../packages/telemetry-contract/pr-context-v1.md) for producer
commands and trust semantics, and [PR #91](https://github.com/e3-solutions/sherlock/pull/91)
for dated verification, compatibility, and adversarial-review evidence.

## Release preparation

Keep [PR #81](https://github.com/e3-solutions/sherlock/pull/81) separate: it fixes
closed-unmerged commit associations and missing-commit retries. Explicit session
context supplements that mechanism. Rehearse the exact reviewed combined heads
on synthetic data before deployment; neither PR authorizes merging the other.

1. Read production migration history, deployed artifact SHAs, role grants and
   configuration. Reconcile the release manifest before applying pending files:
   `20260828232706_add_github_lookup_error_code.sql` (#81) and
   `20260909195438_add_explicit_session_pr_context.sql` (#91). Do not rename a
   migration merely because newer versions exist or use an unchecked `db push`.
2. Confirm one worker replica and its handoff protocol. Record 30 minutes of
   queue throughput, oldest live lag, terminal failures, dashboard p95 and 5xx.
   Inspect connections, reserved slots, blocking and query plans with read-only
   access. Require zero blocked waiters and total planned connections <=80% of
   usable capacity, including the dashboard reserve. Derive the budget from
   actual configured pools and replacement overlap; do not raise concurrency.
3. Rehearse the pending migrations on a fresh production-shaped synthetic
   schema. Verify nullable error codes, append-only grants, provider guard,
   enqueue trigger, indexes and old-worker/native-path compatibility. Use short
   DDL lock/statement timeouts and stop on contention. Historical mixed-provider
   sessions require a separate auditable repair.

## Approved canary

Scope the first canary to CodeActivity's existing workspace,
`e3-solutions/sherlock`, and one synthetic Codex plus one synthetic Claude
collector. Approval must identify the exact combined artifact and reconciled
migration files; keep wider producer distribution disabled.

1. Apply additive schema; verify definitions, privileges, native row counts and
   checksums. Deploy the compatible worker before accepting sidecars, then the
   dashboard and context-capable ingest. Keep
   `SHERLOCK_GITHUB_PR_CONTEXT_REPOSITORIES` empty until the scoped canary starts.
2. Enable only the approved workspace/repository pair and collectors. Exercise
   native capture, link, erroneous-link retraction, relink, multiple PRs, a PR
   created after work starts, offline replay and review without commits. Check
   persisted provenance and the browser; commit association A must coexist
   separately with explicit context B.
3. Within 15 minutes require raw receipts, completed normalization, exact session
   binding, checked GitHub identities and the expected dashboard links. Replay
   must not duplicate activity or links. Old snapshots must retain their answers;
   native bytes, events, tokens, activity and session metadata must be unchanged
   by context operations.
4. Observe queue/rate-limit stability for 60 minutes and verification refresh for
   at least 6 hours 15 minutes. For #81, observe the actual one-hour missing-commit
   retry and six-hour closed/reopened refresh. Record outcomes and timestamps;
   approve expansion only after 24 hours without regressions.

Stop on wrong binding, out-of-scope fetches, identity leaks, changed raw bytes,
activity/token inflation, snapshot drift or audit mutation. Also stop on capacity
breach, blocked waiters >30 seconds, repeated restarts/terminal failures, backlog
growth for 15 minutes, or dashboard p95 >20% above baseline/5xx increase for
10 minutes. Auth and rate-limit pauses must remain bounded and never produce
false checked links.

## Rollback

Disable new producers and explicit GitHub scope. Stop sidecar admission by
restoring the prior ingest if necessary; retain offline spool records for retry.
Restore the prior dashboard if needed. Preserve additive schema, raw objects,
receipts, audit facts and queues.

Old workers cannot normalize context sidecars and may claim those jobs. Drain
with the compatible worker and verify no runnable or unexpired leased context
jobs remain before restoring old code. If that cannot be proven, retain the
compatible worker with verification disabled or stop processing to investigate.
Never overlap an old non-handoff worker; restore one worker only after the prior
process exits and connection/lease gates pass.
