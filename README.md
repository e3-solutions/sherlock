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

### Claude Code background sessions

When Codex launches a separate local Claude CLI process, Codex's Sherlock hooks
also schedule a detached catch-up pass over Claude transcripts modified in the
last 72 hours. `SessionStart` and `PostToolUse` attempts are limited to once per
minute; `Stop` requests a final pass even within that minute. This recovers saved
Claude bytes and retries its upload queue when Claude's own hooks were skipped.
Both collectors must already be configured for the same work email. Claude's
own configuration, native identities, and receipts remain authoritative; the
trigger does not invent a Codex-to-Claude parent relationship. Explicitly
disabling the Claude plugin or setting `SHERLOCK_CLAUDE_CATCHUP_ENABLED=0`
disables this recovery path.

Install Sherlock on each machine that runs Claude Code, including remote
hosts used for unattended CLI tasks. A laptop installation cannot observe a
remote host's transcripts. Start new Claude sessions after installing or
updating so the plugin hooks load.

Live capture discovers the current session's nested `subagents/` transcripts
on capture hooks, even when the hook supplies only the main transcript path.
Children keep their own native identity and parent link; newly appended usage
is queued incrementally, and retries do not count it twice. Capture remains
hook-driven (tool hooks are debounced), so silent runs do not imply continuous
live observation. Stop hooks and the history backfill recover completed bytes.

Dashboard frame and conversation rows show **Claude Code** or **Codex** beside
the agent role. A Claude subagent is counted as a subagent, including when it
runs in the background. Automated-run labels require existing classification
evidence; running in the background alone does not prove automation or a new
human prompt. Missing provider evidence is shown as **Provider unknown**.

Recovery requires saved transcripts. `--no-session-persistence` and
`CLAUDE_CODE_SKIP_PROMPT_HISTORY` disable that source, so missing historical
usage from those runs cannot be reconstructed by this collector. See the
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

For missing Codex sessions, see [collector inventory and receipt recovery](docs/collector-receipts.md).
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
