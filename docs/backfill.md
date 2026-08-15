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

After installing Sherlock, run the stable command printed by the installer:

```sh
~/.codex/sherlock/bin/export-history \
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
It refuses to overwrite an existing path unless `--force` is present. Active
Codex work may append to a rollout during export: the archive keeps the stable
prefix it verified. Replacement, truncation, or modification of that prefix is
rejected and the incomplete temporary archive is removed.

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
~/.codex/sherlock/bin/upload-history \
  ./sherlock-codex-history.zip \
  --workers 16
```

`--config /path/to/collector.json` overrides the default
`$CODEX_HOME/sherlock/collector.json`. The file must be mode `0600`. As with
live capture, `SHERLOCK_INGEST_URL` and `SHERLOCK_INGEST_TOKEN` may be used
together instead.

The uploader verifies source and stored hashes before each request, preserves
batch order inside a session, and processes independent sessions concurrently.
It packs up to 32 batches from adjacent sessions into each bounded binary
request, sends gzip payloads without base64 expansion, compresses the highly
repetitive manifest metadata, and reuses one persistent HTTPS connection per
worker. Rollout payloads are not recompressed. An in-place progress bar tracks
completed sessions on a terminal; redirected logs receive compact periodic
updates. It retries transient failures four times by default.
Before uploading, the client asks the server for already committed source-byte
ranges and verifies every returned hash against the local archive. It uploads
only uncovered ranges, even when a new export uses different batch boundaries.
If the live collector wins a race during upload, coverage is refreshed and the
session converges automatically. Successful session checkpoints are written
beside the archive, so rerunning the exact command continues efficiently:

```text
sherlock-codex-history.zip.upload-state.json
```

Use `--retries N`, `--state /secure/path/state.json`, or `--no-resume` when an
operator needs different behavior. Server receipts remain idempotent even
without a local checkpoint.

Each archive gets its own checkpoint beside the ZIP. A newly named export can
be uploaded immediately without clearing anything. If an archive is replaced
in place with `--force`, remove its matching `.upload-state.json` first or use
a new `--state` path; never reuse a checkpoint from a different archive.

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
