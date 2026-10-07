# Confidence Report: Codex source discovery and durable ingestion receipts

Mode: standard

Task type: bug

## Outcome

Collector implementation verified locally; historical remote recovery and client installation remain unverified.

## Goal

Include all native Codex task sources in collection and make per-source delivery and raw token-payload evidence auditable.

## Changes

- Discover automated, archived and exact continuing native IDs without product-source filtering.
- Persist validated source receipts and token-payload presence before deleting uploaded spool bytes; preserve dead-letter evidence.
- Add read-only byte/hash/native-ID receipt inventory and exact-session backfill with explicit incomplete status.

## Proof

| ID | Claim | Status | Evidence | Captured runs | Artifacts |
| --- | --- | --- | --- | --- | --- |
| P1 | All task-source categories and exact continued IDs can be discovered and captured. | pass | Real SQLite and native rollout fixtures exercise source categories, archived/exact IDs beyond recency/database limits, timestamp schema drift and no-hook backfill. | support: collector-release (exit 0), diagnostic: discovery-before (exit 1) | .confidence/collection-inventory/runs/collector-release.log |
| P2 | Validated immutable receipts and scoped token-payload presence survive acknowledgement without lost queued data on failure. | pass | Receipt ordering, retry, mismatch, malformed metadata, token fragments, semantic conflict and immutable dead-letter filesystem tests pass. | support: collector-release (exit 0) | .confidence/collection-inventory/runs/collector-release.log |
| P3 | Inventory only claims received when matching source-byte ranges cover the snapshot; gaps/exclusions remain explicit. | pass | Discovery/capture/drain/inventory tests cover appended and changed bytes, missing identity, conflicting native rows, unsupported/missing roots and empty discovery. | support: collector-release (exit 0) | .confidence/collection-inventory/runs/collector-release.log |

## Tests

Passed:

- 153 collector tests passed in captured final run.
- Python compilation and diff checks passed.

Failed:

- None

Not run:

- None

## Simplicity

Code gate: pass

Test gate: pass

Reuses capture, spool and validated server receipt contract; no server schema, raw telemetry or normalization change. Tests cross SQLite/filesystem/capture/drain boundaries.

## Review gate

Required: true
Reason: Standard-mode ingestion evidence and durable data change.

Roles:

- critic
- adversarial_reviewer

Findings and dispositions:

- Receipt reviewer findings fixed: semantic conflicts, malformed evidence, durable filesystem transitions and dead-letter preservation.
- Inventory reviewer findings fixed: empty discovery, absent native attribution, shared-path native IDs, unsupported root completion, per-candidate limits and empty CLI selector.
- Source path inode is rechecked after reading to detect replacement.
- Final independent verdict: no blockers. Added exact rollout source-kind receipt guard.

## Risks

- Vansh supplied native ID had zero matching Sherlock sessions and ingest batches at direct Supabase inspection. This does not establish why his remote collector missed it. Source file and collector upload diagnostics are not accessible here.
- Sharad native ID is still unavailable. No remote sessions have been claimed recovered or remotely installed.
- Collector runtime must be reinstalled on source machines; dashboard deployment alone does not update copied runtimes.
- Older acknowledged batches have no retained local receipt. Existing cursors are never rewound and historical receipts are not fabricated.
- Inventory is bounded and trigger-driven. Index truncation conservatively prevents complete even when filesystem discovery might overlap; omitted_sources_or_databases is not a verified count of missing sessions.
- Token payload presence is scoped raw evidence, not a token amount or billing fact.

## User decisions

- None

## Rollback

Revert this collector change and reinstall previous runtime; preserve queue, receipts and raw source files.
