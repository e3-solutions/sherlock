# Sherlock dashboard

The dashboard serves the CodeActivity Flame experience from Sherlock's canonical
private telemetry schemas. It is a single workspace-scoped service: every query
uses SHERLOCK_WORKSPACE_ID, every database transaction is repeatable-read and
read-only, and the server assumes Sherlock's existing sherlock_normalizer role.

The browser never receives database credentials. The page and aggregate API
are public; every database query remains pinned to one configured workspace.
The aggregate API does not return prompt text. Lazy interval and work-detail
endpoints return only canonical normalized evidence for one person and one
ten-minute bucket. Message content is limited to
`telemetry.events.content_excerpt`; the dashboard never reads full raw Storage
objects.

## Data contract

- `telemetry.people` is the roster, so real people with zero activity remain
  visible. The stable synthetic identity `github_id = 'sherlock-smoke'` is
  excluded; display names are never used as the filter.
- Canonically selected `sherlock.codex-rollout.v1` event presence is grouped into
  144 ten-minute UTC buckets. Distinct Sherlock execution sessions are counted
  per effective role and bucket; they are not native thread or duration counts.
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
- primary is Agent; worker and guardian are Subagent; unknown is Unclassified.
  automation is excluded. When a v1 event is `unknown` but its Sherlock session
  has a resolved parent, the dashboard presents it as Subagent: parent topology
  is resolved source-backed session evidence that it is child work even when an
  older Codex payload encoded `source.subagent` as a string the v1 normalizer did
  not classify.
  Unknown root sessions remain Unclassified; stored event roles are not changed.
  Detail queries require both the event row and the current session-row version
  to have been visible to the aggregate snapshot. If parent metadata changes
  after that snapshot, detail fails stale instead of silently changing the role.
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
- `GET /api/flame/prompts?personId=<uuid>&start=<bucket ISO timestamp>&snapshot=<token>` lazily
  returns every stored prompt excerpt for the selected bucket, ordered by its
  canonical timestamp. `truncated: true` distinguishes the 1,024-byte database
  excerpt from full raw content retained in private Storage. `/api/flame`
  captures a PostgreSQL MVCC snapshot token; the detail query accepts only
  event rows whose creating transaction was visible to that exact aggregate
  snapshot. Late normalization therefore cannot make a drawer disagree with
  the selected bar.
- `GET /api/flame/interval?personId=<uuid>&start=<bucket ISO timestamp>&snapshot=<token>`
  returns at most 500 canonical prompts and 200 session/semantic-role work
  rows. A work row exists only when the same canonical activity universe used
  by the aggregate contains visible evidence for that session and role. Its
  first/last timestamps are the observed evidence window, not active duration.
  Its optional summary is the first submitted `user_message` excerpt in the
  frame; response-only runtime context is excluded and no title is synthesized.
- `GET /api/flame/work?personId=<uuid>&start=<bucket ISO timestamp>&sessionId=<uuid>&role=<agent|subagent|unclassified>&snapshot=<token>&cursor=<optional>&limit=<optional>`
  lazily pages the selected row's canonical conversation, tool, lifecycle,
  reasoning, and error evidence. The default page size is 50 and the maximum
  is 100. Cursors are opaque and keyset pagination is ordered by effective
  event timestamp and immutable event ID.
- Every interval/work event and its joined session-row version is filtered with
  the aggregate's PostgreSQL MVCC snapshot token. Queries are workspace scoped
  and parameterized, and no endpoint performs per-row database or Storage reads.
- Normalized tool facts include tool name, call ID, status, timestamp, and
  stored repository/context labels. Tool arguments, outputs, and file paths
  are not projected as structured tool fields, so the API explicitly reports
  that verified file-touch evidence is unavailable instead of inferring it.
  Message excerpts can contain serialized tool text from a source, but those
  strings are conversation evidence rather than proof that a file was accessed
  or changed.
- The response declares partial observed-event coverage because event presence
  is exact evidence for a bucket but is not proof of continuous attention.
- Aggregate and detail are separate database transactions, but prompt details
  are pinned to the aggregate's immutable MVCC visibility token. This is a
  read-consistency boundary, not a durable pipeline publication cutoff: a later
  timeline refresh can correctly include newly normalized evidence.
- Initial page load makes one `GET /api/flame` request and renders the complete
  144-bucket timeline as a single view. The graph never shrinks to a different
  preview window while the full aggregate is loading.

## Environment

SUPABASE_DB_URL and SHERLOCK_WORKSPACE_ID are required. SUPABASE_DB_URL reuses
the existing Sherlock worker login contract, which can assume
sherlock_normalizer. SHERLOCK_DASHBOARD_MAX_PEOPLE defaults to 500 and may not
exceed 1000.

## Local verification

Run corepack pnpm install --frozen-lockfile, then pnpm check, pnpm test, and
pnpm build. With the repository's isolated Supabase database running, set
`SHERLOCK_TEST_DATABASE_URL` and run pnpm test:postgres to execute the dashboard SQL
integration fixture.

## Railway deployment

Deploy apps/dashboard as the service source root so its railway.json and
Dockerfile are authoritative instead of the repository-level worker config.
