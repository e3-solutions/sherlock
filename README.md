# Sherlock

Codex session telemetry for team-wide activity analysis, starting with a
correct, auditable Flame graph.

The Supabase database foundation, rollout collector, ingest function, and
repo-local Codex plugin are implemented. Normalization and product read paths
remain separate work.

- [Data architecture and drain contract](docs/data-schema.md)
- [Canonical database migration](supabase/migrations/20260814225047_initial_sherlock_schema.sql)
- [Database verification](supabase/tests/database/schema.test.sql)

## Install the Codex plugin

Each teammate needs an opaque collector token mapped to their own person and
collector identity on the server. Do not share one teammate's token. From a
Sherlock checkout, the complete local setup is one command:

```sh
./install.sh
```

The script registers the repo marketplace, installs the collector and plugin,
and persists trust for only the installed `sherlock@sherlock` hooks using
Codex's own hook hashes. It prompts for the token without echoing it or placing
it in shell history. For secret-manager automation, pass it on standard input
with `./install.sh --token-stdin`. It is stored with the endpoint in
`$CODEX_HOME/sherlock/collector.json` (default `~/.codex/sherlock/collector.json`)
with mode `0600`; the directory is mode `0700`. `SHERLOCK_INGEST_URL` and
`SHERLOCK_INGEST_TOKEN` may be used instead when Codex inherits both variables.
`CODEX_BIN`, `CODEX_HOME`, and `PYTHON_BIN` are optional installation overrides.
No Supabase service key or database URL belongs on the client.

Hooks discover active/recent rollout paths from Codex's SQLite state. Exact
source bytes and checkpoints live under `$CODEX_HOME/sherlock/telemetry`.
`SessionStart`, `UserPromptSubmit`, and `Stop` capture all recent candidates;
`PostToolUse` captures only after agent-coordination tools. Hooks spool locally
and detach network drain, so an offline endpoint does not block Codex and the
next eligible hook retries pending batches.

Start a new Codex task after installation so the app loads the trusted hook
companion. Verify installation with:

```sh
codex plugin list --marketplace sherlock
python3 /path/to/sherlock/plugins/sherlock/scripts/run_hook.py SessionStart <<<'{}'
```

Run the focused collector checks with:

```sh
PYTHONPATH=packages/telemetry-collector/src python3 -m unittest discover -s tests/collector -v
deno check supabase/functions/sherlock-rollout-ingest/index.ts
deno test supabase/functions/sherlock-rollout-ingest/service_test.ts
```
