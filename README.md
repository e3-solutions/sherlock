# Sherlock

Sherlock collects Codex and Claude Code session activity for team analytics,
including prompts, tool use, primary agents, and subagents. Each provider keeps
its own plugin, source identity, and normalizer while sharing Sherlock's
immutable telemetry backend.

## Install for Codex

You need Git, Python 3, and the Codex CLI.

```sh
git clone https://github.com/e3-solutions/sherlock.git
cd sherlock
./install.sh \
  --name "<full name>" \
  --github-id "<GitHub username>" \
  --email "<work email>"
```

Use the same work email on every machine that should be linked to you. If an
agent is installing Sherlock for someone else, it must ask for these three
values instead of inferring them.

After installation, start a new Codex task so the hooks load.

## Install for Claude Code

You need Git, Python 3, and the Claude Code CLI. From the same checkout, run:

```sh
./install-claude.sh \
  --name "<full name>" \
  --github-id "<GitHub username>" \
  --email "<work email>"
```

The installer validates the Claude plugin and marketplace, stores the runtime
and owner-only config under `${CLAUDE_CONFIG_DIR:-~/.claude}/sherlock`, adds
the local `sherlock` marketplace, and installs
`sherlock-claude-code@sherlock`. Start a new Claude Code session so its hooks
load. The existing Codex plugin remains separate under `plugins/sherlock/`.

## Verify

```sh
codex plugin list --marketplace sherlock
```

For Claude Code, run the complete local verification:

```sh
./verify-claude.sh
```

This runs `claude plugin validate` for both the plugin and marketplace, lists
configured marketplaces, and checks the installed collector configuration and
local queue without making a network request. The final JSON should report
`"status":"ok"` and `"provider":"claude_code"`.

For implementation and operations details, see:

- [Data schema](docs/data-schema.md)
- [Telemetry processing](docs/telemetry-processing.md)
- [CodeActivity dashboard](apps/dashboard/README.md)
- [Bonaparte MCP v1 evidence contract](docs/bonaparte-mcp-v1.md)
