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

The workflow uses the real Python native capturer and PR-context CLI producer,
durable spool and HTTP drain, ingestion handler over TCP, local Supabase Storage,
Postgres roles and tables, worker queue/normalizer/reducer, frame activation, and
the actual dashboard HTTP day/interval routes. GitHub responses are deterministic
fixtures at the external API boundary; worker units cover the HTTP error and PR
lifecycle response matrix. Replay/conflict cases vary collector envelopes as
untrusted clients; they do not rewrite native transcripts.

The assertions cover Codex and Claude, review without commits, links before
native normalization and after work starts, starting SHA A while declaring B,
multiple PRs, shared checkout isolation, wrong provider/session/workspace,
offline retry, duplicate and conflicting declarations, late and out-of-order
retraction, inaccessible lookups, scope rejection, stable GitHub identity drift,
old dashboard snapshot visibility, and unchanged native/Storage bytes, activity,
and session metadata.

Local success establishes implementation behavior with synthetic data. It does
not establish production identity authentication, token permissions, capacity,
migration locking, or canary behavior. Collector reports remain declarations;
GitHub checks establish PR identity only.
