# Confidence Report: Sherlock usage source identity and cumulative coverage

Mode: standard

Task type: bug

## Outcome

Implemented a versioned query-side usage reconciliation fix; verified on real PostgreSQL and through the MCP protocol. Ready for code review; not deployed.

## Goal

Correct historical and future usage query results without rewriting immutable telemetry.

## Changes

- Deduplicate immutable native occurrences across uploads before cumulative differencing.
- Attribute Codex usage from preceding native turn context; conflicting native ranges and absent context remain unknown.
- Preserve accepted prefixes in knownTokens and return null authoritative totals with explicit coverage for ambiguous suffixes or missing baselines/components.
- Reconcile full touched-session history before half-open timestamp filtering; inline date parameters to restore the existing date index.

## Proof

| ID | Claim | Status | Evidence | Captured runs | Artifacts |
| --- | --- | --- | --- | --- | --- |
| P1 | Native duplicates collapse while distinct positions remain distinct; model attribution follows preceding source context. | pass | PostgreSQL fixtures cover duplicate uploads with different transport keys, equal bytes at distinct positions, historical/tied-time contexts, unknown models and partially overlapping source ranges. Original code failed the regression suite. | support: verified-dashboard (exit 0), diagnostic: before-sql (exit 1) | review.md |
| P2 | Discontinuities cannot masquerade as zero or inflate usage; known prefixes and group uncertainty survive windowing. | pass | Real SQL proves prefix preservation, no recovery overcounting after counter decreases, prior-window regression carryover, component regressions, missing baselines/components, and inverted timestamps with a measured zero baseline. Protocol round-trip proves null totals and known prefixes survive schema validation. | support: verified-dashboard (exit 0), diagnostic: before-prefix (exit 1), diagnostic: before-sql (exit 1), diagnostic: sql-review-fixes (exit 1) | review.md |
| P3 | MCP output schema, grouping, existing canonical precedence and scope safety remain compatible. | pass | All 309 dashboard tests pass with the disposable PostgreSQL database enabled, including canonical precedence, roster/workspace scope, transaction pooling and MCP output contracts. Package syntax checks and frontend build passed. Read-only production EXPLAIN ANALYZE confirms the date index and 1145.386 ms execution for the incident day. | support: verified-dashboard (exit 0), support: final-package-check (exit 0), support: verified-build (exit 0) | review.md |

## Tests

Passed:

- 309 dashboard tests with PostgreSQL enabled (19 files), including 11 reconciliation regressions.
- Package syntax checks.
- Frontend production build (existing chunk-size warning).
- Read-only incident-day production query and EXPLAIN ANALYZE.

Failed:

- None

Not run:

- None

## Simplicity

Code gate: pass

Test gate: pass

Query-layer change follows the existing SQL/result-builder structure. No new dependency, normalizer version, raw rewrite, schema migration or epoch-recovery heuristic. Direct PostgreSQL fixtures exercise observable contracts instead of mocking SQL.

## Review gate

Required: true
Reason: Usage arithmetic crosses a SQL/data boundary. User requested Sol subagents with Astra as implementation lead.

Roles:

- test_designer
- critic

Findings and dispositions:

- Review rejected summing positive post-reset recovery because 100 -&gt; 40 -&gt; 110 can double-count previously observed usage; fixed by excluding the ambiguous suffix.
- Review found end-bound filtering before native-order lag and incomplete interval-conflict detection; both fixed and covered by real PostgreSQL tests.
- Initial cumulative values can be attributable in a window containing the session start but unknown in a narrower window; documented that knownTokens are not additive across changed baseline coverage.
- Retained the straightforward canonical window; the measured production runtime does not justify additional unkeyed-partition optimization.

## Risks

- Counter resets, missing contexts, conflicting sources and collection gaps remain source uncertainty; the query now exposes them instead of inventing zero or recovered tokens.
- Native source coordinates are assumed comparable within canonical session scope. Reuse without overlapping contradictory records cannot be detected from this evidence alone.
- The 1.15 second production timing used a warm cache for one day; it is not a latency guarantee for arbitrary all-history queries.
- Input/cached/output/reasoning/provider-total fields remain separate observed facts, not a billed sum.
- The fix changes historical query results and introduces null totals for partial groups; consumers must use group coverage and must not substitute knownTokens as complete totals.
- Outside scope and untested: Production deployment/end-to-end checks after release; no deployment was requested.
- Outside scope and untested: Provider billing reconciliation: billing records and verified category-overlap semantics are unavailable.

## User decisions

- Implement the fix while preserving immutable raw telemetry.
- Use Sol subagents and Astra as main agent.

## Rollback

Revert this query/result-schema commit and redeploy the prior dashboard version. No database migration or raw-data rollback is needed.
