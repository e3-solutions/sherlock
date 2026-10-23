# Sherlock

Sherlock collects Codex and Claude Code session activity for team analytics,
including prompts, tool use, primary agents, and subagents. Each provider keeps
its own plugin, source identity, and normalizer while sharing Sherlock's
immutable telemetry backend.

## Install for Codex and Claude Code

You need macOS or Linux, Git, Python 3, and at least one of the Codex or Claude
Code CLIs. Run this one command with the same team identity for every available
provider:

```sh
workdir="$(mktemp -d)" && git clone --depth 1 --single-branch --branch main https://github.com/e3-solutions/sherlock.git "$workdir/sherlock" && "$workdir/sherlock/sherlock" install --name "<full name>" --github "<GitHub username>" --email "<work email>" && rm -rf "$workdir"
```

The command detects both agent CLIs before changing either installation. It
installs every usable provider, reports unavailable providers as skipped, and
stops without writing collector state if neither CLI is usable. It copies only
the client plugin marketplace to
`$HOME/.sherlock/marketplace` by default, so removing the temporary checkout
does not break either installation. It then reuses the provider-specific
installers below, including Codex hook trust, a 24-hour Codex backfill, and a
72-hour Claude backfill. Its final summary shows what was installed and
skipped. Use `--claude-backfill-hours HOURS` to configure the initial Claude
window from 1 hour through 31 days.
Start a new session in every installed agent so its hooks load.

Each provider installer also registers a low-priority periodic reconciler: a
macOS LaunchAgent or Linux `systemd --user` timer, with a crontab fallback when
the user service manager is unavailable. It runs about every 15 minutes from
the installed runtime and pins the selected `CODEX_HOME` or `CLAUDE_CONFIG_DIR`.
It discovers native files written in the **last 31 days** (the longest initial
backfill the installer accepts), including files the hooks never saw, and
resumes bounded capture and upload without any agent hook or running agent CLI.
Run `reconcile --max-age-days 0` by hand for an explicit full-history recovery.
Use `--no-scheduler` on any installer (or `SHERLOCK_NO_SCHEDULER=1`) to opt out
and remove that home's prior entry. An opt-out is kept by later reinstalls,
including automated refreshes; re-enable it with `sherlock_collector.scheduler
install`. Reinstalling otherwise replaces the same scheduler entry. If the
scheduler cannot be registered (for example an SSH-only macOS session without
a GUI launchd domain), the install still completes, hooks keep collecting, and
the verifiers report `scheduler.status = failed`.

Owner exclusions: hooks, backfill, the reconciler and every upload honour
`~/.sherlock/session-exclusions.json` (or `$SHERLOCK_HOME/session-exclusions.json`):
`{"version": 1, "excluded_session_ids": [...], "allowed_claude_session_ids": [...]}`.
Excluded sessions and every Codex thread descended from or forked from them are
never captured or uploaded; when `allowed_claude_session_ids` is present only
those Claude root sessions are collected (no Claude subagents). Blocked sources
keep their cursor and already-queued batches stay queued unsent
(`held_by_policy` in drain output), so removing an entry resumes without loss.
A policy file that exists but is unreadable or invalid blocks all capture and
upload until repaired. Without the file nothing changes.

To run or audit either provider manually:

```sh
PYTHONPATH="$CODEX_HOME/sherlock/runtime" python3 -m sherlock_collector.cli --codex-home "$CODEX_HOME" reconcile
PYTHONPATH="$CLAUDE_CONFIG_DIR/sherlock/runtime" python3 -m sherlock_collector.cli --provider claude_code --claude-home "$CLAUDE_CONFIG_DIR" reconcile
PYTHONPATH="$CLAUDE_CONFIG_DIR/sherlock/runtime" python3 -m sherlock_collector.cli --provider claude_code --claude-home "$CLAUDE_CONFIG_DIR" inventory --session-id UUID
```

Set those home variables explicitly or substitute `~/.codex` and `~/.claude`.
Each reconciliation captures at most 64 files and 128 MiB, rotates unfinished
sources, and attempts at most 128 uploads. `reconcile --max-files`, `--max-bytes`,
and `--max-uploads` change these limits; upload scheduling stops after 120
seconds (already running requests may finish). Complete native records are atomic;
a record above a run's byte budget stays deferred until a larger budget is used.
Records above the 100-MiB contract cap remain blocked with their source path and
reason in `sherlock/telemetry/<provider>-reconcile.json`. Incomplete trailing
records remain there until the provider writes the newline. Missing sources
remain auditable in the ledger. Discovery scans native file metadata and bounded
prefixes across retained history, so its cost grows with the number of files.

Complete native records above 100 MiB are captured losslessly as canonical
4 MiB fragments. Capture resumes across reconcile byte budgets, with the logical
range/hash and next index retained as `fragment_progress` in the ledger until
all fragments are durable. Growing tails remain deferred. Fragments normalize
as `unknown/native_fragment`; product text limits stay unchanged. Deploy the
updated ingest validator before updating collector runtimes; no schema migration
or worker update is needed. See [receipt recovery](docs/collector-receipts.md).

Both providers capture only complete newline-terminated records. Claude's terminal
hooks retain their existing bounded wait for the asynchronous transcript writer.
If a final Codex Stop record (or a late Claude write) is still missing its newline,
its cursor stays put; the next eligible hook or periodic reconciliation captures
it once complete. With no further hooks this adds roughly one scheduler interval
(15 minutes after the newline is written), subject to run budgets and backoff.
Legacy cursors inside a line continue from the existing offset in the same
generation: the remainder through the next newline stays a split record, while
all subsequent capture uses complete lines. Existing raw artifacts stay immutable,
and the ledger records `legacy_unterminated_cursor_continued` for audit.

Upload failures retry with persisted exponential backoff (one minute through one
day). Shared endpoint, auth and identity failures stop new upload scheduling;
already running requests finish, and all rejected items stay queued. A shared
cooldown in `sherlock/telemetry/queue/upload-status.json` also applies to subsequent
hook drains and newly captured streams. `reconcile` reports `collector_failure`
and exits 75; both install verifiers report degraded status with the server code,
HTTP status and next retry time until an upload succeeds. HTTP 401/403/404/405/407
and 410 are shared failures because they describe identity, routing or a retired
endpoint. Unknown codes, unqualified 413s, identity conflicts and unsupported
contract/encoding responses also stay queued for configuration or deploy repair.

Only explicit batch-specific server codes can dead-letter: HTTP 400 manifest,
payload, gzip or integrity failures; HTTP 409 storage/range/record/generation
conflicts or range overlaps; and HTTP 413 `payload_too_large`. The current server
has no batch-specific 422 code, so 422 remains queued. These rejections retain the
original manifest and payload under `sherlock/telemetry/queue/dead-letter`, with
the server code, HTTP status and timestamp, while other byte ranges continue.
Dead letters require operator review and requeue after the rejection is corrected;
they never count as committed receipts.

Scheduled runs have no interactive input and write to
`sherlock/telemetry/<provider>-reconcile.log` under the state root. Logs rotate at
1 MiB with three backups (at most 4 MiB per provider), with owner-only permissions.
A scheduler-run lock covers logging, discovery, capture and drain, and independent
capture/drain locks coordinate manual commands and hooks. LaunchAgents use
`ProcessType=Background`, `Nice=10` and low-priority I/O; systemd uses a oneshot
service with `Nice=10` and `IOSchedulingClass=idle`; cron uses `nice -n 10`.

Inspect or uninstall a home's scheduler without removing telemetry:

```sh
PYTHONPATH="$CODEX_HOME/sherlock/runtime" python3 -m sherlock_collector.scheduler status --home "$CODEX_HOME"
PYTHONPATH="$CODEX_HOME/sherlock/runtime" python3 -m sherlock_collector.scheduler uninstall --home "$CODEX_HOME"
```

For Claude, use its runtime/home and add `--provider claude_code`. Verification
checks generated files and scheduler registration; an explicit opt-out reports
`disabled`. User schedulers run while the user account's scheduler is available;
they do not collect files deleted before discovery or operate while the machine
is off. A later scan recovers retained history inside the reconcile window.

Use the same work email on every machine that should be linked to you. If an
agent is installing Sherlock for someone else, it must ask for all three values
instead of inferring them.

## Install only for Codex

You need Git, Python 3, and the Codex CLI.

```sh
git clone https://github.com/e3-solutions/sherlock.git
cd sherlock
./install.sh \
  --name "<full name>" \
  --github-id "<GitHub username>" \
  --email "<work email>"
```

The installer queues Codex rollout files modified during the preceding 24
hours and reports whether that bounded pass completed. Reinstalling is
idempotent, and later `SessionStart` hooks continue the default 24-hour Codex
backfill while prioritizing the current task. After installation, start a new
Codex task so the hooks load.

## Install only for Claude Code

You need macOS or Linux, Git, Python 3, and the Claude Code CLI. Native Windows
is not currently supported. From the same checkout, run:

```sh
./install-claude.sh \
  --name "<full name>" \
  --github-id "<GitHub username>" \
  --email "<work email>"
```

The installer validates the Claude plugin and marketplace, stores the runtime
and owner-only config under `${CLAUDE_CONFIG_DIR:-~/.claude}/sherlock`, adds
the local `sherlock` marketplace, and installs
`sherlock-claude-code@sherlock`. It also queues newline-complete bytes from
Claude primary and subagent transcripts modified during the preceding 72
hours. Pass `--backfill-hours HOURS` to configure that initial window from 1
hour through 31 days (decimal digits without leading zeroes, e.g. `60`, not
`060`). Invalid or oversized values are rejected before installation. The result reports filename-shaped regular transcript
candidates older than the cutoff; these are candidates, not validated
sessions, and may already have been captured by an earlier run. Each pass uses
a descriptor-verified point-in-time snapshot and reports any bounded or
incomplete-record bytes as deferred. Reinstalling is
idempotent. Later `SessionStart` hooks resume byte ranges still inside the
default 72-hour window with a durable cursor before capturing the current session.
Start a new Claude Code
session so its hooks load. The existing Codex plugin remains separate under
`plugins/sherlock/`.

The installer adds an owner-executable replay command at
`${CLAUDE_CONFIG_DIR:-~/.claude}/sherlock/bin/replay-history`. Replay either one
canonical session UUID or one file-modification-time range:

```sh
~/.claude/sherlock/bin/replay-history --session-id 11111111-1111-4111-8111-111111111111
~/.claude/sherlock/bin/replay-history \
  --start 2026-08-19T00:00:00Z \
  --end 2026-08-20T00:00:00Z
```

Date ranges are timezone-aware RFC3339, half-open `[start, end)`, and limited
to 31 days per command. Replay remains confined to regular files below
Claude's non-symlink `projects/` root and is idempotent. Historical replay
imports only transcript bytes; it cannot fabricate hook or lifecycle events
that Sherlock did not observe.

## Verify

Run `python3 plugins/sherlock/scripts/verify_install.py` to check the Codex
collector configuration and periodic scheduler. For missing Codex sessions, see [collector inventory and receipt recovery](docs/collector-receipts.md).
It distinguishes local capture from acknowledged delivery and records raw token-payload presence.

```sh
codex plugin list --marketplace sherlock
```

For Claude Code, run the complete local verification:

```sh
./verify-claude.sh
```

This runs `claude plugin validate` for both the plugin and marketplace, lists
configured marketplaces, asserts that the Sherlock plugin is enabled, and
checks the installed collector configuration and local queue without making a
network request. The final JSON normally reports `"status":"ok"`; it may
report `"status":"recovering"` while an upload is actively being recovered.
Both healthy states report `"provider":"claude_code"`. This is deliberately a
local check; it does not claim that an upload, normalization pass, or dashboard
projection completed.
Dead-lettered batches report `"status":"degraded"` and make verification fail
so a local capture or delivery problem cannot be mistaken for a healthy queue.

For implementation and operations details, see:

- [Data schema](docs/data-schema.md)
- [Telemetry processing](docs/telemetry-processing.md)
- [CodeActivity dashboard](apps/dashboard/README.md)
- [Bonaparte MCP v1 evidence contract](docs/bonaparte-mcp-v1.md)
- [Sherlock query MCP v1](docs/sherlock-query-mcp-v1.md)
- [Sherlock investigation MCP (excerpt search)](docs/sherlock-investigation-mcp.md)
