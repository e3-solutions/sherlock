# Rollout batch v1

`sherlock.rollout-batch.v1` is the collector-to-ingest manifest for one
immutable gzip-encoded rollout byte range. The request contains declared
collector identity, one manifest, and `stored_payload_base64`; workspace,
person, collector key, object path, and batch ID are deliberately absent
because the authorized server resolves them.

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
