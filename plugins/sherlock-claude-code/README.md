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

Installation immediately scans Claude's known primary and subagent transcript
layouts for regular JSONL files modified during the preceding 24 hours. It
opens them by descriptor without following symlinks, validates their
provider-native session identities, and records an inode, prefix digest, and
point-in-time byte boundary before capture. Capture rejects a replaced source
and never reads beyond that boundary. It queues only complete JSONL records
through the same immutable checkpoint and spool used by live hooks, then starts
one detached drain. A rerun does not duplicate captured byte ranges.

One pass uses a 4,096-file and 512-MiB normal-batch selection budget. A single
logical record already selected at that boundary may exceed the remaining
budget, up to the 100-MiB logical-record cap, because its deterministic
fragments must become durable before its checkpoint advances. The durable
cursor advances across every eligible transcript rather than repeatedly
selecting only the newest files. JSON status reports `deferred_files` and
`deferred_bytes` when a pass reaches a bound or observes an incomplete trailing
record; a partial result prints a warning, and later `SessionStart` hooks resume
the same checkpointed catch-up. Once Claude finishes the trailing record,
Sherlock queues that exact remaining byte range once.
Historical transcripts do not fabricate `Stop` or `SubagentStop` evidence that
Sherlock never observed, so pre-install turns can remain provisionally open.

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

Sherlock preserves `Stop`, `SubagentStop`, and `SessionEnd` input as separate,
immutable `claude_code/hook` evidence; it never appends hook data to a Claude
transcript. The evidence includes the exact hook stdin bytes and their digest.
Only a transcript-anchored `Stop` or `SubagentStop` can close a turn;
`SessionEnd` records session termination but cannot infer turn completion.
Terminal observations remain in the collector's owner-only telemetry state for
audit and retry. They are currently retained until that state is removed.

Hook and plugin behavior follows Anthropic's official
[hooks](https://code.claude.com/docs/en/hooks) and
[plugins](https://code.claude.com/docs/en/plugins) specifications.
