# Sherlock

Codex session telemetry for team-wide activity analysis, starting with a
correct, auditable Flame graph.

The deliberately small v0 source-of-truth contract is documented in
[docs/data-schema.md](docs/data-schema.md).

## Rollout collector slice

The first rollout-only delivery slice lives in
`packages/telemetry-collector` and
`supabase/functions/sherlock-rollout-ingest`. Capture atomically spools stable
gzip bytes before launching a detached drain; the drain requires a versioned
committed receipt before deleting an artifact.

Run the focused checks from the repository root:

```sh
PYTHONPATH=packages/telemetry-collector/src \
  python3 -m unittest discover -s tests/collector -v
deno check supabase/functions/sherlock-rollout-ingest/index.ts
deno test supabase/functions/sherlock-rollout-ingest/service_test.ts
```
