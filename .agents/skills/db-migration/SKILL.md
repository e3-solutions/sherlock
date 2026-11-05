---
name: db-migration
description: Change the Sherlock database (tables, indexes, functions, RLS, grants, roles, triggers) through migration history on a large and busy production database, test it on the local stack, apply it in a safe window, and keep the repo file matching the recorded version. Use for any schema or SQL function change, new index, grant, or a release blocked on SQL.
---

# Database migration

Data model and roles: `docs/data-schema.md` ("Database roles"). Production project:
`psmuyotyyojrkojycyzz`.

## Rules

- **Only through migration history.** Apply with the Supabase MCP `apply_migration`,
  using the file's name and SQL. **Never `supabase db push`:** production history
  has production-only and renamed versions that this folder does not have. Never
  paste DDL into the SQL editor.
- **After applying, rename the repo file** to the version recorded in production
  history, so repo and ledger match.
- **Busy database rules:**
  - No index builds or large scans between 03:00 and 19:00 UTC.
  - Build indexes `concurrently`, in a migration of their own, following
    `supabase/migrations/20261104214000_index_message_search_windows.sql`: a short
    `lock_timeout` (`1s`), a long `statement_timeout` (`30min`), and a restart-safe
    check that drops an invalid index left by an earlier attempt. A short
    `statement_timeout` cancels the build and leaves an invalid index.
  - Other DDL: a short `lock_timeout` so it fails fast instead of queueing behind traffic.
  - On Nov 4, hand-run queries overlapping an ingest stall made an outage worse.
- **Least privilege.** Grant to the narrow roles (for example `sherlock_ingest`,
  `sherlock_processor`, `sherlock_normalizer`, `sherlock_reducer`,
  `sherlock_frame_projector`, `sherlock_reader`) and not to the owner. New tables in exposed schemas need RLS.
- **Forward-only.** Never edit an applied migration; add a new one. Changes must
  work with the worker and dashboard that are already running.

## Steps

1. Add `supabase/migrations/<timestamp>_<what>.sql` with a timestamp newer than
   every existing file.
2. Test locally the way CI does (`.github/workflows/ci.yml`): start the isolated
   stack (`supabase start --exclude …` as in CI), then run
   `supabase test db --local supabase/tests/database/schema.test.sql` and the
   relevant Postgres integration tests (`SHERLOCK_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`).
   Stop the stack when you finish (`supabase stop --no-backup`). The Mac is short on memory.
3. Open the PR and get review on the SQL itself.
4. With approval, in the allowed window: read the SQL in full, then
   `apply_migration`. Check that the version appears in the migration history.
5. Rename the repo file to the recorded version if it differs, and commit.
6. Add a Linear comment (project Frontline): migration name, applied time, and the check you ran.

## Report

Migration file and recorded version, window used, locks or timeouts set, tests
run, the post-apply check, and anything deferred.
