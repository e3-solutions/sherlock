# Bonaparte production alerting

If Bonaparte has access to the shared Grafana Cloud account, use it with one `#bonaparte-alerts` channel; otherwise stop before rollout rather than introducing another vendor. Phase 1 is deliberately outcome-first and requires no Bonaparte runtime or database change: two three-region synthetics cover dashboard readiness and pipeline freshness, one rule owns missing synthetic telemetry, and two narrowly scoped Supabase rules cover missing metrics and sustained pool pressure. Railway owns only terminal deployment failure, and direct Slack delivery fails closed until an existing filtered receiver or a production-and-two-service-only project is proven. Every check is disabled and every Grafana rule is paused in source until controlled firing and recovery tests pass.

These files are a reviewed desired-state contract, not portable Grafana provisioning exports. Grafana/Synthetic Monitoring versions, datasource UIDs, project labels, live resource UIDs, and secrets are tenant-specific and must be discovered during the guarded setup below.

## Files and ownership

- `synthetic-checks.json`: disabled HTTP check contract.
- `alert-rules.json`: five paused rules with immutable UIDs.
- `notification-routing.json`: exact policy subtree and one contact point.
- `notification_templates/bonaparte_slack_message.tmpl`: firing, resolved, mixed, empty, and missing-label-safe message.
- `validate_bundle.py`: secret-free validation and lifecycle simulation.
- `../railway/alerts.json`: terminal deployment boundary and fail-closed Railway delivery gate.
- `runbook.md`: operator actions and notification-only rollback.
- `apply-receipt.example.json`: auditable, secret-free read-back record for a later live rollout.

Grafana owns endpoint outcomes, database headroom, Slack grouping/repeats, and recovery. Railway may own a one-shot `Deployment.failed` event only after exact production scope is proven. No other system should emit a second notification for the same condition.

## Phase 1 matrix

| Signal | Source | Threshold/window | Severity | Slack behavior | Owner | First runbook action |
|---|---|---|---|---|---|---|
| Dashboard unavailable | Grafana Synthetic Monitoring `/healthz` | 3 probes every 60s; HTTP 200 + `status=ok`; missing series counts failed; at least 2 fail for 2m | Critical | Group 30s; repeat 2h; resolved | Grafana | Compare regions, then inspect dashboard deployment/logs and cache readiness. |
| Pipeline freshness delayed | Grafana Synthetic Monitoring `/api/flame/freshness?refresh=wait` | HTTP 200 + `delayed=false` + freshness header `hit`; missing series counts failed; at least 2 fail for 5m while health quorum is good | Warning | Group 2m; repeat 4h; resolved | Grafana | Inspect receipt watermarks/pending age, then worker deployment/logs and aggregate queue state. |
| Synthetic telemetry missing | Grafana Prometheus | Either complete exact-target job absent for 10m; aggregate to one instance | Warning | Group 2m; repeat 4h; resolved | Grafana | Repair the check, probes, or datasource before touching Bonaparte. |
| Supabase telemetry missing | Grafana Prometheus | Exact-project `pg_up`, `pgbouncer_up`, or waiting-client series absent for 5m; aggregate to one instance | Warning | Group 2m; repeat 4h; resolved | Grafana | Repair the integration/project selector; do not assume the database is down. |
| Pool clients waiting | Grafana Prometheus | Sum of exact-project waiting clients >5 for 10m | Warning | Group 2m; repeat 4h; resolved | Grafana | Inspect active/waiting connections and Bonaparte's bounded connection budget before scaling. |
| Production deployment failed | Railway project event | Terminal `Deployment.failed`, dashboard/worker only | Warning | One event; no success/repeat/recovery event | Railway | Inspect build/deploy logs and fix forward or redeploy last known-good. |

`/healthz` checks configuration and last-good timeline-cache readiness; it does not prove database or telemetry freshness. The freshness endpoint can serve an old receipt after a failed refresh, so its header assertion is mandatory. The outcome expressions use `3 - sum(max by (probe)(...))` so a missing regional series counts as failed; `count - sum` would under-count it.

The separate explicit `pg_up=0` / `pgbouncer_up=0` page was rejected for Phase 1 because the freshness check already owns database-caused product impact and a second critical would duplicate the incident. Keep the zero-valued series visible on the dashboard. Promote it only if an incident shows the freshness outcome is materially too slow or ambiguous.

## Slack contract

The parent policy requires all three exact labels:

```text
service = bonaparte
environment = production
owner = bonaparte
```

Its only Bonaparte Slack child routes are exact `severity = critical` and `severity = warning`. Both group by `alertname, component`. Missing, `info`, or unknown severity is not sent to `#bonaparte-alerts`; Grafana falls through to the existing default receiver. Record that receiver during read-back and verify this behavior in Grafana's routing preview. Resolved notifications are enabled.

The message is intentionally bounded:

```text
🚨 FIRING · Bonaparte
<alert name>
<one-sentence description>
CRITICAL · <component>
Dashboard · Logs · Runbook
```

Recovery changes the title to `✅ RESOLVED`, says the condition returned to normal, and keeps the links. The template iterates `.Alerts.Firing` or `.Alerts.Resolved`, never only common annotations, so mixed and recovery groups remain populated. Do not add query values, raw label dumps, job IDs, source paths, logs, prompts, tokens, or webhook URLs.

## Offline verification

Run before every live change:

```bash
python3 observability/grafana/validate_bundle.py validate
python3 observability/grafana/validate_bundle.py simulate
python3 -m unittest discover -s observability/grafana/tests -v
```

The simulation covers healthy/unhealthy endpoint responses, delayed and stale freshness receipts, 2-of-3 probe quorum, dashboard/freshness suppression, and exact Slack routing. Tests also reject rule inventory drift, unpaused rules, missing labels/descriptions, broad matchers, disabled recovery, unsafe template scope, credential-like values, and unsafe Railway configuration.

Offline tests do not prove the live datasource's series names/labels, Grafana's selected build, actual Slack delivery, public probe execution, or Railway project scope. Those are controlled live gates—not assumptions.

## Unresolved access and configuration questions

Resolve these before following the implementation steps:

1. Does Bonaparte have access to the shared `e3capital.grafana.net` stack and an operator who can create alerting resources?
2. What are the production HTTPS origin, Grafana Prometheus datasource UID, Bonaparte dashboard/explore URLs, and exact Supabase project-ref label/value?
3. Do the live Synthetic Monitoring account's public probes have the names in `synthetic-checks.json`, and does the selected HTTP check support both response-body and response-header regex assertions?
4. Who can create the protected `#bonaparte-alerts` webhook/contact point, and who are the named primary and backup owners?
5. What is the shared Grafana default receiver, and does it already own datasource execution errors? Every Bonaparte rule explicitly uses Grafana's `Error` state; verify both fall-through paths without broadening the Bonaparte Slack subtree.
6. Are Railway production and staging in separate projects, is the production project limited to dashboard/worker, and what are the exact project/environment/service IDs and names? If project-wide delivery cannot isolate both environment and services, leave direct Slack disabled unless an existing filtered receiver does so.

These questions are gates. They are not placeholders to substitute blindly.

## Guarded setup sequence

1. Record the source commit, operator, Grafana/Synthetic versions, datasource UID, default receiver, discovered Supabase labels, probe names, Railway IDs/names, and a fingerprint or export of every non-Bonaparte notification route. Run `validate_bundle.py fingerprint` for canonical desired-state hashes. Keep any secret-bearing backup in a private directory outside Git.
2. Run all offline verification commands above.
3. In Grafana, create `Bonaparte Production Slack` and load the checked-in template. Enter the webhook only in Grafana's secret field. Do not export and re-import a masked secret.
4. Add only the Bonaparte policy subtree beneath the existing default receiver. Do not replace the root policy. Create its exact parent/children and grouping intervals. Freshness deduplication lives in the rule expression's health gate; do not add a second title-coupled inhibition.
5. Create both synthetic checks disabled. Resolve the production origin, confirm exactly three distinct live `probe` labels and the exact `instance` label for each target, then enable the checks. Disable or exclude any default Synthetic Monitoring notification rule that would duplicate this bundle.
6. Create the five alert rules paused in folder `bonaparte`, group `bonaparte-production`. Resolve datasource/link/project placeholders and put the default labels plus component/severity on each live rule.
7. Preview every PromQL expression. `probe_success` must show three regions per exact target; `pg_up`, `pgbouncer_up`, and the pool metric must show only the Bonaparte project. Prove the waiting-client series is continuously exported even at zero before enabling the pool and missing-metrics rules; otherwise omit the pool rule rather than treating absence as healthy. A missing or renamed series blocks activation.
8. Perform controlled firing/recovery tests. Enable one warning at a time, then critical rules one at a time. Wait at least one full evaluation plus grouping window after each change.
9. Read back every rule, contact, policy route, check, datasource selector, and Railway event choice. Complete the explicit field attestations in `apply-receipt.example.json`, confirm the default receiver and unrelated routes are unchanged, and record Railway as `not_applied_gate_closed` when its delivery gate remains closed. The source fingerprints identify the reviewed bundle; they are not comparable to tenant-specific Grafana or Railway exports.

## Controlled live tests

- Template/contact: preview firing, resolved, mixed, empty, missing-severity, and missing-description fixtures in the same Grafana engine version. Then send the contact-point test.
- Slack lifecycle: create a temporary constant rule with the exact Bonaparte production labels and `component=test`; observe exactly one firing, flip the same instance false, observe a non-empty resolved notification, then delete it.
- Synthetic lifecycle: create a temporary dedicated check and a cloned test rule whose exact job/instance selectors point to it. Use a reserved 404 target or failing assertion, observe firing, correct the same target/assertion, observe resolved, then delete both. Never change a production rule, check, or endpoint.
- Supabase: preview real healthy metrics, then use a cloned constant rule for Slack firing/recovery. Never induce an outage, pool exhaustion, or deadlock.
- Railway: use Test Webhook, remembering it can report a browser CORS false negative. Enable direct Slack only through an existing filtered receiver or when the project contains only production and only dashboard/worker. Then run a reversible failed-start, confirm exact resource names, and verify a normal successful deploy does not post.

## Do not add

- Better Stack or another page-policy vendor.
- `/mcp`, `/api/flame`, authentication, or routine 401 probes.
- Per-retry, per-job, success, restart, lease-heartbeat, or transient error alerts.
- A second warning/critical ladder for the same signal.
- Generic 5xx/log alerts, deadlocks, rollback ratio, CPU, RAM, disk, storage, or network Slack alerts without incident evidence and an actionable threshold.
- Direct Railway crash Slack; Grafana already owns runtime impact and the project-wide delivery scope is unresolved.
- Raw/private/high-cardinality values or secrets in rules and messages.
- Automated service stops, queue deletion, requeue without review, or telemetry cleanup as alert remediation.

## Phase 2 gate

Phase 1 does not see a live normalization job after it becomes terminal `failed`, because the freshness aggregate counts only `queued` and `leased`. Add backend work only after an audit or incident demonstrates `status=failed` while the receipt reports `pendingNormalize=0` and `delayed=false`.

The minimal change is to extend the existing bounded freshness aggregate and response with only `terminalFailedCount` and `oldestTerminalFailedAt`, scoped to live normalization and the visible roster. Expose no IDs, errors, leases, hashes, payloads, or paths. Add one warning when the count stays above zero for five minutes until reviewed/requeued. This preserves immutable raw telemetry, auditable queue facts, and the separation between source data and the product-specific view.

Do not add stored `lastSuccessfulIngestAt`: `rawWatermark` already represents the latest committed ingest across the visible roster. Missing-ingest alerting needs an agreed collector heartbeat or operating-hours cadence first.

## Evidence and external contracts

- Bonaparte health/freshness separation and receipt contract: [dashboard README](https://github.com/e3-solutions/sherlock/blob/5ff740f2e33a2c25f0af7955e8fa23c7cb596b5f/apps/dashboard/README.md#L194-L222), [routes](https://github.com/e3-solutions/sherlock/blob/5ff740f2e33a2c25f0af7955e8fa23c7cb596b5f/apps/dashboard/server.mjs#L152-L178), [freshness route](https://github.com/e3-solutions/sherlock/blob/5ff740f2e33a2c25f0af7955e8fa23c7cb596b5f/apps/dashboard/server.mjs#L220-L240).
- Stale freshness behavior: [freshness cache](https://github.com/e3-solutions/sherlock/blob/5ff740f2e33a2c25f0af7955e8fa23c7cb596b5f/apps/dashboard/src/server/freshness-cache.js#L46-L74).
- Terminal-failure blind spot and existing raw watermark: [freshness SQL](https://github.com/e3-solutions/sherlock/blob/5ff740f2e33a2c25f0af7955e8fa23c7cb596b5f/supabase/migrations/20260821202758_add_dashboard_freshness.sql#L106-L138).
- Shield's paused rules, three-region checks, missing telemetry, database patterns, and routing: [rules](https://github.com/e3-solutions/theft/blob/4d9a00658bc052c8dab70c0ca1c78111b5265cd9/observability/grafana/alert-rules.json), [synthetics](https://github.com/e3-solutions/theft/blob/4d9a00658bc052c8dab70c0ca1c78111b5265cd9/observability/grafana/synthetic-checks.yaml), [routing](https://github.com/e3-solutions/theft/blob/4d9a00658bc052c8dab70c0ca1c78111b5265cd9/observability/grafana/notification-routing.json).
- Frontline's exact route/label validation and recovery renderer regression: [manager](https://github.com/e3-solutions/negotiation/blob/86053699554a82622171fb67c6c417583425072c/observability/grafana/manage_kch_slack_alerts.py), [tests](https://github.com/e3-solutions/negotiation/blob/86053699554a82622171fb67c6c417583425072c/observability/grafana/tests/test_manage_kch_slack_alerts.py), [incident](https://github.com/e3-solutions/negotiation/blob/86053699554a82622171fb67c6c417583425072c/observability/grafana/alerts/cor-3326/README.md).
- Grafana HTTP checks support status, body, and header validation: [Grafana Synthetic Monitoring](https://grafana.com/blog/how-to-perform-http-checks-in-grafana-cloud-synthetic-monitoring/).
- Supabase recommends its Grafana Cloud integration with a one-minute scrape: [Supabase Metrics API](https://supabase.com/docs/guides/monitoring-and-debugging/metrics/grafana-cloud).
- Railway project webhooks span all environments and direct Slack uses a Muxer: [Railway webhooks](https://docs.railway.com/observability/webhooks), [alerting guide](https://docs.railway.com/guides/alerts-crashes-failed-deploys).
