# Codex backfill archive v1

`sherlock.codex-backfill.v1` is the offline transport contract for a complete
snapshot of the rollout files currently present under one Codex home.

The exporter scans both `$CODEX_HOME/sessions` and
`$CODEX_HOME/archived_sessions` recursively. It fails the whole export if a
candidate cannot be read, changes while being copied, or would be silently
missed through a symlink. A successful archive therefore means every regular
`rollout-*.jsonl` found in those two roots was included. Files no longer
present on the device cannot be recovered by the exporter.

## ZIP layout

```text
manifest.json
batches/<first-two-key-characters>/<spool-key>.manifest.json
batches/<first-two-key-characters>/<spool-key>.jsonl.gz
empty/<session-key>.jsonl
```

`manifest.json` records archive totals and one session entry per source file.
A session entry contains only its `sessions`/`archived_sessions` scope,
relative path, source stream and generation identities, total source and
stored byte counts, full-source SHA-256, optional native session ID, and an
ordered list of batch keys. Absolute local paths, usernames, hostnames,
database credentials, and collector credentials are not written to the ZIP.

Each non-empty source file is normally split on native JSONL record boundaries
using the same limits as `sherlock.rollout-batch.v1`. A native record larger
than one batch is transported as ordered, bounded fragments. Fragment locators
carry the native record's complete source range and SHA-256 plus a zero-based
fragment index/count; `parse_status` is `fragment`. The database stores these
facts explicitly, rather than misrepresenting fragments as independent native
records. Each batch has the exact v1 manifest and deterministic gzip payload
accepted by the ingest service. Concatenating validated, uncompressed batch
payloads in manifest order reconstructs the original file byte-for-byte.
Empty source files have an explicit zero-byte member and no ingest batch.

Payload members use ZIP `STORE` because they are already gzip-compressed;
JSON manifests use ZIP deflate. The complete archive and upload checkpoint
are owner-readable only (`0600`).

Exporters may compress independent batches concurrently, but must publish
batches in source-offset order and use the canonical deterministic gzip
encoding. Changing compressors for the same source range can change stored
bytes and is therefore not permitted by the v1 exact-retry contract.

## Upload behavior

The uploader treats the archive as untrusted input. It rejects duplicate,
missing, unexpected, or unsafe member names and bounds every decoded JSON
manifest. It validates each batch/range/hash before submission and reconstructs
the full-session hash before checkpointing that session. A checkpointed session
is skipped only after its prior exact receipts and the unchanged
archive-manifest hash establish that it was already validated and committed.

Sessions upload concurrently; batches within one session are packed into
bounded binary requests and ingested in source-offset order. The wire protocol
gzip-compresses manifest JSON, sends the existing immutable rollout gzip bytes
directly, and never base64-expands payloads. Transient requests use bounded
exponential retry. The adjacent
`<archive>.upload-state.json` checkpoint is bound to the SHA-256 of the archive
manifest and is atomically updated after each completed session. The uploader
also verifies the ZIP central directory contains exactly the members named by
that manifest before honoring the checkpoint, without rereading gigabytes of
already-uploaded payloads. Re-running an upload skips checkpointed batches;
deleting the checkpoint is also safe because the server's range contract is
idempotent.

The client never receives a Supabase service key or database URL. It uses the
same opaque collector token and Edge Function as live capture. The server
authenticates immutable workspace/person/collector attribution, ensures the
raw gzip object in Storage, and only then commits the batch and record-locator
facts in Postgres.
