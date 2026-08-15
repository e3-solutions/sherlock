# Sherlock

Codex session telemetry for team-wide activity analysis, starting with a
correct, auditable Flame graph.

The Supabase database foundation and rollout collector drain are implemented;
normalization and product read paths are next.

- [Data architecture and drain contract](docs/data-schema.md)
- [Canonical database migration](supabase/migrations/20260814225047_initial_sherlock_schema.sql)
- [Database verification](supabase/tests/database/schema.test.sql)

Run the focused collector checks with:

```sh
PYTHONPATH=packages/telemetry-collector/src python3 -m unittest discover -s tests/collector -v
deno check supabase/functions/sherlock-rollout-ingest/index.ts
deno test supabase/functions/sherlock-rollout-ingest/service_test.ts
```
