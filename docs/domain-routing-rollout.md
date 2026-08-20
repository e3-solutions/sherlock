# Approved-domain rollout

The code change does not provision or deploy production infrastructure. Before
deploying it, an operator must create the `sixtyfour.ai` workspace in the shared
Supabase database and record its UUID. The existing E3 workspace is unchanged.

Configure the shared Edge Function with distinct valid values for
`SHERLOCK_E3_WORKSPACE_ID` and `SHERLOCK_SIXTYFOUR_WORKSPACE_ID`. Keep the one
public ingest URL; collectors never select a workspace.

Run two Railway services from `apps/dashboard`. Configure both with the shared
database URL and their own `SHERLOCK_WORKSPACE_ID`. Set
`SHERLOCK_DASHBOARD_EMAIL_DOMAIN=e3group.ai` on the existing service and
`SHERLOCK_DASHBOARD_EMAIL_DOMAIN=sixtyfour.ai` on the new service, then assign
the separate dashboard URLs. Verify `/healthz` and the empty/new Sixty Four
roster before distributing its URL.

Each dashboard URL, page, and browser API is public and unauthenticated,
including detail endpoints that can return stored prompt excerpts. The domain
setting selects the tenant-facing product view; it is not user authorization
and does not prove that a collector controls its declared email address. Only
the separately bearer-gated MCP endpoint has a transport credential.

Missing, malformed, or duplicate Edge workspace IDs fail closed. Missing or
unapproved dashboard domains keep that service unavailable. Existing telemetry
is neither moved nor deleted; dashboard domain filtering is a product view over
the immutable workspace facts.
