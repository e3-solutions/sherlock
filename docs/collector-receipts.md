# Codex collection inventory and recovery

Native task categories, including automated suggestions and archived tasks, are
eligible for collection. Hooks resolve their exact native session ID independently
of recent-session limits. A task without a hook can be selected explicitly by
backfill. Only native rollout JSONL files in `sessions` and `archived_sessions`
are supported; derived suggestion caches are not telemetry sources.

Install the updated collector runtime on the source machine using the existing
installer. Updating the dashboard alone does not update that copied runtime.
Start a new Codex session to load its hooks.

Run these commands on the machine containing the missing native source. Replace
`NATIVE_UUID` with its native session ID. They use the existing collector identity,
configuration, and state; do not delete the capture cursor or queue.

```sh
export PYTHONPATH="${CODEX_HOME:-$HOME/.codex}/sherlock/runtime"
python3 -m sherlock_collector.cli inventory --session-id NATIVE_UUID
python3 -m sherlock_collector.cli backfill --session-id NATIVE_UUID
python3 -m sherlock_collector.cli drain
python3 -m sherlock_collector.cli inventory --session-id NATIVE_UUID
```

Inventory is read-only. Exit code 0 means every selected source has matching
receipts covering its current byte snapshot and exact native session identity.
Exit code 1 means coverage is incomplete. Inspect each source's status and reason:
missing files, unsupported paths, discovery limits, and missing acknowledgements
are distinct from zero usage. Unsupported locations remain unresolved pending
an explicit collection policy decision. Empty discovery cannot certify coverage.
Backfill completion describes local capture only;
it is not proof of server delivery. Inventory without a session ID audits the
preceding 24 hours; `--lookback-seconds` changes that selection. These commands
provide an audit at execution time, not continuous coverage while no collector
trigger runs.

Validated upload receipts are retained under
`$CODEX_HOME/sherlock/telemetry/queue/receipts` (or the configured state root).
They record server batch/workspace identity, source ranges and hashes, and raw
token-payload presence before normalization. Receipt persistence must succeed
before queued bytes are deleted. Failed persistence keeps the batch retryable.
The audit hashes current source ranges and requires contiguous coverage from
byte zero; an old acknowledgement cannot cover appended or changed bytes.

Token presence is `present`, `absent`, or `unknown` for the inspected scope.
A marker without a usage payload is not a token payload. Malformed or fragmented
records can leave presence unknown. None of these values establishes token
amounts, billing, or whether work occurred.

Old collector versions deleted local acknowledgements. An existing capture cursor
cannot recreate them, and backfill will not rewind that cursor. Verify historical
delivery directly against `telemetry.ingest_batches` using
`observed_native_session_id`, then compare batch ranges/hashes with the original
file. A missing database receipt still requires collector-side source and queue
diagnostics; do not manufacture receipts or erase state to force an apparent pass.
Local receipts are diagnostic evidence, not signed attestations; direct database
records remain authoritative for server commitment.
