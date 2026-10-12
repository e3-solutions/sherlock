# Sherlock as the Cosmos default coding-session search

Sherlock is the preferred fact source for coding-session investigations. Cosmos
should advertise that preference to every authenticated member through its
existing leaf descriptions and `session_hint` configuration. The gateway remains
a discovery, routing and authentication layer; retrieval belongs in Sherlock.

## Default workflow

1. Resolve a named person using `sherlock__resolve_person`. Do not guess an
   ambiguous name or pass a Cosmos/Sesh person identifier as a Sherlock identifier.
2. Extract specific terms, identifiers and aliases from the user's question.
   Search with `sherlock__search_sessions`; natural-language question wording is
   not an embedding query. Use focused phrases and OR alternatives.
3. Open relevant results and alternate locations with
   `sherlock__get_session_evidence`, using each location's own session/event IDs.
   Follow context cursors and parent/child sessions when useful.
4. Cite source locations and distinguish what a message reports from an outcome
   independently established elsewhere. Canonical database selection verifies
   source lineage, not the truth of an assistant's claims.
5. Narrow capped queries. If Sherlock is unavailable or its excerpts cannot
   establish the requested detail, disclose that gap before using Sesh as a
   fallback. Sesh results are separate evidence candidates; their identifiers and
   corpus must not be silently relabelled as Sherlock facts.

This is an agent-facing default. Explicit calls to existing Sesh tools retain
their contracts; there is no schema-changing redirect of legacy tool names.
Clients must refresh MCP discovery and initialization instructions after rollout.
Client-specific skills can still request a different search tool explicitly.

## First retrieval improvement

Identical unredacted displayed excerpts occupy one discovery slot per person,
role, origin and truncation state. Grouping runs only after normal reader and
canonical-source verification and exposes bounded alternate locations. The
occurrence view remains available with `groupIdenticalExcerpts: false`. Both views
select strongest occurrences within each session before applying the requested
display order; recent ordering does not change session-slot eligibility.

Full-message tails and nearby context can differ despite matching prefixes.
Grouping does not delete telemetry, merge source facts, hide repeated events from
evidence reads, or recover candidates excluded by the 500-row nomination budget.

## Verification and rollout

Before approval, exercise source grouping and opt-out equivalence, alternative
source reachability, real PostgreSQL privacy/canonical rules, strict MCP HTTP
schemas, and both Cosmos authentication tiers. Replay the same candidate set to
separate result presentation from live corpus changes. Benchmark grouping off/on
through the same HTTP transport, identity, query, interval and output limit.
Measure displayed diversity separately from whether a source answers the question.

Deploy the Sherlock server before the Cosmos configuration update. Verify live
tool discovery and a person → search → evidence flow, then refresh clients. No
database migration is required by the grouping change. Reverting the Cosmos
configuration removes the default preference; reverting Sherlock's application
change restores the previous occurrence-oriented search. Refresh gateway/client
discovery on rollback too: the old strict input rejects `groupIdenticalExcerpts`,
and cached output schemas for all three investigation tools can reject responses
across the shared `sherlock.search.v1`/`v2` version.
Raw telemetry is unchanged.

The default does not promise semantic parity, exhaustive recall or full-message
access. These remain important follow-ups:

- Build a broader labelled question set, including paraphrases, identifiers,
  negative controls and independently held-out experiment sessions. Measure
  evidence-supported answers and source recall, not just returned row counts.
- Add semantic nomination over a rebuildable Sherlock-derived index. Treat
  embeddings as candidates and recheck the same reader/canonical boundary before
  returning facts; index membership must not become an authorization oracle.
- Add a bounded, permission-checked full-message opening path tied to immutable
  source offsets and hashes. Verify stored bytes and message content before
  returning selected text. Do not expose Storage credentials or weaken reader
  rules to reach message tails.
- Improve nomination diversity before increasing the candidate budget. The
  current unordered cap can exclude useful evidence even when the displayed
  page has been grouped.

Until these follow-ups are measured, report limitations in investigations and
retain an explicit fallback. Switching the preferred database is distinct from
demonstrating a universal retrieval-quality or latency advantage.

## Standalone release

The direct hosted MCP can be released independently of the Cosmos default
preference. Origin-free Claude Code and Codex clients use the existing operator
bearer at `https://bonaparte.e3g.ai/mcp`. Reconnect and rediscover tools after the
v2 upgrade; pre-existing clients may retain strict v1 schemas. Cosmos opens a
fresh downstream client session for each forwarded request, but existing upstream
clients should still refresh their gateway tool catalogs. Verify the live forwarded
person/search/evidence flow after deployment without merging the default change.
