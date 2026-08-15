# Rollout batch v1

`sherlock.rollout-batch.v1` is the collector-to-ingest manifest for one
immutable gzip-encoded rollout byte range. Workspace, person, collector,
object path, and batch ID are deliberately absent because the authenticated
server owns them.

The ingest endpoint accepts the original JSON envelope containing one manifest
plus `stored_payload_base64` for compatibility. High-throughput clients use
`Content-Type: application/vnd.sherlock.rollout-bulk.v2` and this bounded
binary body:

```text
8 bytes   ASCII "SHRBULK2"
4 bytes   unsigned big-endian item count
repeated item count times:
  4 bytes unsigned big-endian gzip manifest byte count
  4 bytes unsigned big-endian decoded manifest JSON byte count
  4 bytes unsigned big-endian gzip payload byte count
  N bytes gzip-compressed UTF-8 manifest JSON
  M bytes raw gzip payload
```

A bulk request contains 1–32 batches, is at most 12 MiB on the wire, and
represents at most 20 MiB each of uncompressed source and decoded manifests.
Individual decoded manifests remain capped at 16 MiB. The server bounds gzip
expansion, validates every item with the same v1 rules, and ingests request
items in order. Its response is `sherlock.bulk-receipts.v1` with an ordered
`receipts` array. Retrying a whole bulk request after a partial commit remains
safe because each batch is independently idempotent. Only transport metadata
is recompressed; the immutable rollout gzip payload passes through unchanged.

The manifest contains source stream and generation identity, half-open byte
bounds, source and stored sizes/SHA-256 values, optional native-session and
version hints, and an ordered `records` array. Record indexes are contiguous;
record source offsets are unique, ordered, non-overlapping, and contained by
the batch; `record_count` equals the array length and is at most 20,000. Source
batches are capped at 5 MiB and their stable gzip representation at 6 MiB.

The only successful acknowledgement is a JSON object with
`receipt_version = sherlock.committed-receipt.v1` and `status = committed`.
It contains exactly the fields listed in `docs/data-schema.md`. The collector
checks every manifest-derived field, validates all server IDs, recomputes the
canonical object path from authenticated receipt attribution, and only then
deletes the local artifact.
