# Explicit PR context local acceptance workflow

Run `node tests/end-to-end/run-pr-context.mjs` from the repository root with a
dedicated local Supabase stack already running and all repository migrations
applied. The dashboard's dependencies must be installed with its frozen lockfile.
Use the Deno version pinned in CI. Database tests must run sequentially: this
workflow claims real queue jobs and deliberately rejects unrelated workspace
jobs instead of processing somebody else's fixtures.

The runner reads local development credentials from `supabase status -o json`,
passes them only through child-process environment, and refuses database or
Storage targets whose hostname is not `127.0.0.1`. It does not read `.env`, start
production infrastructure, deploy code, change GitHub objects, or merge PRs.
Ingest and dashboard HTTP servers choose ephemeral loopback ports and close at
the end. Synthetic workspaces and temporary native/sidecar files are retained
for diagnosis; the JSON result includes their IDs and paths.

Optional environment variables:

- `SUPABASE_BIN`: exact local Supabase CLI binary.
- `DENO_BIN`: exact CI-pinned Deno binary.
- `SHERLOCK_TEST_SUPABASE_PROJECT`: directory containing the running local
  Supabase project's config, if different from this checkout.
- `DOCKER_HOST`: explicit dedicated Docker socket, where needed; this avoids
  changing the user's default Docker context.
- `SHERLOCK_TEST_LIVE_GITHUB=1`: additionally fetch PR #91 through the read-only
  direct GitHub PR endpoint using existing `gh` authentication, then pass its
  response to the production identity validator. No token is printed or copied.
  This checks the authenticated CLI's access, not production-worker credentials.

The workflow uses the real Python native capturer and PR-context CLI producer,
durable spool and HTTP drain, ingestion handler over TCP, local Supabase Storage,
Postgres roles and tables, worker queue/normalizer/reducer, frame activation, and
the actual dashboard HTTP day/interval routes. GitHub failure and lifecycle
responses are deterministic fixtures at the external API boundary, explicitly
not live GitHub mutations. Replay/conflict cases act as untrusted clients by
varying collector envelopes; they do not rewrite native transcripts.

The assertions cover Codex and Claude, review without commits, links before
native normalization and after work starts, starting SHA A while declaring B,
multiple PRs, shared checkout isolation, wrong provider/session/workspace,
offline retry, duplicate and conflicting declarations, late and out-of-order
retraction, inaccessible and failed lookups, redirect/scope rejection, closed,
merged and reopened observations, old dashboard snapshot visibility, and
unchanged native/Storage bytes, activity, and session metadata.

Local success establishes implementation behavior with synthetic data. It does
not establish production identity authentication, token permissions, capacity,
migration locking, or canary behavior. Collector reports remain declarations;
GitHub checks establish PR identity only.
