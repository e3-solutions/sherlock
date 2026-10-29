# Sherlock query MCP v1

Sherlock query v1 adds bounded, read-only telemetry analysis to the existing
Bonaparte evidence endpoint. It is intentionally smaller than the raw
TimeTracker surface: it answers session, model, token, and coverage questions
without exposing transcripts, message content, raw Storage, filesystem paths,
repository remotes, arbitrary SQL, or write operations. Bounded excerpt search
is a separate surface, described in
[`sherlock-investigation-mcp.md`](sherlock-investigation-mcp.md).

## Recommended flow

1. Call `documentation` to read the live contract.
2. Call `coverage` for the exact window being analyzed.
3. Call `query_usage`, normally with `groupBy: "person_model"`.
4. Use `list_sessions` and `get_session` only for metadata drill-down.

`query_usage` and `coverage` default to the trailing 7 days before `end`
(server read time if omitted). Explicit historical windows up to 30 days are
supported. Larger windows fail before querying with `window_too_large`; callers
must request smaller windows. The response always states the actual interval;
explicit windows are never silently clamped. Future and non-positive windows
remain invalid.

Both tools use a 20-second per-statement database budget. Dense windows or
unusually long touched sessions can exceed it and return `query_timeout`, with
instructions to narrow the window or have the operator inspect the usage indexes.
This is an explicit refusal, never a truncated success or a generic `unavailable`.
Connection or other database failures still return `unavailable`.

`list_sessions` continues to default to all stored Sherlock history, from
`1970-01-01T00:00:00.000Z` through the server read time, with no duration cap.
Row, group, transaction-time, workspace, and roster safety bounds still apply.
`list_sessions` uses a query-bound keyset cursor; callers must reuse the exact
window and filters from the preceding page. Eligibility is session start in
`[start, end)` **or** any non-replay event with source `occurred_at` in that
window. This includes resumed older sessions. Source time keeps delayed imports
in their historical window; receipt time alone and undated events do not imply
activity in a recent window. Activity/provider lookups also exclude receipts
newer than the first-page `readAt`.

Ordering stays descending `(created_at, session_id)`, independent of mutable
activity times. The `s2` cursor preserves PostgreSQL microseconds through text
binding, fingerprints the new activity semantics, and rejects old `s1` cursors
with `cursor_invalid`; restart pagination after upgrading. Fixed filters and
window bounds remain required. This is keyset pagination over observed facts,
not a retained cross-request MVCC snapshot: late normalization of older receipts
and mutable session metadata may change eligibility between requests. Immutable
sort keys prevent duplicate sessions when activity is appended. `lastActivityAt`
is the latest non-replay source timestamp **inside the list window**, or null;
`get_session` returns the latest non-replay source timestamp across all history.
`get_session` has no start-time window filter. Dashboard Flame listings already
select event activity in their window rather than session start dates.

List eligibility uses per-session bounded probes of
`events_session_occurred_idx(workspace_id, session_id, occurred_at, id)` instead
of materializing every event in a multi-million-event window. The latest activity
probe runs only for the limited page. No new index is needed.

A disposable local PostgreSQL 17 benchmark of this exact list query, under the
reader role and 20-second timeout, used 50,000 sessions (25,000 active, including
5,000 resumed old sessions), 14 million events over 14 days, and the existing
index shapes. A 101-row first page took 164 ms; a deep page of resumed sessions
took 230 ms. EXPLAIN ANALYZE confirmed session/time index probes. This synthetic
benchmark uses narrow event rows and no production privacy overlays; it verifies
the access pattern and event-volume bound, not a production latency guarantee.

## Tools

- `documentation`: static scope, privacy boundaries, tool selection, and
  interpretation guidance.
- `diagnostics`: constrained-reader status plus raw/canonical watermarks and the
  live pending-normalization count. It returns no person or session data.
- `coverage`: observed sessions and active-projection usage events for one
  bounded window. It deliberately reports observed data as `partial` because it
  does not run cumulative-token arithmetic; `query_usage` supplies the
  query-specific partial/missing assessment and detailed reasons.
- `list_sessions`: up to 100 safe metadata records per page. The allowlist is
  session ID, person ID/display name, provider, actor role, model, start/end, last activity,
  and parent session ID.
- `get_session`: the same safe metadata for one configured-workspace session,
  plus aggregate message/tool-call/usage event counts. A foreign-workspace ID
  and an unknown ID both return `not_found`.
- `query_usage`: aggregate token facts by `person`, `model`, or `person_model`;
  provider remains a dimension in every grouping. Responses are capped at 200
  groups.

The existing `list_usage_evidence` and `list_prompt_evidence` tools remain
available with their v1 contract in `bonaparte-mcp-v1.md`.

When the search source is configured, the endpoint also exposes the separate
excerpt-search tools `resolve_person`, `search_sessions`, and
`get_session_evidence`. Their contract and investigation workflow are in
[`sherlock-investigation-mcp.md`](sherlock-investigation-mcp.md). The query v1
tools above are unchanged and remain metadata-only.

## Token semantics

The query uses the same immutable active-projection rule as Sherlock's frame
projector: Claude transcript v1; Codex v2 at or after the recorded workspace
cutover; and Codex v1 before cutover, with v2 used only for an individual source
record that has no non-replay v1 projection. A non-replay Codex v3 projection
supersedes v1/v2 for that source record regardless of the v1-to-v2 cutover;
no v2-to-v3 cutover row is required. Replay rows and lower-priority
canonical duplicates are excluded, including from the pre-window baseline.
Canonical winners are selected against all visible active projections before
window attribution, using the winner's timestamp. For example, an incremental
provisional observation of 10 immediately before a boundary followed by its
higher-priority correction of 30 immediately after it contributes 0 and 30 to
the adjacent windows, not 10 and 30. A winning observation without a timestamp
is not guessed into a window and does not revive its obsolete dated duplicate.
An empty result therefore means no attributable observed usage, not proven absence.

Claude message-scoped usage is incremental and is summed. Codex session-scoped
usage is cumulative and is differenced within each independent usage stream.
Normalizer version is projection provenance, not a separate native counter, so
an active pre-cutover v2 fallback continues the same v1 cumulative stream.
Usage derivation `sherlock.usage-reconciliation.v2` reads the history of sessions
with in-window usage so uncertainty cannot disappear when a window moves. It
collapses repeated native occurrences by session scope, native byte range, full
record hash, event kind, and projection index. Upload batch/transport identifiers
and normalizer versions do not create additional native observations. Distinct
source positions remain distinct even when their bytes match. Conflicting hashes
at the same native range, or partially overlapping native record ranges, make
subsequent attribution/arithmetic uncertain. The full available source history
is reconciled before applying both timestamp bounds, including observations
whose timestamps run backward relative to their native positions. Each delta
belongs to the timestamp window of its current observation; that does not prove
when the underlying work occurred.

Codex v4 additionally reads `token_usage_record.payload.usage` as a response
increment keyed by response ID. Duplicate/replayed responses count once. Turn
and thread cumulative totals in the same record are not additive. If any valid,
non-replay token-count fact exists anywhere in a session, **only token-count
usage** contributes for that session. This preference is assessed once per
touched session; native response increments are a fallback for sessions without
that stream. Both `coverage` and `query_usage` use the same rule, including
out-of-window winners. Counter gaps/regressions remain partial; response data
does not hide them. A late counter arrival may revise earlier fallback results.

V4 classifies Codex cache reads plus writes as cached input, consistent with
Claude cache reads plus creation. Both are subsets of Codex inclusive input;
total tokens do not increase. At an old/v4 cumulative boundary, only the
input/cache component baselines are unknown for that transition; inclusive
total/output still difference continuously. Reprocessing the complete session
with v4 removes that uncertainty without rewriting older facts. See
[operator steps](telemetry-processing.md#codex-v4-usage-rollout-and-optional-backfill).

Codex models come from the preceding `turn_context` in native source order,
including context from earlier uploads and before the window. Batch-final and
session-current model hints are not attribution evidence. Without a preceding
context, usage is grouped as `unknown`. Existing immutable projections are not
rewritten; the response records `usageDerivationVersion`.

A session beginning inside the window has an implicit zero baseline. A missing
older baseline makes the affected group's `tokens` unknown (`null`), while
subsequent measurable differences remain in `knownTokens`. At the first decrease
in any cumulative component, retain only the known prefix and exclude that
observation and the remainder of the stream. No clean counter reset or new epoch
is inferred from a decrease alone. In particular, 100 → 40 → 110 must not become
100 + 70. A later model group affected by the discontinuity returns null tokens;
an earlier unaffected group retains its measured tokens. Regrouping by person
preserves both uncertainty and the summed known prefixes. Window totals are
additive only when every participating total is non-null and has complete
arithmetic coverage. `knownTokens` must not be added across windows whose
baseline coverage differs: a narrow window may exclude an initial cumulative
value that a wider window containing the session start can include.

Each group has `knownTokens` and `coverage`. Group coverage describes arithmetic
and model attribution only: `complete` is not collector completeness. Reasons
include `cumulative_baseline_missing`, `cumulative_counter_regressed`,
`token_component_missing`, `source_record_conflict`, and `model_context_missing`.
`excludedUsageEvents` counts observations with at least one excluded token
contribution; `conflictingSourceEvents` counts observations affected by a source
position conflict, including its suffix. A numeric zero in `knownTokens` means
no accepted contribution, not zero work. Never replace null `tokens` with
`knownTokens` and present the result as a complete total.

Token fields are reported separately as `input`, `cachedInput`, `output`,
`reasoning`, and provider-reported `total`. Callers must not assume the component
fields are mutually exclusive or recompute `total` from them. Missing source
components are returned as `null`, contribute no invented tokens, and appear in
`coverage.missingTokenComponents`, which forces the result to `partial`.

## Coverage and authorization

Query v1 deliberately reports observed data as `partial`: the existing
freshness receipt reports live queued/leased normalization work but does not
account for terminal normalization failures. Other machine-readable partial
reasons include pending normalization, a missing cumulative baseline, or a
counter regression. `missing` means no active-projection usage observation was
found in the requested window. No coverage state proves collector completeness,
continuous attention, productivity, performance, or billable cost.

The new query tools do not return prompt or message content. The pre-existing
`list_prompt_evidence` tool remains available and returns only bounded excerpts
that are explicitly labeled as untrusted data.

All database calls run in repeatable-read, read-only transactions after assuming
the constrained `sherlock_reader` role and have a statement timeout. The service
is scoped to one configured workspace and roster email domain. Its shared bearer
is a transport gate, not principal-scoped authorization; Cosmos authorizes every
authenticated org member to the shared measurement surface and disables blind
health probing.

## Remaining pilot limits

- All-history metadata lookup is not full-transcript search. The existing GIN
  search index covers `content_excerpt`, not immutable source bytes beyond it.
- A native session can have multiple file streams and repeated identical
  records. File identity alone cannot prove independent counters or distinguish
  a copied transcript from a new lineage; never sum per-file totals as a repair.
- Codex v1/v2 stored event models remain batch-level hints. The versioned usage
  derivation corrects the query using native turn context; other consumers must
  not treat those stored hints as historical per-event model facts.
- Recovering post-discontinuity usage requires a provenance-backed counter epoch.
  Until then, known prefixes are intentionally incomplete rather than guessed.
- Cross-system comparisons must align interval bounds, provider coverage,
  identity mappings, component semantics, and exclusions. Neither source's
  partial aggregate is a completeness oracle or a productivity ranking.
- This patch changes read-time selection only. It does not recover uncollected
  source files, reproject history, or deploy collector upgrades. Bounded
  excerpt search for the shared organization-wide MCP bearer is a separate
  surface; see [`sherlock-investigation-mcp.md`](sherlock-investigation-mcp.md).

## Query execution and rollout

Usage discovery starts with non-replay usage timestamps, using
`telemetry.events_usage_window_idx`, before joining sessions to the authorized
roster. `events_usage_history_idx` limits touched-session reads to usage and turn
context, without dropping any history needed for canonical winners, source
conflicts, model attribution, or cumulative baselines. Coverage ranks active
usage once across window observations and possible out-of-window canonical
competitors, then applies the requested window. It does not repeat active-normalizer
checks for every possible winner. Claude rows bypass Codex projection probes. The roster bound and the existing
`analytics.read_dashboard_freshness` receipt (including per-person activity and
pending normalization) retain their existing semantics and access boundary.

Apply the usage-index migration through the normal Supabase migration runner
before rollout. Like the existing recent-session index migration, it uses
`CREATE INDEX CONCURRENTLY` outside a transaction, validates existing definitions,
and repairs only an inactive invalid build under a short lock timeout. Do not
wrap the migration in a transaction. Index payloads exclude token/content fields
to bound write/storage overhead; the history index also retains B-tree deduplication
by omitting INCLUDE payloads. Single-use reconciliation stages are inlined to
avoid repeatedly spilling wide histories while window functions retain their
ordering boundaries. Source-conflict windows use byte-range peer groups to
retain the same hash/overlap assessment without joining wide histories to
grouped positions. Incremental observations retain source/model assessment but
skip cumulative-only lag/regression work. Usage reconciliation sets
transaction-local `work_mem` to 16MB per sort/hash operation (the direct-source pool allows two concurrent
transactions), then PostgreSQL resets it at transaction end. Raw records and
projected events are unchanged.

### Local validation snapshot (2026-10-18 UTC)

PostgreSQL 17 / Node 24.15.0, with 12 people, 72,000 sessions across 90 days,
2.256 million projected events and 1.128 million usage events (80% Claude,
20% Codex). The 1 / 7 / 30-day windows contained 36,000 / 252,000 / 1,080,000
usage observations. Both SQL versions had the new indexes installed for this
comparison; these are local synthetic timings, not production latency claims.

- Original SQL coverage: 0.49 / 3.59 / 13.07 seconds; usage: 0.86 / 7.19 /
  statement timeout at 20 seconds.
- Final full tool calls, including roster checks, freshness receipts, and result
  construction: coverage 0.38 / 2.53 / 8.20 seconds; usage 0.49 / 3.17 / 15.55
  seconds. All expected observations were counted; the 30-day accepted token
  total was 108 million.

The PostgreSQL suite compares both queries directly with frozen originals from
commit `04491385f921e692982c188ba1027c5e6bbf4e1a`, using the constrained reader.
It covers normalizer cutovers/corrections, replay exclusion, Claude message
identity, boundary/undated winners, null canonical keys, native-range conflicts,
backward timestamps, missing baselines/components, and counter regressions.
Read-only production timing attempts without the new indexes still timed out;
apply the migration before evaluating production performance.
