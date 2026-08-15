# Backfill Codex history

Sherlock's backfill is deliberately split into two commands:

1. An authorized person exports the Codex history present on their device to
   one checksummed ZIP.
2. An operator uploads that ZIP through Sherlock's authenticated ingest
   endpoint.

The split makes consent and transfer explicit. Codex rollouts can contain
prompts, responses, tool inputs/results, source code, file paths, and secrets.
Handle the ZIP as sensitive data; do not attach it to tickets or commit it.

## 1. Export on the source device

From a Sherlock checkout:

```sh
python3 plugins/sherlock/scripts/export_history.py \
  --output "$PWD/sherlock-codex-history.zip" \
  --workers 8 \
  --acknowledge-sensitive-data
```

Use `--codex-home /path/to/.codex` when the source device uses a non-default
Codex home. The command scans every `rollout-*.jsonl` under both `sessions/`
and `archived_sessions/`, prints progress to stderr, and prints one final JSON
summary to stdout:

```json
{"archive":"/absolute/path/sherlock-codex-history.zip","batches":42,"sessions":12,"source_bytes":123456,"stored_bytes":45678}
```

The command writes through a temporary file and publishes the ZIP atomically.
It refuses to overwrite an existing path unless `--force` is present. If a
live rollout changes during the snapshot, stop active Codex work and rerun;
the incomplete temporary archive is removed.

`--workers` controls parallel gzip compression from 1 to 32. If omitted, the
exporter uses the available CPU count capped at 8. Compression is bounded to
one in-flight batch per worker and preserves the exact deterministic gzip
bytes used by live capture, so retries cannot conflict by compression backend.

Very large single JSONL records (for example, tool results containing images
or long command output) are split into bounded transport fragments. The ZIP
retains the full native-record range and hash for every fragment, and joining
the batches still reproduces the source rollout byte-for-byte.

## 2. Upload through Sherlock ingest

Use the collector configuration installed by Sherlock:

```sh
python3 plugins/sherlock/scripts/upload_history.py \
  ./sherlock-codex-history.zip \
  --workers 4
```

`--config /path/to/collector.json` overrides the default
`$CODEX_HOME/sherlock/collector.json`. The file must be mode `0600`. As with
live capture, `SHERLOCK_INGEST_URL` and `SHERLOCK_INGEST_TOKEN` may be used
together instead.

The uploader verifies source and stored hashes before each request, preserves
batch order inside a session, and processes independent sessions concurrently.
It retries transient failures four times by default. Successful session
checkpoints are written beside the archive, so rerunning the exact command
continues efficiently:

```text
sherlock-codex-history.zip.upload-state.json
```

Use `--retries N`, `--state /secure/path/state.json`, or `--no-resume` when an
operator needs different behavior. Server receipts remain idempotent even
without a local checkpoint.

On success, stdout contains a machine-readable summary with uploaded/skipped
batch counts and source bytes uploaded. Raw transcript bytes remain immutable
Storage objects; Postgres receives only the auditable ingest-batch ledger and
compact native-record locators. Product views remain downstream derivations.

## Verify locally

```sh
PYTHONPATH=packages/telemetry-collector/src \
  python3 -m unittest discover -s tests/collector -p 'test_backfill.py' -v
```

The archive format and invariants are specified in
[`packages/telemetry-contract/backfill-archive-v1.md`](../packages/telemetry-contract/backfill-archive-v1.md).
