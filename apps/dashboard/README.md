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
- Canonical `sherlock.codex-rollout.v1` event presence is grouped into 144
  ten-minute UTC buckets. Distinct sessions are counted per role and bucket.
  The dashboard intentionally does not intersect `analytics.activity_spans`:
  those spans are inferred lifecycle boundaries and can cross days, so treating
  them as continuous attention overclaims what Sherlock observed.
- UUIDv7 `native_item_id` values provide the original creation timestamp for
  response items copied into a later rollout. Envelope timestamps remain the
  fallback for event types without a stable native item ID.
- primary is Agent; worker and guardian are Subagent; unknown is Unclassified.
  automation is excluded.
- Canonical, non-replay primary-session submitted user messages supply prompt counts.
  The response-item `native_item_id` deduplicates copied history and the paired
  event-message form. Response-item-only runtime context, plus worker and guardian
  parent messages, is not presented as human prompt input.
- `GET /api/flame/prompts?personId=<uuid>&start=<bucket ISO timestamp>` lazily
  returns every stored prompt excerpt for the selected bucket, ordered by its
  canonical timestamp. `truncated: true` distinguishes the 1,024-byte database
  excerpt from full raw content retained in private Storage.
- The response declares partial observed-event coverage because event presence
  is exact evidence for a bucket but is not proof of continuous attention.

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
