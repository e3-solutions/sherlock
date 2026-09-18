# Jolly Roger compatibility preparation

This is a preparation client, **not an enrolled or production-ready integration**.
It targets [design PR #2](https://github.com/e3-solutions/jolly-roger/pull/2),
contract commit `b84a762`. Existing Jolly Roger named adapters do not load this
manifest. The separate central loader/dispatcher implementation and a reviewed
immutable source pin are required. Keep current Sherlock telemetry externally
owned until all gates below pass; never register both launchers for the same event.

The repository-root `jollyroger.json` packages only the Python telemetry client
and Claude launcher. The dashboard, ingest service, database and standalone
installers remain in their owning repository and are not bundled. All seven
Codex and seven Claude native telemetry event pairs are represented, including
Codex PostCompact and Claude SessionEnd. Managed Forum guidance is deliberately
owned by the separate Forum client; disabling the old combined SessionStart hook
must preserve that effect through its single reviewed guidance owner.

The central runner must launch the hook using isolated Python (`python3 -I -B
<absolute-entrypoint>`). It receives the v1 envelope on stdin, checks the hook-only
provider environment against the envelope, and emits one status object. It uses
the bundled collector, ignoring alternate home runtimes and
`SHERLOCK_COLLECTOR_SOURCE`; detached drain imports also use the bundle. It does
not install, update, register hooks, write trust or manufacture identity.

## Existing state and authentication

Before any future enrollment, centrally map `codex-telemetry` to the original
`$CODEX_HOME/sherlock/telemetry` and `claude-telemetry` to the original
`$CLAUDE_CONFIG_DIR/sherlock/telemetry` (using their existing default homes when
unset). Supply both absolute directories via `JOLLY_ROGER_STATE_PATHS`. The
wrapper has no implicit state fallback and performs no migration. Existing queue
bytes, checkpoints, locks and Claude observations remain in place and use the
unchanged collector format; rollback uses the retained standalone client against
the same directories. The collector's existing identity/endpoint resolution,
including `SHERLOCK_CONFIG_PATH` and owner-only `collector.json`, stays authoritative.
Missing configuration may leave local captured batches pending; it never grants
service access or fabricates configuration. User authentication and privacy remain
separate readiness checks. No production endpoint is contacted by conformance tests.

## Detached work readiness remains partial

Codex invokes the existing foreground capture and detached queue drain. Claude
retains the existing detached launcher and terminal transcript quiet window.
Its `status: ok` means dispatch was attempted, **not that input was durably
accepted, captured, or uploaded**: native fork failures are fail-open and the
child initially owns input only in memory. Foreground timeout does not bound
these children. The manifest declares `existing-worker` for every hook and must
be rejected for activation until central worker lifecycle review succeeds.

Local conformance proves copied-bundle imports, all declared envelope pairs,
malformed/missing fields, real capture after wrapper exit, retained transcript
queue bytes on replay, and untouched fixture settings/bundle. Repeated Claude
terminal hooks intentionally create additional timestamped hook observations;
this existing behavior is preserved, not represented as observation deduplication.
There is no proof here of durable pre-ack handoff, globally bounded collector
process count, cancellation/recovery ownership, retained-release lifetime,
production auth, native host trust, or signed update/session-pin/rollback
integration. Those are activation blockers. Do not remove the old telemetry
registration based on these tests or this manifest.

Run conformance with `python3 -B -m unittest discover -s tests/collector -p
test_jolly_roger.py -v`. Existing collector/launcher regression tests additionally
require `PYTHONPATH=packages/telemetry-collector/src`. The only standalone code
change is an optional explicit state argument to Claude `capture`; its default
and native dispatch remain unchanged.
