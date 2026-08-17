# Sherlock dashboard

The dashboard serves the CodeActivity Flame experience from Sherlock's canonical
private telemetry schemas. It is a single workspace-scoped service: every query
uses SHERLOCK_WORKSPACE_ID, every database transaction is repeatable-read and
read-only, and the server must successfully assume sherlock_reader.

The browser never receives database credentials. HTTP Basic authentication is
required for the page, static assets, and /api/flame; /healthz is the only
public route and returns only readiness state.

## Data contract

- telemetry.people is the roster, so people with zero activity remain visible.
- Latest non-tombstoned sherlock.activity.v1 spans are intersected with 144
  ten-minute UTC buckets. Distinct sessions are counted per role and bucket.
- primary is Agent; worker and guardian are Subagent; unknown is Unclassified.
  automation is excluded.
- Canonical, non-replay sherlock.codex-rollout.v1 human message events supply
  prompt counts. Prompt text and conversation content are never selected.
- The response declares partial aggregate coverage because Sherlock does not yet
  implement workspace snapshot activation or detailed conversation read APIs.

## Environment

SHERLOCK_READER_DATABASE_URL, SHERLOCK_WORKSPACE_ID,
SHERLOCK_DASHBOARD_USERNAME, and SHERLOCK_DASHBOARD_PASSWORD are required.
The database login should be NOINHERIT and a member only of sherlock_reader.
SHERLOCK_DASHBOARD_MAX_PEOPLE defaults to 500 and may not exceed 1000.

## Local verification

Run corepack pnpm install --frozen-lockfile, then pnpm check, pnpm test, and
pnpm build.
