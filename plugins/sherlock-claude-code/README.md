# Sherlock for Claude Code

This plugin captures the JSONL transcript paths that Claude Code supplies to
hooks. It never edits a transcript. Exact source bytes are checkpointed into an
owner-only durable spool, then a detached drain uploads immutable gzip batches
to Sherlock. Capture and upload failures are fail-open and never decide whether
Claude Code may continue.

## Install

Sherlock's collector currently supports macOS and Linux. It relies on POSIX
process and file-locking primitives and does not yet support native Windows.

From the Sherlock repository root:

```sh
./install-claude.sh \
  --name "<full name>" \
  --github-id "<GitHub username>" \
  --email "<work email>"
```

Set `CLAUDE_CONFIG_DIR`, `CLAUDE_BIN`, `PYTHON_BIN`, or
`SHERLOCK_INGEST_URL` to override their documented defaults.

## Verify

```sh
./verify-claude.sh
```

For individual checks:

```sh
claude plugin validate plugins/sherlock-claude-code
claude plugin validate .
claude plugin marketplace list
```

Start a new Claude Code session after installation. `SessionStart`,
`UserPromptSubmit`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, and
`SessionEnd` provide recovery opportunities. `SubagentStop` also supplies the
agent's nested transcript path, so Sherlock records the worker transcript with
its parent session identity.

The hook command returns after starting a fully detached local capture process.
This keeps the hook fail-open and makes the final transcript capture survive
non-interactive `claude -p` teardown. Terminal hooks give Claude's asynchronous
transcript writer a bounded quiet window in that detached process before
capturing the final byte range. Verification above is local-only: it
confirms plugin enablement, configuration, and queue health, but does not prove
that an upload was committed, normalized, or displayed by the dashboard.
Dead-lettered batches make this local check fail with `"status":"degraded"`.

Hook and plugin behavior follows Anthropic's official
[hooks](https://code.claude.com/docs/en/hooks) and
[plugins](https://code.claude.com/docs/en/plugins) specifications.
