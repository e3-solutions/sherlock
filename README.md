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

The Edge Function uses custom bearer authentication because collector tokens
are not Supabase user JWTs. Configure `SHERLOCK_COLLECTORS_JSON` with token
hashes plus server-owned workspace/person/collector attribution. Deployed Edge
Functions receive `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`SUPABASE_DB_URL` from Supabase; none of these server credentials belong in the
collector. The database client disables prepared statements so the same code
also works with a transaction-pooler URL in local or self-hosted environments.
