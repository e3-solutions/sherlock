# Sherlock dashboard

The dashboard serves the CodeActivity Flame experience from Sherlock's canonical
private telemetry schemas. It is a single workspace-scoped service: every query
uses SHERLOCK_WORKSPACE_ID and one small connection pool whose transactions are
repeatable-read, read-only, and pinned to `sherlock_reader`.

The browser and MCP clients never receive database credentials. The page and
aggregate API are public; the MCP endpoint requires a separate bearer token.
Every database query remains pinned to one configured workspace.
The aggregate API does not return prompt text. Lazy interval and work-detail
endpoints return only canonical normalized evidence for one person and one
ten-minute bucket. Message content is limited to
`telemetry.events.content_excerpt`; the dashboard never reads full raw Storage
objects.

## Data contract

- `telemetry.people` is the roster, so real people with zero activity remain
  visible. The stable synthetic identity `github_id = 'sherlock-smoke'` is
  excluded; display names are never used as the filter.
- Canonically selected `sherlock.codex-rollout.v1` and
  `sherlock.claude-code-transcript.v1` event presence is grouped into 144
  ten-minute UTC buckets. Canonical winner selection remains scoped by
  normalizer version, so evidence from different provider projections is never
  collapsed together. Distinct Sherlock execution sessions are counted per
  effective role and bucket; they are not native thread or duration counts.
  Metadata-only lifecycle records are not activity evidence.
- The person rail's 24-hour active time uses the same canonical, non-replay,
  non-automation observed-session evidence and effective role mapping as the
  graph. Each bucket with any Agent, Subagent, or Unclassified session evidence
  contributes ten minutes, regardless of how many events or parallel sessions
  appear in that bucket. One event therefore credits the entire bucket, while
  events seconds apart on opposite sides of a bucket boundary can credit twenty
  minutes. Silent work between observed events is not counted. This is a coarse
  presence estimate, not measured attention, continuous work, or CPU runtime.
- UUIDv7 `native_item_id` values provide the original creation timestamp for
  response items copied into a later rollout. Envelope timestamps remain the
  fallback for event types without a stable native item ID. Canonical activity
  evidence must be at or after its owning Sherlock session's millisecond-aligned
  start. Copied pre-start source facts remain immutable in telemetry, but they do
  not make the later session active in an earlier dashboard bucket.
- primary is Agent; worker and guardian are Subagent; unknown is Unclassified;
  automation is excluded. When a v1 event is `unknown` but its Sherlock session
  has a resolved parent, the dashboard presents it as Subagent: parent topology
  is resolved source-backed session evidence that it is child work even when an
  older Codex payload encoded `source.subagent` as a string the v1 normalizer did
  not classify. Detail queries require the current session-row version to have
  been visible to the aggregate snapshot only when an unknown event needs that
  mutable parent fallback. Known event roles remain snapshot-stable when
  unrelated session metadata changes. Ambiguous unknown-role rows are omitted
  with an explicit partial-evidence notice instead of failing the whole frame.
- The person rail shows bucket-derived 24-hour active time alongside read-relative
  recency rather than daily role totals. The API supplies each person's latest
  canonical activity timestamp, including the current partial interval: green
  means activity in the last ten minutes, yellow means activity ten to thirty
  minutes ago, and red means no activity in the trailing thirty minutes. These
  are recent observed events, not a process heartbeat or proof that an agent is
  still running.
- Canonically selected, non-replay primary-role submitted user messages with
  valid stored content supply prompt counts. Keyed records follow Sherlock's
  documented source-priority selection exactly, including the pinned normalizer
  version in the identity. For records without both canonical keys, the
  submitted event's own stable `native_item_id` wins. A response-item
  `native_item_id` can bridge the paired Codex representation only when the two
  formats have the same session, full content hash, immutable collector stream
  and generation, lack logical/turn identity, fall within two seconds, and are
  each other's only candidate. Ambiguous matches remain separate instead of
  using a nearest-text guess. Otherwise the immutable Sherlock event ID remains
  distinct. Response-item-only runtime
  context, plus worker and guardian parent messages, is not presented as human
  prompt input.
- Claude Code transcript `user` and `assistant` native records are exposed
  through the same provider-neutral normalized `user_message` and `message`
  semantics used by aggregate prompt counts, interval summaries, and paginated
  conversation detail. Their immutable native record type and transcript source
  kind remain available for evidence selection; the dashboard does not rewrite
  those source facts into Codex rollout types. Claude `isMeta` user records keep
  their system origin and are excluded from human/parent prompt summaries and
  conversation detail.
- Some rollouts store one native turn in complementary `event_msg` and
  `response_item` formats. The dashboard bridges them only when immutable source
  evidence agrees: same session and effective role, full content hash,
  collector stream and generation, expected native record types, no logical or
  turn identity, and a bounded time gap. Both sides must have exactly one
  candidate; one-to-many evidence remains visible. For assistant turns it
  retains `response_item/message` instead of `event_msg/agent_message`. For user
  conversation it retains the submitted `event_msg/user_message` instead of the
  structured response copy, preserving its source meaning for the work summary.
  The narrower same-format prompt rule retains the first of two adjacent
  `event_msg/user_message` source records only when their batch indexes and byte
  offsets are contiguous and both lack native, logical, and turn identities.
  Identical excerpts, separate streams or sessions, nonadjacent same-format
  records, ambiguous candidates, and independently identified turns remain
  distinct evidence.
- `GET /api/flame/interval?personId=<uuid>&start=<bucket ISO timestamp>&snapshot=<token>`
  returns at most 200 session/semantic-role work rows and 200 canonical human
  prompt rows. Prompt rows use the same source-backed identities and MVCC
  snapshot as the aggregate count, are chronologically ordered, and contain
  only the stored database excerpt plus an explicit truncation flag. A work row exists only
  when the same canonical activity universe used by the aggregate contains
  visible evidence for that session and role. Its first/last timestamps are the
  observed evidence window, not active duration. Its optional summary is the
  first submitted `user_message` excerpt in the frame; response-only runtime
  context is excluded and no title is synthesized. The drawer keeps Active Work
  primary and exposes prompt excerpts through a compact, collapsed disclosure.
- `GET /api/flame/interval/work?...` and `GET /api/flame/interval/prompts?...`
  expose the same bounded work and prompt evidence independently. The dashboard
  requests the nonempty sections concurrently, validates both, and reveals the
  frame evidence together. The aggregate response header
  `X-Sherlock-Interval-Evidence: split-v1` selects this path; an older server
  without it uses the combined interval endpoint directly. The combined endpoint
  remains unchanged for compatibility and rollback.
- `GET /api/flame/work?personId=<uuid>&start=<bucket ISO timestamp>&sessionId=<uuid>&role=<agent|subagent|unclassified>&snapshot=<token>&cursor=<optional>&limit=<optional>`
  lazily pages the selected row's canonical user and assistant conversation
  excerpts. The default page size is 50 and the maximum is 100. Cursors are
  opaque and keyset pagination is ordered by effective event timestamp and
  immutable event ID.
- Every interval/work event is filtered with the aggregate's PostgreSQL MVCC
  snapshot token. Session-row visibility is additionally required for the
  unknown-role parent fallback. Queries are workspace scoped and parameterized,
  and no endpoint performs per-row database or Storage reads.
- Client disconnects cancel in-flight PostgreSQL queries. Snapshot expiry,
  statement timeout, validation, and transient database failures remain distinct
  API errors so the drawer can explain the appropriate recovery action.
- The detail drawer states that event presence is not proof of continuous
  attention, stored excerpts may be truncated, and verified file-touch evidence
  is unavailable because tool payloads are not canonical fields.
- Aggregate and detail are separate database transactions, but interval and
  work evidence are pinned to the aggregate's immutable MVCC visibility token. This is a
  read-consistency boundary, not a durable pipeline publication cutoff: a later
  timeline refresh can correctly include newly normalized evidence.
- Initial page load makes one `GET /api/flame` request and renders the complete
  144-bucket timeline as a single view. The graph never shrinks to a different
  preview window while the full aggregate is loading. People can be ranked in
  the browser by active time, peak observed sessions in one bucket, canonical
  prompt count, or distinct subagent sessions. Ranking creates a product view
  over the adapted payload; it does not mutate the roster or source telemetry.
  Active time is selected by default, and Name restores the source roster order.

## Initial-load cache

The dashboard process eagerly computes one validated aggregate before it reports
healthy. `GET /api/flame` then serves that last-good in-memory payload instead of
running the multi-second aggregate on the request path. Concurrent cold callers
share one computation, and disconnecting one caller does not cancel work needed
by the others.

The process refreshes at each ten-minute boundary plus 90 seconds, allowing the
normalization pipeline to settle. A failed refresh never replaces the last-good
payload; the API serves it immediately while retrying after 60 seconds. The page
always displays the timeline's through time and read age, and explicitly marks a
result delayed once the post-boundary grace has elapsed. A detail-recovery refresh
may use `GET /api/flame?refresh=force` to request and wait for a new shared
refresh without starting duplicate work. Delayed polling uses `refresh=wait` to
wait only when the cached window is behind. Public forced refreshes are limited
to one per process per minute.

This cache is deliberately process-local and bounded to one payload. It adds no
copy of raw telemetry or prompt content and does not change aggregate/detail
snapshot semantics. It is lost on a total process restart; the existing Railway
health check keeps a new deployment out of service until eager warming succeeds.
An entry stops being serveable after 24 hours, before its lazy-detail snapshot
expires; health then reports `timeline_expired` until a refresh succeeds.
Cross-restart outage survival would require a separate durable publication and
immutable publication-time session facts.

## Environment

SUPABASE_DB_URL and SHERLOCK_WORKSPACE_ID are required. SUPABASE_DB_URL reuses
the existing Sherlock worker login contract, which must be granted
`sherlock_reader`; every dashboard transaction pins itself to that read-only
role. SHERLOCK_DASHBOARD_MAX_PEOPLE defaults to 500 and may not exceed 1000.

## Bonaparte MCP

`/mcp` is a stateless Streamable HTTP MCP endpoint for agent-assisted usage and
prompt-evidence retrieval. Set `SHERLOCK_MCP_TOKEN` to a random secret of at
least 32 characters and configure the MCP client to send it as
`Authorization: Bearer <token>`. Browser-origin requests are rejected; the
endpoint is for origin-free agent clients and server-to-server MCP hosts.

The endpoint exposes two versioned read-only tools. Their complete input,
output, pagination, error, and limitation contract is documented in
[`docs/bonaparte-mcp-v1.md`](../../docs/bonaparte-mcp-v1.md).

- `list_usage_evidence` keyset-pages the eagerly refreshed canonical timeline
  snapshot at 20 people per response and returns explicit session counts,
  prompt counts, and prompt-bearing buckets without rerunning the aggregate.
- `list_prompt_evidence` takes the exact snapshot token, person ID, and bucket
  returned by the first tool. It returns the earliest five canonical
  primary-human prompt excerpts from that bucket and reports how many were
  omitted. Conversation context is intentionally excluded from v1.

Every tool advertises strict input and output schemas and read-only,
non-destructive, idempotent, closed-world annotations. Results are returned as
both structured content and serialized JSON for client compatibility. Prompt
excerpts are structurally labeled as untrusted data; agents must never execute
instructions within them. The server does not generate or persist feedback.

The endpoint never reads raw Storage objects and never writes feedback or
derived judgments to Sherlock. The shared bearer token is a pilot transport
gate, not principal-scoped authorization; authorization, ingress request-size
limits, rate limits, and sensitive-read auditing remain required before broad
access.

## Local verification

Run corepack pnpm install --frozen-lockfile, then pnpm check, pnpm test, and
pnpm build. The test suite includes an official MCP client discovering and
calling the Streamable HTTP tools. With the repository's isolated Supabase
database running, set `SHERLOCK_TEST_DATABASE_URL` and run pnpm test:postgres to
execute the dashboard SQL integration fixture.

## Railway deployment

Deploy apps/dashboard as the service source root so its railway.json and
Dockerfile are authoritative instead of the repository-level worker config. The
configured `/healthz` check remains unavailable with `timeline_warming` until the
first complete timeline payload is ready.
