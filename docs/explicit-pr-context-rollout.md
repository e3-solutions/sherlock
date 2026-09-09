# Explicit session PR context and PR #81 rollout

This is a review plan, not deployment authorization. Neither PR may be merged in
this task. Production schema/configuration changes and unmerged-code canaries
require separate approval.

## Product contract

`Linked PRs` is a set of collector-reported declarations for one exact provider,
collector, workspace and native session. GitHub identity checks confirm the
repository and PR, not uploader identity, authorship, work performed, or allocation
of every event/minute/token. The current public ingest resolves a declared email;
it does not authenticate the claimed actor/session relationship. These links
must never be used as an authorization or compensation signal.

Link and retract records are immutable sidecars, independently stored alongside
native transcripts. Retraction references a particular declaration to correct an
error; finishing work does not retract historical context. There may be zero,
one or multiple PRs, including review-only work without commits. A PR created
after work begins is linked to that same explicit native session. Links are not
inherited by subagents or inferred from checkout/branch/starting SHA. Existing
SHA-derived `pullRequest` responses remain backward-compatible and are labeled
**Commit association** in the UI.

The Python CLI and `gh pr create` wrapper are documented in
[the sidecar contract](../packages/telemetry-contract/pr-context-v1.md).
The worker only fetches GitHub's direct PR endpoint after an operator-specified
workspace/repository allowlist check. Redirects and identity mismatches fail
closed. No titles, bodies, private URLs or author metadata are projected.
Unknown sessions remain unbound; cross-provider native-ID collisions are
rejected rather than creating or mutating the wrong session.

## PR #81 recommendation

Keep [PR #81](https://github.com/e3-solutions/sherlock/pull/81) separate from
[PR #91](https://github.com/e3-solutions/sherlock/pull/91). #81 fixes the existing
commit-association pipeline: closed-unmerged PR handling and classified
missing-commit retries. #91 implements a distinct declared-context relation.
Neither supersedes the other. #91 is based on refreshed main and does not
include #81's migration or behavioral changes. Combine the reviewed heads in an
isolated checkout and rerun overlapping worker/schema tests before rollout.

Apply schema before the corresponding code. #81 adds
`20260828232706_add_github_lookup_error_code.sql`; #91 adds
`20260909195438_add_explicit_session_pr_context.sql`. Do not rename #81's
migration simply because newer migrations exist. First read actual production
migration history, compare every version with the release manifest and verify
the pre/post table and trigger definitions. Explicitly apply the reviewed
pending files in timestamp order only after confirming no other missing or
divergent migration. Avoid an unreviewed blanket `db push`.

## Current evidence and limits — 2026-09-09 UTC

Read-only GitHub refresh: main `16e80ba5dd84184e5e33e71296d538159969bd9f`,
#81 `057fc231f9353aeab214817d2fa1a4c3ad008eb0`, #81 open with its existing CI
successful. Source: `git fetch` and `gh pr view 81` in this task. A historical
successful CI run does not test #81 combined with current main.

Railway's production deployment history reports the worker's last successful
deployment `e6d9908e-cc0a-4f4d-881a-8cb8290f769d` at commit
`c67b5a328eb3e33e40b4b327afc626404134278b`; later main commits were skipped.
The worker and ingest source trees have no diff between that commit and refreshed
main. The CodeActivity dashboard's successful deployment
`3b2022b7-c444-46f8-899a-849e680ae55c` reports current main. Source: Railway
`get_service_config` / `list_deployments`, not assumed from branch state.

Worker variables report concurrency 12, control pool 2, processing pool 12,
dashboard reserve 8, and a GitHub token present. The source therefore budgets
15 connections for an active worker with GitHub enabled (2 + 12 + 1), and 16
at compatible replacement overlap, rather than README default-size examples
of 7/8. This feature reuses the same single GitHub pool; it does not add another
pool. One-hour Railway metrics sampled during this task showed CPU average
0.266 and memory average 0.658 GB (peak 0.906 GB); these do not establish
database headroom, query capacity, token permissions, or sustainable throughput.

The Supabase connector denied the read-only production migration-history query
for the worker's configured project. Thus actual applied migrations, blocked
waiters, `max_connections`, active sessions and production query plans remain
unverified release gates. No production mutation was attempted. Local/CI results
and a rollout plan cannot prove production behavior.

## Approval proposal and gates

After PR review, authorize a maintenance window for the exact reviewed combined
commit and the explicitly reconciled migration files. Scope the first canary to
CodeActivity's existing workspace, only `e3-solutions/sherlock`, and one approved
synthetic Codex plus one synthetic Claude collector. Do not enable a second
dashboard/workspace or team-wide producer distribution during this canary.
Before that authorization, complete the read-only migration/capacity gates:

1. Record deployed artifact SHAs, current configuration and migration history.
   Confirm one worker replica, its handoff protocol, available role grants and
   private schema exposure. Capture 30 minutes of baseline queue arrivals,
   completions, oldest live lag, terminal failures, dashboard p95 and 5xx rates.
2. In a bounded read-only transaction, inspect `max_connections`, reserved
   slots, `pg_stat_activity`, `pg_blocking_pids`, lock wait ages and service
   connection counts. Require zero blocked waiters and current total plus added
   sessions <= 80% of usable capacity, including the eight-slot dashboard
   reserve. Do not raise concurrency or pool limits as part of this rollout.
3. Rehearse exact pending migrations against a fresh production-shaped schema
   with synthetic data; set short lock/statement timeouts for production DDL
   and stop on contention. Confirm #81's validated nullable error-code constraint,
   #91's append-only grants and provider guard, enqueue trigger, indexes and
   old-worker/new-schema behavior. Existing mixed-provider sessions require a
   separate auditable repair; do not silently rewrite historical facts.
4. Apply reviewed additive schema. Verify catalog definitions and privileges,
   preserved native row counts/checksums and no unexpected table rewrites.
   Deploy the compatible worker before ingestion or producers emit sidecars.
   Deploy dashboard after schema; deploy context-capable ingest next. Keep
   `SHERLOCK_GITHUB_PR_CONTEXT_REPOSITORIES` empty until the scoped canary.
5. Enable only the approved workspace/repository pair and two canary collectors.
   Run actual native transcript capture, explicit link, wrong-target retraction,
   relink, multiple PRs, PR created after work starts, offline replay and a
   review-only session. Read real persisted provenance and the browser UI.
   Verify starting-SHA association A remains separate from explicit link B.

Within 15 minutes of canary ingestion, require a committed raw receipt, completed
sidecar normalization, exact session binding, GitHub-checked identities and a
fresh dashboard result with the expected set. Replaying must not duplicate links
or activity. Pre-link/pre-retract snapshots must retain their original answers.
Native Storage byte hashes, canonical event/token/activity counts and native
session metadata must remain unchanged by context-only operations.

Observe at least 60 minutes for queue stability and rate-limit behavior, and at
least 6 hours 15 minutes for the verification refresh window; approve wider
rollout only after 24 hours without regressions. For #81, verify actual
missing-commit retry after its one-hour eligibility and closed/reopened refresh
after the terminal six-hour schedule. Record observed timestamps and GitHub
outcomes; do not infer elapsed retries from a unit test.

Stop immediately on any wrong-session/workspace/provider binding, out-of-scope
fetch, identity leak, changed raw bytes, activity/token inflation, snapshot
drift or audit update/delete. Also stop on connection gate breach, blocked
waiter >30 seconds, repeated worker restarts/terminal failures, sustained live
backlog growth for 15 minutes, or dashboard p95 >20% above baseline/5xx increase
for 10 minutes. Auth/rate-limit pauses must remain bounded and recover without
turning into false checked links.

## Rollback without deleting evidence

Disable producer distribution and clear explicit GitHub scope, retaining the
context-capable worker. Stop accepting new sidecars by restoring the old ingest
if necessary; offline sidecars remain in the collector spool for retry. Restore
the prior dashboard code if it regresses. Do not drop new tables, reverse audit
rows, retract accurate historical links, or reset raw objects/receipts/queues.

An old worker cannot normalize `sherlock.pr-context.v1` and may claim those jobs.
Before restoring an old worker, drain all context jobs with the compatible
worker, stop new sidecar admission, and verify no runnable/unexpired context
jobs remain. If that cannot be proven, retain the compatible worker with
verification disabled or stop processing while investigating. Never run an old
non-handoff worker concurrently. Restore one worker only after the prior
process has exited and connection/lease gates pass. The additive schema remains
in place, so #81's nullable column and all #91 facts survive code rollback.

Production proof remains pending this explicitly approved canary. Neither a
local passing test nor this proposal authorizes a merge or deployment.
