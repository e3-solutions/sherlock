# Sherlock dashboard

The dashboard serves the CodeActivity Flame experience from Sherlock's canonical
private telemetry schemas. It is a single workspace-scoped service: every query
uses SHERLOCK_WORKSPACE_ID, every database transaction is repeatable-read and
read-only, and the server assumes Sherlock's existing sherlock_normalizer role.

The browser never receives database credentials. The page and aggregate API
are public; every database query remains pinned to one configured workspace.
The aggregate API does not return prompt text. The interval prompt endpoint
returns only the canonical `telemetry.events.content_excerpt` rows for one
person and one ten-minute bucket; it never reads full raw Storage objects.

## Data contract

- `telemetry.people` is the roster, so real people with zero activity remain
  visible. The stable synthetic identity `github_id = 'sherlock-smoke'` is
  excluded; display names are never used as the filter.
- Canonically selected `sherlock.codex-rollout.v1` event presence is grouped into
  144 ten-minute UTC buckets. Distinct Sherlock execution sessions are counted
  per effective role and bucket; they are not native thread or duration counts.
  Metadata-only lifecycle records are not activity evidence.
  The timeline intentionally does not use `analytics.activity_spans`: those
  spans are inferred lifecycle boundaries and can cross days, so painting them
  as continuous timeline evidence would overclaim what Sherlock observed.
- The person rail's 24-hour active time is a separate product summary. It selects
  the latest revision of each completed `sherlock.activity.v1` span, excludes
  tombstones, provisional open spans, and automation, clips the remaining spans
  to the dashboard window, and unions every overlap for the person before
  summing. Nested tools and parallel agent or subagent sessions therefore never
  count the same wall-clock second twice. The result remains an estimate from
  inferred boundaries, not measured attention or CPU runtime. Newly normalized
  events can appear before the asynchronous reducer publishes their spans, so a
  later refresh may increase the active-time summary for the same window.
- UUIDv7 `native_item_id` values provide the original creation timestamp for
  response items copied into a later rollout. Envelope timestamps remain the
  fallback for event types without a stable native item ID.
- primary is Agent; worker and guardian are Subagent; unknown is Unclassified.
  automation is excluded. When a v1 event is `unknown` but its Sherlock session
  has a resolved parent, the dashboard presents it as Subagent: parent topology
  is resolved source-backed session evidence that it is child work even when an
  older Codex payload encoded `source.subagent` as a string the v1 normalizer did
  not classify.
  Unknown root sessions remain Unclassified; stored event roles are not changed.
- The person rail shows unioned 24-hour active time alongside read-relative
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
  formats have the same session and content hash and timestamps within two
  seconds. The closest candidate wins with deterministic stable-ID tie breaking;
  repeated matches to one native ID collapse to that stable prompt for the
  person even when copied across session histories. Otherwise the immutable
  Sherlock event ID remains distinct. Response-item-only runtime
  context, plus worker and guardian parent messages, is not presented as human
  prompt input.
- `GET /api/flame/prompts?personId=<uuid>&start=<bucket ISO timestamp>&snapshot=<token>` lazily
  returns every stored prompt excerpt for the selected bucket, ordered by its
  canonical timestamp. `truncated: true` distinguishes the 1,024-byte database
  excerpt from full raw content retained in private Storage. `/api/flame`
  captures a PostgreSQL MVCC snapshot token; the detail query accepts only
  event rows whose creating transaction was visible to that exact aggregate
  snapshot. Late normalization therefore cannot make a drawer disagree with
  the selected bar.
- The response declares partial observed-event coverage because event presence
  is exact evidence for a bucket but is not proof of continuous attention.
- Aggregate and detail are separate database transactions, but prompt details
  are pinned to the aggregate's immutable MVCC visibility token. This is a
  read-consistency boundary, not a durable pipeline publication cutoff: a later
  timeline refresh can correctly include newly normalized evidence.
- Initial page load requests `GET /api/flame?window=recent` first. That bounded
  read computes and renders the latest twelve ten-minute buckets (two hours),
  including window-scoped active time and an immutable snapshot receipt. Once
  it is visible, the browser requests the normal `GET /api/flame` response and
  replaces the recent view with all 144 buckets. Refreshes after the first full
  response continue to use the complete endpoint without shrinking the graph.

## Environment

SUPABASE_DB_URL and SHERLOCK_WORKSPACE_ID are required. SUPABASE_DB_URL reuses
the existing Sherlock worker login contract, which can assume
sherlock_normalizer. SHERLOCK_DASHBOARD_MAX_PEOPLE defaults to 500 and may not
exceed 1000.

## Local verification

Run corepack pnpm install --frozen-lockfile, then pnpm check, pnpm test, and
pnpm build.

## Railway deployment

Deploy apps/dashboard as the service source root so its railway.json and
Dockerfile are authoritative instead of the repository-level worker config.
