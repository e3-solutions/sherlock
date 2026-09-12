# Confidence report: durable telemetry liveness

Outcome: implemented and locally verified. Merge, deployment, and production verification are intentionally pending.

## What changed

- `SubagentStart` now finds the exact new Codex child from recent active session metadata even when the hook has neither a child transcript path nor an indexed SQLite row.
- The scan is bounded to five minutes, relevant UTC date roots, 64 identity records, and 256 KiB per candidate. Unrelated or stale rollouts are not captured by this live fallback.
- The telemetry processor now exits non-zero when its control loop makes no acknowledged progress for 60 seconds. Railway's existing `ON_FAILURE` policy then replaces the process.
- Successful handoff, maintenance, capacity, and claim operations refresh progress. Database recovery waits are checked in short bounded ticks, preserving PR #75 behavior, while GitHub remains isolated as established by PR #76.

## Proof

- Fail-before collector regression: no child transcript path, no SQLite row, a newer unrelated 65 MiB rollout, and a stale child.
- Normalizer regression: the selected child keeps its parent session and `worker` role.
- Deterministic watchdog tests: healthy progress does not trip; a real stall trips exactly once; the timer cleans up; queue claims refresh progress.
- Full local suites: 123 collector, 52 ingest, and 48 worker tests passed.
- Formatting, lint, type checks, Python compilation, and `git diff --check` passed.
- Independent integration review: **SHIP**, with no remaining blocker.

## Residual risk

- A rollout created after the one-shot hook scan waits for the next lifecycle/discovery signal.
- An in-process timer cannot fire if JavaScript itself is completely CPU-blocked; Railway remains the outer supervisor.
- Production success still requires PR CI, merge, deployment, and live observation.

## Rollback

Revert the implementation commit and redeploy the prior versions. The change does not alter database schema, queues, raw telemetry, or capacity settings.
