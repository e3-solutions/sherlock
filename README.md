# Sherlock

Sherlock collects Codex and Claude Code session activity for team analytics,
including prompts, tool use, primary agents, and subagents. Each provider keeps
its own plugin, source identity, and normalizer while sharing Sherlock's
immutable telemetry backend.

## Install for Codex and Claude Code

You need Git, Python 3.11 or later, and at least one of the Codex or Claude
Code CLIs. Use the same team identity for every available provider.

On macOS or Linux:

```sh
workdir="$(mktemp -d)" && git clone --depth 1 --single-branch --branch main https://github.com/e3-solutions/sherlock.git "$workdir/sherlock" && "$workdir/sherlock/sherlock" install --name "<full name>" --github "<GitHub username>" --email "<work email>" && rm -rf "$workdir"
```

On native Windows, run these commands in Windows PowerShell 5.1 or PowerShell 7.
WSL is not required:

```powershell
git clone --depth 1 https://github.com/e3-solutions/sherlock.git
if ($LASTEXITCODE -ne 0) { throw 'Sherlock download failed' }
Set-Location .\sherlock
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\sherlock.ps1 install -Name "<full name>" -Github "<GitHub username>" -Email "<work email>"
if ($LASTEXITCODE -ne 0) { throw 'Sherlock installation failed' }
```

The execution-policy override applies only to that installer process. See
[Windows installation and verification](docs/windows.md) for prerequisites,
provider versions, paths, and verification limits.

The command detects both agent CLIs before changing either installation. It
installs every usable provider, reports unavailable providers as skipped, and
stops without writing collector state if neither CLI is usable. It copies only
the client plugin marketplace to
`$HOME/.sherlock/marketplace` by default, so removing the temporary checkout
does not break either installation. It then reuses the provider-specific
installers below, including Codex hook trust and each provider's 24-hour
session backfill. Its final summary shows what was installed and skipped.
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
idempotent, and later `SessionStart` hooks continue the backfill while
prioritizing the current task. After installation, start a new Codex task so
the hooks load.

## Install only for Claude Code

You need Git, Python 3.11 or later, and the Claude Code CLI. On macOS or Linux,
run from the same checkout:

```sh
./install-claude.sh \
  --name "<full name>" \
  --github-id "<GitHub username>" \
  --email "<work email>"
```

On Windows, use `install-claude.ps1` through PowerShell with the same arguments.
Use `install.ps1` for Codex only.

The installer validates the Claude plugin and marketplace, stores the runtime
and owner-only config under `${CLAUDE_CONFIG_DIR:-~/.claude}/sherlock`, adds
the local `sherlock` marketplace, and installs
`sherlock-claude-code@sherlock`. It also queues newline-complete bytes from
Claude primary and subagent transcripts modified during the preceding 24
hours. Each pass uses a descriptor-verified point-in-time snapshot and reports
any bounded or incomplete-record bytes as deferred. Reinstalling is
idempotent, and later `SessionStart` hooks resume those byte ranges with a
durable cursor before capturing the current session. Start a new Claude Code
session so its hooks load. The existing Codex plugin remains separate under
`plugins/sherlock/`.

## Verify

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
