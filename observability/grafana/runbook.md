# Bonaparte alert runbook

Preserve raw telemetry, queue history, and database facts during every response. Alerts authorize diagnosis, not deletion, broad requeue, schema mutation, or service shutdown.

## Dashboard unavailable

1. Compare all three regions. One failed region is not an incident; two or more for two minutes is.
2. Open Railway's production dashboard deployment and logs. Check deployment state, configuration errors, and the `/healthz` reason.
3. Remember that `/healthz` reports configuration and last-good timeline-cache readiness, not pipeline freshness.
4. If a deployment is causal, fix forward or roll back only that dashboard deployment.
5. Confirm two healthy regions and one resolved Slack notification.

## Pipeline freshness delayed

1. Confirm dashboard health is good; the freshness rule's health gate suppresses this alert during a total dashboard outage.
2. Inspect `read`, `rawWatermark`, `canonicalWatermark`, `oldestPendingNormalize`, `pendingNormalize`, and `delayed` from the receipt. Do not copy person-level activity into Slack.
3. Confirm the response header is `X-Sherlock-Freshness-Cache: hit`. `stale` indicates refresh failure even if the body still says `delayed=false`.
4. Inspect the production worker deployment and `job_failed` / `job_retry_scheduled` logs as diagnostic evidence, not separate alerts.
5. Query aggregate queue counts by status/job kind/workload. Review terminal failed rows before any targeted requeue; never delete history.
6. Confirm the same check returns a fresh receipt from two regions and emits one resolved message.

## Synthetic telemetry missing

1. Check the Grafana Synthetic Monitoring integration, both exact check targets, and all three probes.
2. Confirm the Prometheus datasource is accepting Synthetic Monitoring metrics.
3. Do not restart Bonaparte merely because monitoring data disappeared.
4. Recover the missing series and confirm the alert resolves.

## Supabase telemetry missing

1. Verify the exact Bonaparte project-ref selector and one-minute scrape job.
2. Check integration credentials/rotation and reachability of the Supabase Metrics API without printing the secret.
3. Compare application health/freshness before treating this as a database outage.
4. Restore the integration and confirm `pg_up`, `pgbouncer_up`, and `pgbouncer_pools_client_waiting_connections` are all present for the exact Bonaparte project selector before resolution.

## Connection pool queue sustained

1. Inspect waiting and active clients, connection limits, dashboard/worker connection budgets, and recent deployments.
2. Identify the workload holding connections before scaling or restarting anything.
3. Prefer fixing the causal query/session lifecycle. Do not kill unknown production sessions automatically.
4. Confirm waiting clients remain at or below five for a complete evaluation window and the warning resolves.

## Railway deployment failed

1. Verify the event names production and exactly the dashboard or worker service.
2. Inspect build/deploy logs and the candidate commit.
3. Fix forward or redeploy the last known-good image. The previous healthy deployment may still be serving, so Grafana outcome alerts can remain green.
4. Do not subscribe to deployment success solely to manufacture recovery. The next deployment record and Grafana outcomes provide recovery evidence.

## Notification-only rollback

1. Disable or detach only the Bonaparte policy subtree/contact point. Preserve the default receiver and other teams' routes.
2. Pause only the `bonaparte-production` rule group.
3. Disable/remove only the two Bonaparte synthetic checks and the Bonaparte Railway webhook choice if they are faulty.
4. Restore a pre-change contact/policy backup only after a fresh read proves live state has not changed concurrently. Stop and reconcile any third state.
5. Read back the notification tree and compare unrelated routes with the private pre-change export.
6. Never roll back alerting by stopping services, changing Supabase, deleting queue rows, reclassifying facts, or modifying raw telemetry.
