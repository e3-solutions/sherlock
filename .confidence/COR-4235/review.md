# Usage reconciliation review and evidence

Independent Sol test designer and critic reviewed the query-side boundary; Astra integrated the fix. The regression fixtures were designed separately from the implementation. A copy of the original query module failed all nine original regression cases; the final complete dashboard suite passes all 309 tests, including 11 usage reconciliation cases.

The critic found that reset recovery could inflate usage, source-order lag must not be truncated by the reporting end timestamp, and overlapping native ranges invalidate the affected suffix. These findings were fixed. The follow-up review found no new correctness issue in canonical window selection or interval-conflict detection. Missing initial baselines remain explicitly unknown and are documented separately from window-additive known-baseline differences.

## Read-only production evidence, 2026-09-14

Source: Supabase execute_sql against the authorized Sherlock database, incident window 2026-09-13 UTC. No production writes, raw changes, migrations or backfill were performed. This note retains aggregate query-plan facts, not personal telemetry or raw rows.

- Matching full-record hashes and native ranges occurred under different upload/transport keys. A session's last model had been applied to prior usage observations.
- Cumulative decreases caused the old query to zero the entire stream. The new query retains accepted prefixes and marks the affected remainder unknown.
- A full-day query initially exceeded the existing 20-second statement budget. EXPLAIN showed materialized parameters prevented date-index range conditions. Inlining the parameter CTE restored events_session_occurred_idx. No supporting migration was needed.
- The corrected full-day read succeeded. A subsequent EXPLAIN (ANALYZE, BUFFERS) measured 1145.386 ms execution and 7.055 ms planning, across 108 touched sessions and 20,902 usage/context candidates. This was a warm-cache observation, not an SLA or arbitrary-history benchmark.

## Limits

Models and token totals remain unknown when source evidence conflicts. Identical canonical sessions are assumed to share native byte coordinates; disconnected source reuse without contradictory overlapping records is not proved detectable. Provider billing, subscription allocation and marginal charges remain unavailable. No token categories are combined into a billed total. No production release verification is claimed.
