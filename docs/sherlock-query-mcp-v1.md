# Sherlock query MCP v1

Sherlock query v1 adds bounded, read-only telemetry analysis to the existing
Bonaparte evidence endpoint. It is intentionally smaller than the raw
TimeTracker surface: it answers session, model, token, and coverage questions
without exposing transcripts, message search, raw Storage, filesystem paths,
repository remotes, arbitrary SQL, or write operations.

## Recommended flow

1. Call `documentation` to read the live contract.
2. Call `coverage` for the exact window being analyzed.
3. Call `query_usage`, normally with `groupBy: "person_model"`.
4. Use `list_sessions` and `get_session` only for metadata drill-down.

Every time-window query defaults to all stored Sherlock history, from
`1970-01-01T00:00:00.000Z` through the server read time. Callers may still provide
an explicit historical start and end, with no duration cap. Future and
non-positive windows remain invalid. Row, group, transaction-time, workspace,
and roster safety bounds still apply.
`list_sessions` uses a query-bound keyset cursor; callers must reuse the exact
window and filters from the preceding page.

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
  session ID, person ID/display name, provider, actor role, model, start/end,
  and parent session ID.
- `get_session`: the same safe metadata for one configured-workspace session,
  plus aggregate message/tool-call/usage event counts. A foreign-workspace ID
  and an unknown ID both return `not_found`.
- `query_usage`: aggregate token facts by `person`, `model`, or `person_model`;
  provider remains a dimension in every grouping. Responses are capped at 200
  groups.

The existing `list_usage_evidence` and `list_prompt_evidence` tools remain
available with their v1 contract in `bonaparte-mcp-v1.md`.

## Token semantics

The query uses the same immutable active-projection rule as Sherlock's frame
projector: Claude transcript v1; Codex v2 at or after the recorded workspace
cutover; and Codex v1 before cutover, with v2 used only for an individual source
record that has no non-replay v1 projection. Replay rows and lower-priority
canonical duplicates are excluded, including from the pre-window baseline.

Claude message-scoped usage is incremental and is summed. Codex session-scoped
usage is cumulative and is differenced within each independent usage stream.
Normalizer version is projection provenance, not a separate native counter, so
an active pre-cutover v2 fallback continues the same v1 cumulative stream.
The last pre-window observation is the baseline. A session beginning inside the
window has an implicit zero baseline. A missing older baseline contributes only
subsequent provable non-negative deltas. A cumulative stream that regresses is
omitted from the token totals for that window. Both conditions force `partial`
coverage; neither is silently represented as a complete zero-usage result.

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
