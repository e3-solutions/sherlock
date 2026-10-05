# Sesh hosted setup excerpt: verified contract boundary

Caleb needs to inspect the actual Slack-plugin automation setup. Timing evidence
cannot answer that question. A selected, owner-reviewed excerpt could truthfully
show that setup without exporting the mixed personal parent conversation, but
**current Sesh code does not support that representation**. Approval to share an
excerpt would not fix its importer, provenance or source-opening behavior.

This investigation reads Sesh source at
[`f1abaae89dbcf007293ea703d5e6e9896f764427`](https://github.com/e3-solutions/sesh/tree/f1abaae89dbcf007293ea703d5e6e9896f764427).
It makes no claim about which revision is deployed. No live Sesh ingestion,
private transcript retrieval, credential creation or permission change occurred.

## What the supported content paths require

| Current contract | Verified requirement | Hosted excerpt consequence |
| --- | --- | --- |
| [TimeTracker adapter](https://github.com/e3-solutions/sesh/blob/f1abaae89dbcf007293ea703d5e6e9896f764427/sesh_ingest/cosmos_get_chat.py) and [operator contract](https://github.com/e3-solutions/sesh/blob/f1abaae89dbcf007293ea703d5e6e9896f764427/sesh_ingest/COSMOS_GET_CHAT.md) | Exact `chat` + `messages` export from `get_chat(includeContent=true)`; original stored message JSON with matching IDs, role, hash and byte size; exact `full_transcript_indexing` consent. Authentic current consent must be verified separately. | Selected-excerpt consent and a truthful hosted-handoff envelope are rejected. Supplying fake TimeTracker/native metadata would misstate the source. |
| [Verified Codex snapshot](https://github.com/e3-solutions/sesh/blob/f1abaae89dbcf007293ea703d5e6e9896f764427/sesh_ingest/codex_snapshot.py) | Private catalog/Storage objects with manifest identity, hashes and before/after source-head validation. | A dot task ID or a host-tool excerpt does not establish that catalog entry or those original bytes. |
| [Sherlock gap fill](https://github.com/e3-solutions/sesh/blob/f1abaae89dbcf007293ea703d5e6e9896f764427/sesh_ingest/sherlock_snapshot.py) | Genuine Codex rollout or Claude transcript segments, byte-integrity checks and live owner/repository grants. [Operator documentation](https://github.com/e3-solutions/sesh/blob/f1abaae89dbcf007293ea703d5e6e9896f764427/docs/sherlock-gap-fill.md) describes this code/SQL as not yet deployed. | Recovery timing and selected excerpts cannot be substituted for native telemetry batches. |
| [Generic normalizer](https://github.com/e3-solutions/sesh/blob/f1abaae89dbcf007293ea703d5e6e9896f764427/sesh_ingest/normalize.py#L62) / [message model](https://github.com/e3-solutions/sesh/blob/f1abaae89dbcf007293ea703d5e6e9896f764427/sesh_ingest/models.py#L155) | Bare message text can be accepted, but normalized messages retain only ID, role and text. | Acceptance alone drops proposed coverage/provenance and does not establish a supported handoff path. |
| [Search source handle](https://github.com/e3-solutions/sesh/blob/f1abaae89dbcf007293ea703d5e6e9896f764427/sesh_search/service.py#L39) | Always points to Cosmos Coding Sessions `get_chat(includeContent=true)`. [Search SQL](https://github.com/e3-solutions/sesh/blob/f1abaae89dbcf007293ea703d5e6e9896f764427/deploy/hosted_sesh_fast_search.sql#L266) labels non-rollout parsers `cosmos_get_chat`. | A new hosted excerpt would have incorrect source attribution and a source-open request to an unrelated catalog. |

The revision-ingestion path already checks live grants and source-head generation
before and after reading, and uses immutable revisions. Those checks are useful
building blocks; they do not authorize a new partial source kind. Neither a local
synthetic consent receipt nor a source-readable task is an authorization grant.

## Reproducible synthetic evidence

`tests/cloud_contracts/sesh_handoff_probe.py` calls the actual pinned Sesh adapter
and normalizer. It extracts and executes only the pure source-handle function to
avoid server initialization, optional model loads and runtime credentials. It
requires a clean tracked checkout at the exact revision above. All input is
synthetic; no Storage, index or external API is contacted.

```sh
# Use an already authorized Sesh checkout at the pinned revision.
python3.11 tests/cloud_contracts/sesh_handoff_probe.py --sesh-root /path/to/sesh
```

The recorded [content-free receipt](../tests/cloud_contracts/sesh-boundary-receipt.json)
contains these six observed outcomes:

| Probe | Result |
| --- | --- |
| Coherent synthetic TimeTracker export, positive control | Accepted; original-message provenance produced. |
| Selected-excerpt consent | Rejected: `consent scope does not permit transcript indexing`. |
| Truthful partial hosted-handoff envelope | Rejected: `get_chat export must contain only chat and messages`. |
| Excerpt lacking original stored message JSON | Rejected: `full stored message JSON is required`. |
| Generic normalizer | Accepts text, drops handoff provenance/coverage. |
| Source-open for a proposed hosted source kind | Routes to the existing TimeTracker catalog. |

These six contract probes ran locally against the pinned private Sesh checkout.
Sherlock CI runs three fixture-integrity/check-out guards in
`tests/collector/test_sesh_boundary_probe.py`; it does not fetch private Sesh or
claim successful Sesh publication/search. The separate cloud-activity integration
test proves synthetic PostgreSQL ingestion and authenticated Sherlock MCP queries.
There is **no end-to-end Sesh content capture proof** in this PR.

## Smallest technical next step and separate sharing approval

Implement an explicitly partial `hosted_reviewed_excerpt` source in
**e3-solutions/sesh**, with a narrow reviewed-excerpt consent/grant contract.
Preserve source account/session, selected turn/item references, reviewed-content
hashes, redaction/omission information and coverage through ingestion, stored
revisions, chunks, search/hydration and citation output. Source-open must retrieve
only the authorized reviewed handoff and must not route it to TimeTracker.
Reuse existing grant, revocation and revision checks where they apply; no new
hosting service or credentials are established as necessary by this investigation.

The acceptance test should use synthetic content to prove ingestion → authorized
Sesh query → correct source-open, including duplicate/reordered/partial input,
denial, retry/restart, redaction and withdrawal. Existing immutable revisions need
an explicit retention/deletion policy; hiding withdrawn content is not byte purge.

Only after that technical path is tested does real sharing require Priyal's
approval of the exact setup excerpts, redactions, Caleb's access and retention.
The intended scope is the local setup child
`01a10a1e-491d-77b8-84d2-d2c6b6949014` and relevant setup items from hosted parent
`01a0f2f9-7917-73ca-ac8b-527323eb30d6`, concerning the three weekday Slack checks
at 08:00/10:00/18:00 America/Los_Angeles. Those IDs document the requested scope;
no content from them is included in fixtures or the probe receipt. Do not bulk
export the parent or use this work to control the automations.

An owner-reviewed excerpt shared directly through an approved destination can
meet the immediate inspection need without claiming Sesh integration. The present
Sherlock PR remains a tested timing foundation plus verified evidence for the
external Sesh change; it does not complete Caleb's transcript-inspection goal.
