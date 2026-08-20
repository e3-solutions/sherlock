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
batches are capped at 16 MiB and their stable gzip representation at 17 MiB.

A native JSONL record larger than 16 MiB, up to the 100 MiB logical-record
cap, is transported as canonical 4 MiB source fragments. Each independently
gzipped batch contains one locator with `parse_status = fragment`, the complete
native-record range and SHA-256, and its zero-based fragment index/count.
Parsed type and timestamp fields are null. Fragment ranges are derived exactly
from the native start plus `fragment_index * 4 MiB`; the final range alone may
be shorter. Requiring every index, contiguous ranges, and the complete hash
allows the immutable source record to be reconstructed byte-for-byte without
misrepresenting transport fragments as independent JSONL records.

The only successful acknowledgement is a JSON object with
`receipt_version = sherlock.committed-receipt.v1` and `status = committed`.
It contains exactly the fields listed in `docs/data-schema.md`. The collector
checks every manifest-derived field, validates all server IDs, recomputes the
canonical object path from authenticated receipt attribution, and only then
deletes the local artifact.
