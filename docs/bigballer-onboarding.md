# Big Baller Brand Wheels

Big Baller uses the existing shared Sherlock Supabase database, ingest endpoint,
and telemetry processor, with a distinct workspace and dashboard service.
Only the exact email domain `bigballerbrandwheels.com` routes to this workspace.
Existing E3 and Sixtyfour workspace mappings remain unchanged.

Configure ingest with `SHERLOCK_BIGBALLER_WORKSPACE_ID` set to the workspace UUID.
The value is optional for older deployments; missing configuration rejects Big
Baller uploads. Malformed IDs or IDs reused from E3/Sixtyfour fail closed.

Configure the dashboard with its own `SHERLOCK_WORKSPACE_ID` and
`SHERLOCK_DASHBOARD_EMAIL_DOMAIN=bigballerbrandwheels.com`. Share the existing
Supabase connection through a Railway variable reference. Do not reuse another
organization's MCP credential. This rollout does not introduce admin accounts,
authenticated dashboard users, or email ownership verification; it follows the
existing approved-domain rollout contract.

Production dashboard: https://bigballer-dashboard-production.up.railway.app

Employees run the team installer with their own name, GitHub username, and
company email. Until the onboarding change is merged, clone the
`arya/bigballer-onboarding` branch instead of `main`. Start a new Codex or
Claude Code session after installation. At least one supported agent CLI must
already be installed.

Verification includes approved-domain routing, rejection of lookalike domains
and duplicate workspace IDs, dashboard build/tests, and a synthetic ingest using
`github_id=sherlock-smoke` so the onboarding probe does not appear in the roster.
