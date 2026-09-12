# Confidence Report: COR-4005 Claude initial backfill coverage

Mode: critical
Task type: bug

## Outcome

Claude installation and SessionStart recovery now cover 72 hours by default, report cutoff exclusions, and install a selector-bounded historical replay command without changing Codex's 24-hour behavior.

## Goal

Prevent Claude sessions up to 72 hours old from being silently skipped during collector installation or recovery, and provide bounded, auditable replay for older sessions.

## Changes

- Separated Claude's 72-hour default from the unchanged shared Codex 24-hour lookback and added a validated 1-to-744-hour Claude installer override.
- Added auditable excluded_by_cutoff output and installer coverage warnings.
- Installed replay-history for exactly one canonical session UUID or one timezone-aware RFC3339 mtime range of at most 31 days.
- Preserved descriptor-bound projects-root confinement, immutable source bytes, durable checkpoints, and idempotent capture.
- Documented coverage, retry, replay, half-open range, and local-transcript limitations.

## Proof

| ID | Claim | Status | Evidence | Captured runs | Artifacts |
| --- | --- | --- | --- | --- | --- |
| P1 | The reported 51-hour initial-rollout gap is removed while the Codex default remains unchanged. | pass | The 51-hour installer regression fails against the old 24-hour behavior and passes with exact durable state under the new 72-hour default; the release collector suite also proves SessionStart behavior and the Codex 24-hour characterization. | support: collector-suite-final-release (exit 0), diagnostic: initial-51h-fail (exit 1) | tests/collector/test_team_installer.py, tests/collector/test_claude_plugin.py, tests/collector/test_plugin.py |
| P2 | Initial Claude backfill is configurable and cutoff exclusions are explicit. | pass | Installer coverage tests select a 47-hour transcript and report a 49-hour candidate at a configured 48-hour cutoff; invalid 0, over-limit, and nonnumeric values stop before installation state is written. | support: collector-suite-final-release (exit 0) | install-claude.sh, sherlock, packages/telemetry-collector/src/sherlock_collector/discovery.py |
| P3 | Operators can replay one canonical Claude session UUID or one bounded RFC3339 file-mtime range without duplicate capture. | pass | Tests prove exact primary-plus-associated-subagent UUID replay, reject an unrelated subagent ID collision, prove idempotent reruns, and enforce RFC3339 half-open mtime bounds to one-nanosecond precision with a 31-day maximum. | support: collector-suite-final-release (exit 0) | plugins/sherlock-claude-code/scripts/replay_history.py, packages/telemetry-collector/src/sherlock_collector/cli.py, tests/collector/test_claude_plugin.py |
| P4 | Replay preserves the existing private-data confinement and immutable capture boundary. | pass | The release suite covers symlink rejection, invalid selectors before spool creation, exact byte checkpoints, race protections, and idempotency across all collector tests. | support: collector-suite-final-release (exit 0), support: compileall-final-release (exit 0) | packages/telemetry-collector/src/sherlock_collector/discovery.py, tests/collector/test_claude_plugin.py |
| P5 | The implementation is operable and no larger than the problem requires. | pass | The implementation uses the existing discovery/capture pipeline, adds one small installed wrapper, documents retry boundaries, and passed lint, shell syntax, whitespace, independent test design, and final adversarial review. | support: ruff-final-release (exit 0), support: shell-syntax-final-release (exit 0), support: diff-check-final-release (exit 0) | README.md, plugins/sherlock-claude-code/README.md, .confidence/cor-4005/contract.json |

## Tests

Passed:

- 131 collector unit and integration tests
- Ruff checks for collector source, tests, and replay wrapper
- Python bytecode compilation
- POSIX shell syntax for both installers
- Git whitespace validation

Failed:

- None

Not run:

- None

## Simplicity

Code gate: pass
Test gate: pass

The change extends the existing bounded discovery and durable capture path instead of adding a second ingestion mechanism. Provider-specific defaults remain explicit, replay adds only selector validation, and counterexample tests cover the privacy and boundary risks.

## Review gate

Required: true
Reason: Critical private-telemetry collection changes require independent proof design and adversarial boundary review.

Roles:

- test_designer
- adversarial_reviewer

Findings and dispositions:

- Independent test design identified symlink confinement, invalid-before-mutation, UUID collision, and provider-default separation as the highest-risk counterexamples.
- Adversarial review found and drove fixes for wrapper lookback escape, subagent UUID collision, loose ISO parsing, and nanosecond truncation.
- Final adversarial re-review returned PASS with no release-blocking findings.

## Risks

- The reported historical session can only be recovered if its local Claude transcript still exists on the original machine.
- The supplied session reference is not a canonical full UUID; replay intentionally requires the full UUID to avoid ambiguous collection.
- Cutoff counts describe filename-shaped regular candidates, not validated missing sessions, and may include already checkpointed files.

## User decisions

- The user requested a pull request using the Confidence Protocol.
- The suggested minimum 72-hour Claude initial backfill was selected while leaving Codex at 24 hours.

## Rollback

Revert the implementation commit, reinstall the prior Claude plugin runtime, and retain existing durable spool/checkpoint data; raw transcripts and queued telemetry are not rewritten by this change.
