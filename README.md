# Sherlock

Codex session telemetry for team-wide activity analysis, starting with a
correct, auditable Flame graph.

The Supabase database foundation is implemented; the collector drain and
product read paths are next.

- [Data architecture and drain contract](docs/data-schema.md)
- [Canonical database migration](supabase/migrations/20260814225047_initial_sherlock_schema.sql)
- [Database verification](supabase/tests/database/schema.test.sql)
