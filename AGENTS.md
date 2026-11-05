# Sherlock agent guide

This file is loaded into every Claude Code and Codex session, so it stays short.
[docs/README.md](docs/README.md) routes each kind of task to the deeper doc it needs.

## What this repo is

Sherlock captures every Codex and Claude Code session from engineers' machines,
ingests it into Supabase project `psmuyotyyojrkojycyzz`, normalizes it, and serves
it to the dashboard and to the `sherlock__*` tools in Cosmos. Sesh syncs from it.

| Path | What it holds |
| --- | --- |
| `packages/telemetry-collector/` | The on-machine collector (Python). Existing machines update through the `sherlock` pin in jolly-roger `repositories.json`; fresh installs take `main` (README one-liner) |
| `plugins/sherlock`, `plugins/sherlock-claude-code` | Codex and Claude Code hooks that feed the collector |
| `supabase/functions/` | Edge Functions `sherlock-rollout-ingest` and `sherlock-collector-activity`. `sherlock-activity-reducer` is library code the worker imports, not a function |
| `supabase/migrations/` | Schema history |
| `workers/telemetry-processor/` | The queue worker (Railway, built from the root `railway.toml`) |
| `apps/dashboard/` | Dashboard and the Sherlock MCP at `/mcp` (Railway, its own `railway.json`) |
| `tests/` | Collector tests (`tests/collector`) and an end-to-end dashboard check (`tests/end-to-end`) |

## Rules for every task

- **Keep docs current in the same change.** When you change code, check whether AGENTS.md,
  docs/ or a skill in .agents/skills now states a wrong or missing command, deploy step, env
  var, branch, path, service or rule, and fix it in the same commit or PR. Add the commit
  trailer `Docs-Check: updated` or `Docs-Check: none-needed`. If you miss it, the docs
  backstop opens a docs PR after merge.
- Production writes, deploys, secrets and job retries need an explicit yes, and
  each production change gets its own Linear comment.
- Keep raw telemetry immutable, keep database facts auditable, and keep
  product-specific views separate from source data.
- **Database changes only through migration history** (`db-migration` skill). Never
  run `supabase db push` here: production history has versions this folder does not.
- **Deploy Edge Functions one at a time, by name** (`deploy` skill). A bare
  `supabase functions deploy` replaced `sherlock-rollout-ingest` with an
  unrecorded version on Nov 4.
- **Every merge to `main` redeploys both dashboards** (`codeactivity-dashboard`,
  `sixtyfour-dashboard`), which serve the `sherlock__*` MCP, even for docs-only
  changes. Merge when a short MCP restart is acceptable. The worker rebuilds only
  for paths in `railway.toml` `watchPatterns`.
- **Quiet hours on the shared database** (E3 rule after the Nov 4 ingest outage):
  no index builds or large scans between 03:00 and 19:00 UTC. Hand-run queries use a 1-day window, indexed columns,
  `LIMIT` and a short `statement_timeout`.
- Never read other people's session content beyond what the task strictly needs.
  Prefer ids and counts. Never print keys.
- Tests, as CI runs them (`.github/workflows/ci.yml`):
  - collector: `PYTHONPATH=packages/telemetry-collector/src python3 -m unittest discover -s tests/collector -v`
  - functions and worker: `deno test …` (see `ci.yml` for each config)
  - dashboard: `cd apps/dashboard && pnpm install --frozen-lockfile && pnpm check && pnpm test && pnpm build`

  The database suites need the local Supabase stack that CI starts.
- Linear: issues for this repo go in project Frontline. Branch opened →
  `In Progress`, PR opened → `In Review`, merged and accepted → `Done`.

## Skills

Repeated tasks have skills in `.agents/skills/` (Codex reads them there;
`.claude/skills/` links to the same files for Claude Code):

- `deploy`: ship the worker, an Edge Function, the dashboard or the collector, and verify it.
- `db-migration`: change the schema through migration history, safely on a busy database.
- `missing-session-rca`: a session is missing, partial or late in Sherlock or Sesh.
- `worker-backlog`: the processing queue is behind, jobs are failing, or the dashboard is stale.
