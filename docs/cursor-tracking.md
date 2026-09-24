# Cursor IDE and CLI session tracking

Sherlock's Cursor collector observes future native hook invocations through the
same user-level `~/.cursor/hooks.json` configuration used by the IDE and CLI.
It requires macOS or Linux and Python 3. It does not modify an installed profile
until the installer is explicitly run.

## Install after server rollout

From a retained Sherlock checkout:

```sh
./install-cursor.sh --name "<full name>" --github-id "<GitHub username>" --email "<work email>"
```

Use the same work email as your other Sherlock installations. The installer
copies the runtime to `~/.cursor/sherlock/runtime`, stores owner-only identity
configuration, and merges native hooks into `~/.cursor/hooks.json`. Existing
hooks are retained; an initial configuration backup is saved under
`~/.cursor/sherlock/cursor-hooks.before-install.json`. Reinstalling with the same
Python executable is idempotent. The copied runtime survives removing the checkout.
Use `--cursor-home PATH` for a separate test profile and `--endpoint URL` for a
test ingest service. The unified `./sherlock install` command still installs
Codex and Claude only; install Cursor with the dedicated command above.

Start a new Cursor IDE conversation and a new CLI conversation after installing.
Check each client's hook output and confirm separate session receipts before
rolling out across a team. Hook availability and delivery vary by client/version;
synthetic fixtures do not establish live IDE or CLI coverage.

## What is captured

- Session lifecycle, prompt attempts, successful and failed tool observations,
  agent responses/thoughts, subagent start/stop, stop, and pre-compaction events.
- Exact incoming hook bytes, including their payload hash, in an immutable
  `cursor/hook` source batch. Tool payloads stay in raw Storage.
- Explicit conversation/generation IDs, models when supplied, and parent/child
  identity from subagent hooks. Main sessions use `cursor:<conversation_id>`;
  child IDs include the parent to prevent collisions.
- Collector observation time. Native execution time is not invented.

No historical transcript backfill, Tab completion tracking, guaranteed token or
cost reporting, or inferred IDE-versus-CLI classification is provided in v1.
The hook payload does not guarantee a client-surface field, so both are attributed
to provider `cursor`. Disabled or missing hooks mean missing evidence.
`transcript_path` is preserved inside the raw payload but is not opened; native
transcript formats and lifecycle hooks must not be guessed to be equivalent.

`beforeSubmitPrompt` is a **prompt attempt**, because another hook can reject it.
It contributes observed activity but does not increment Sherlock's submitted-human
prompt metric or provide a submitted-request summary. Response excerpts remain
available in work detail when the client emits `afterAgentResponse`. CLI clients
that omit response hooks still contribute tool and stop observations, not fabricated
conversation text. Missing usage remains unknown, not zero-token evidence.

## Pipeline

The hook durably spools a gzip batch before launching the background drain. It
never waits for network delivery and returns non-blocking output. Each invocation
has a unique observation ID; upload retries reuse the same batch. Distinct equal
payloads are not guessed to be duplicates. Payloads above 2 MiB are rejected with
a local diagnostic; no truncated raw record is uploaded.

The ingest contract admits only `cursor/hook`. The database trigger routes it to
`sherlock.cursor-hook.v1`. The normalizer verifies payload hashes and session
identity, emits bounded excerpts, and retains malformed observations as unknown
coverage facts. Existing worker leases, retries, reductions, and projections are
reused. MCP session queries label the provider `cursor`.

Frame v6 adds Cursor to the source universe. Raw snapshot token v5 also adds
Cursor; raw v4 and older tokens retain their previous provider set. Existing
frame v5, v4, and v2 tokens remain readable. Activation and fallback keep each
read pinned to one complete projection version.

## Rollout

1. Deploy the Cursor-capable ingest function, worker, and dashboard as a
   coordinated release. Apply the additive `add_cursor_hook_provider` migration
   before enabling any Cursor collector. It preserves existing source facts and
   retains Codex v3 / Claude v1 queue routing.
2. Run the existing `scripts/backfill-frame-evidence.ts --workspace <uuid>
   --activate` workflow to prove and activate frame v6 from normalized facts.
   Coordinate this handoff: the new worker produces v6, so the old active
   projection stops advancing until v6 activation completes.
3. Install the Cursor collector, trigger one IDE and one CLI session, and verify
   the receipt, normalized event, frame revision, dashboard, and MCP result.
4. Do not roll back to a worker that cannot consume already queued Cursor jobs.
   Remove only Sherlock's Cursor entries from `hooks.json` to stop new capture;
   retain queued batches and database history for recovery.

## Verification

```sh
PYTHONPATH=packages/telemetry-collector/src python3 -m unittest discover -s tests/collector -p test_cursor_hook.py
deno test supabase/functions/sherlock-rollout-ingest/cursor_normalizer_test.ts
SHERLOCK_TEST_DATABASE_URL=... deno test --config workers/telemetry-processor/deno.json --allow-env --allow-net workers/telemetry-processor/cursor_postgres_test.ts
```

The database integration test exercises ingest validation (with an in-memory
Storage adapter), durable queue routing, normalization retries, projection
activation, dashboard details, and MCP provider attribution. It needs an isolated
migrated database. It does not verify hosted Storage transport or live clients.

Source contract: [Cursor hooks documentation](https://cursor.com/docs/hooks).

## Local implementation verification

Verified on 2026-09-25 (India time): six collector/installer tests, six Cursor
normalizer tests, and the Cursor PostgreSQL integration test pass. The wider
normalizer/reducer unit suite passed 68 tests, worker unit tests passed 53,
dashboard unit/component tests passed 282, and dashboard SQL tests passed 41.
The existing Codex v3 and frame-projector database regression tests also pass.
The dashboard production build and Deno formatting checks pass. Deno lint passes
with `--no-config` to avoid inherited configuration outside the repository.
Dashboard checks used local Node 25.9.0; CI remains pinned to Node 24.15.0.

The full Python 3.14 collector suite passes 161 of 162 tests. The existing
`test_codex_compaction_guidance_uses_supported_session_start_contract` fails
with a missing `hookSpecificOutput`; the same failure was reproduced against an
unchanged archive of commit `757df3b`. No Collective-feedback code was changed.

Database tests used disposable PostgreSQL 17 with Storage bucket metadata stubbed
and the retired hosted cron scheduler omitted. No production deployment, live
profile installation, live Cursor IDE/CLI capture, or hosted Storage request was
performed. Those remain rollout verification steps.
