---
name: deploy
description: Ship a Sherlock change to production, whether that is the telemetry-processor worker on Railway, one Supabase Edge Function, the dashboard and MCP, or the on-machine collector through the Jolly Roger pin, then verify it and record a rollback target. Use when asked to deploy, release, roll out or roll back any Sherlock component.
---

# Deploy

Each component ships differently. Find yours, then get an explicit yes and add a
Linear comment for every production change (what, version or deployment id,
rollback target).

| Component | How it ships |
| --- | --- |
| Telemetry worker (`workers/telemetry-processor/`) | Railway service `telemetry-processor` (project `sherlock-telemetry-worker`) deploys from GitHub on every push to `main`, but only rebuilds when the push touches a path in the root `railway.toml` `watchPatterns`. Otherwise Railway marks it `SKIPPED` |
| Edge Functions (`supabase/functions/*`) | Manual, one function by name. CI only tests them |
| Dashboard and MCP (`apps/dashboard/`) | Railway services `codeactivity-dashboard` and `sixtyfour-dashboard` redeploy from GitHub on **every** push to `main`, including docs-only pushes, because `apps/dashboard/railway.json` has no watch patterns. Each restart briefly returns 503 on `/healthz` (`timeline_warming`). See `apps/dashboard/README.md` "Railway deployment" |
| Collector and hooks (`packages/telemetry-collector/`, `plugins/`) | Only through the `sherlock` commit pinned in jolly-roger `repositories.json` (a jolly-roger PR, capture stream) |

## Rules

- **Edge Functions: by name only**, from a clean worktree at `origin/main`:

  ```bash
  supabase functions deploy <function-name> --project-ref psmuyotyyojrkojycyzz
  ```

  Never run a bare `supabase functions deploy`. On Nov 4 it replaced
  `sherlock-rollout-ingest` with an unrecorded version. `sherlock-rollout-ingest`
  and `sherlock-collector-activity` have `verify_jwt = false` in `supabase/config.toml`.
- `supabase secrets set` rolls every function in the project to a new version.
  Only with a yes.
- **Worker:** it uses `sherlock_worker_login`, not the owner role. Before starting
  or replacing it, check database headroom: zero blocked waiters, and the total
  plus the sessions it adds at or below 80% of `max_connections`
  (`workers/telemetry-processor/README.md`). Keep one replica.
- **Order for format changes** (worker, dashboard, migration, activation) is in
  `docs/telemetry-processing.md` "Deploy and rollback order". Rollback needs a
  release that still reads the newer facts. Never delete activation facts or
  rewrite events.
- Railway CLI work: link in a temp folder, run `pgrep -fl 'railway (link|up|login)'`
  first, always pass `--service`, and never print variable values.

## Verify

- **Worker:** the queue drains, and no new `failed` rows appear in
  `processing.telemetry_jobs` (`worker-backlog` skill). The logs show no
  `worker_progress_stalled`.
- **Function:** its logs show 2xx for new uploads, and a new session of your own
  appears end to end.
- **Dashboard:** `/healthz` turns healthy after `timeline_warming`. The `sherlock__*`
  tools answer in Cosmos.
- **Collector:** after the pin bump, the fleet check-ins report the new commit
  (jolly-roger `supabase/queries/fleet_status.sql`).

## Report

Component, SHA, new version or deployment id, rollback target, verification
results, and what was not verified.
