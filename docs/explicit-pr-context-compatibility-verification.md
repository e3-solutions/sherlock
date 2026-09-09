# Explicit context compatibility verification — 2026-09-09

These results establish local compatibility on synthetic data. They do not
establish production rollout safety, production capacity, or production behavior.
No production changes, branch merges, pushes, or PR merges were performed by this
verification.

## Source provenance

- Refreshed main: `16e80ba5dd84184e5e33e71296d538159969bd9f`.
- Refreshed PR #81: `057fc231f9353aeab214817d2fa1a4c3ad008eb0`.
- Explicit-context implementation: working tree for COR-4126/PR #91, copied on
  2026-09-09 after backend implementation and its conflict/retraction corrections.
- Runtime: pinned Deno 2.5.1.
- Database: dedicated localhost-only synthetic Postgres/Supabase stack at port
  54322, containing both additive migrations. Testing was serialized with the
  collector-to-dashboard E2E runner.
- Temporary verification directory:
  `/private/tmp/sherlock-pr91-compat.5_8u7c3t`.

The old-main copy came from `git archive origin/main`. The combined copy came
from the current tracked and feature files, excluding local tooling state. PR
#81 was applied there with `git diff origin/main...origin/pr-81` and `git apply`.
The original PR #81 sandbox and the working implementation were left intact.

## Integration and overlap results

| Check | Result |
| --- | --- |
| Apply #81 to explicit-context executable files | Clean, no code conflict |
| README application | One textual conflict around the existing GitHub retry paragraph |
| README resolution | Retain #81's commit-not-found hourly retry paragraph and #91's separate explicit-context documentation |
| Combined backend/worker unit suite | 129 passed, 0 failed; 10 database/E2E cases skipped in this unit invocation |
| Old-main native worker with both new schemas | 9 database integrations passed |
| Combined #81/#91 native worker with both schemas | 9 database integrations passed |
| Old-main GitHub candidate read and observation insert | Passed; new `error_code` column defaults to null |
| Explicit-context schema permissions/provenance/dispatch | 14 pgTAP assertions passed |

The nine integration cases cover normalizer database behavior, activity
reduction, durable queue claims/fencing/retries, recent GitHub candidates,
ordered normalization prerequisites, concurrent mixed-lane draining, blocked
GitHub query shutdown, and frame projection/activation. The PR #81 version of
the GitHub queue case also exercises its classified missing-commit retry.

Neither PR needs to absorb the other's implementation. PR #81 changes
SHA-derived commit lookup classification and retry timing. PR #91 adds declared
session context and direct PR identity checks. Both touch `queue.ts` and
`github-sync.ts`, but their executable changes applied cleanly in this rehearsal;
PR #81 does not change `main.ts`. The README resolution is documentation-only.

Old code still does not understand collector sidecar jobs. The successful
old-main checks prove native-path compatibility with additive schema changes;
they do not authorize sending new sidecars to old workers. Enable producers only
after compatible ingestion and workers are running. Preserve raw data and audit
facts during rollback; pause new declarations and retain/drain sidecar jobs with
compatible code.

## Dashboard query inspection

The reader-role `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` of
`INTERVAL_LINKED_PRS_SQL` against the retained E2E fixture returned five rows for
three sessions:

- Planning: 1.068 ms.
- Execution: 0.191 ms.
- Context conflict lookups used `session_pr_context_event_idx`.
- Latest verification lookups used `pr_context_verifications_latest_idx`.
- Opposite-provider evidence used `events_session_occurred_idx`.

This is a tiny synthetic fixture, not a production-scale latency or cardinality
claim. Production approval must include query-plan and capacity checks at the
proposed canary scope and observation windows.

Independent source review confirmed snapshot visibility checks on declaration,
conflict, retraction, and verification facts. Session IDs originate from the
already snapshot-pinned interval query. Mutable session-row `xmin` is deliberately
not an additional filter, since unrelated later native updates would otherwise
hide historical declarations. Exact person/collector/provider/native identity
binding prevents propagation to concurrent or child sessions.

## Reproduction artifacts

The temporary directory contains `refs.txt`, `pr81.patch`, `verify.ts`,
`dashboard-explain.json`, `combined-unit.txt`, `old-main-integration.txt`, and
`combined-integration.txt`. They are supplemental local evidence, not required
runtime files. Recreate the copies and apply the two migrations to a dedicated
local test stack before running:

```sh
deno test --allow-env --allow-read --config workers/telemetry-processor/deno.json \
  supabase/functions/sherlock-rollout-ingest/*test.ts \
  supabase/functions/sherlock-activity-reducer/reducer_test.ts \
  workers/telemetry-processor/*test.ts
```

For database integration, set `SHERLOCK_TEST_DATABASE_URL` explicitly to the local
stack and add `--allow-net=127.0.0.1`; run the normalizer, activity reducer, queue,
and frame-projector database test files. The committed end-to-end harness and
its separate evidence cover the actual collector/ingestion/Storage/worker/UI
path; these compatibility checks supplement that path.
