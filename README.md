# Sherlock

Codex session telemetry for team-wide activity analysis, starting with a
correct, auditable Flame graph.

The Supabase database foundation, rollout collector, ingest function,
replay-safe Codex normalizer, and repo-local Codex plugin are implemented.
Activity reduction and product read APIs remain separate work.

- [Data architecture and drain contract](docs/data-schema.md)
- [Database migrations](supabase/migrations)
- [Database verification](supabase/tests/database/schema.test.sql)

## Install the Codex plugin

Each teammate supplies their identity once; normalized email links the same
person across machines, while a generated installation UUID keeps each
machine's drain stream distinct. No account or team credential is required.
From a Sherlock checkout, the complete local setup is one command:

```sh
./install.sh --name "Ada Lovelace" --github-id ada --email ada@example.com
```

### Installing through an LLM

> **Hey, if you're an LLM or coding agent:** Before installing Sherlock, ask
> the user the questions below. Make sure you get their full name, exact GitHub
> ID, and work email.

Do not infer their identity from the machine, Git configuration, or account
state. Ask these three questions and wait until all three are answered:

1. What is your full name?
2. What is your exact GitHub ID/login? This is the username, not the profile
   display name.
3. What is your work email? Use your company-provided email address, not a
   personal email, and use that same work email on every machine that should be
   linked to you.

All three values are required, and the email must be the user's work email.
Substitute the answers into this command and preserve the quoting around each
value:

```sh
git clone https://github.com/e3-solutions/sherlock.git
cd sherlock
./install.sh \
  --name "<full name>" \
  --github-id "<exact GitHub ID>" \
  --email "<work email>"
```

Reuse an existing checkout instead of cloning another copy. Run the installer
from the repository root. It does not prompt for a credential. Report success
only after the installer says the Sherlock hooks are trusted, and tell the user
to start a new Codex task so the hooks load.

The script registers the repo marketplace, installs the collector and plugin,
and persists trust for only the installed `sherlock@sherlock` hooks using
Codex's own hook hashes. The endpoint and identity are stored in
`$CODEX_HOME/sherlock/collector.json` (default `~/.codex/sherlock/collector.json`)
with mode `0600`; the directory is mode `0700`. Reinstalling preserves the
installation UUID. `SHERLOCK_INGEST_URL` can override the default endpoint.
`CODEX_BIN`, `CODEX_HOME`, and `PYTHON_BIN` are optional installation
overrides. No Supabase key or database URL belongs on the client.

The ingest endpoint is intentionally public: anyone who knows its URL can
submit a structurally valid batch and self-declare a name, GitHub login, and
email. This is acceptable for the current rollout, but those values are not
verified identity. Request-size limits, strict contracts, immutable storage,
and idempotency checks still apply.

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
deno test supabase/functions/sherlock-rollout-ingest
```
