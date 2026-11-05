# Docs router

Start here after `AGENTS.md`. Find your task and read only what it lists.
Dated incident notes are history: open them when the task names that incident.

| Task | Read first | Add only when needed |
| --- | --- | --- |
| Install or verify the collector on a machine | the root `README.md` ("Install", "Verify") | `plugins/sherlock-claude-code/README.md` |
| A session is missing, partial or late | `missing-session-rca` skill, [collector-receipts.md](collector-receipts.md) | [telemetry-processing.md](telemetry-processing.md) |
| Queue backlog, failed jobs, stale dashboard | `worker-backlog` skill, `workers/telemetry-processor/README.md` | [telemetry-processing.md](telemetry-processing.md) "Inspect and recover", [dashboard-queue-recovery.md](dashboard-queue-recovery.md) (2026-10-14 incident) |
| Deploy the worker, a function, the dashboard or the collector | `deploy` skill | [telemetry-processing.md](telemetry-processing.md) "Railway deployment", "Deploy and rollback order"; `apps/dashboard/README.md` "Railway deployment" |
| Schema change | `db-migration` skill, [data-schema.md](data-schema.md) | "Database roles" in [data-schema.md](data-schema.md) |
| Data model: batches, events, versions, spans | [data-schema.md](data-schema.md) | [telemetry-processing.md](telemetry-processing.md) |
| Sherlock MCP tools (`sherlock__*`) | `apps/dashboard/README.md` "Sherlock / Bonaparte MCP" | [sherlock-query-mcp-v1.md](sherlock-query-mcp-v1.md), [sherlock-investigation-mcp.md](sherlock-investigation-mcp.md), [sherlock-default-search.md](sherlock-default-search.md), [bonaparte-mcp-v1.md](bonaparte-mcp-v1.md) |
| Dashboard performance and reads | [dashboard-session-performance.md](dashboard-session-performance.md) | `apps/dashboard/README.md` |
| Approved-domain routing | [domain-routing-rollout.md](domain-routing-rollout.md) | |
| Collective feedback hooks | [collective-feedback-hooks.md](collective-feedback-hooks.md) | |

## Keeping this useful

- One fact, one home. Link to it instead of copying it into a skill or `AGENTS.md`.
- Add a row here in the same PR that adds a durable doc.
