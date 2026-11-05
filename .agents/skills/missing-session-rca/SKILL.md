---
name: missing-session-rca
description: Find why a Codex or Claude Code session is missing, partial or late in Sherlock (and so in Sesh), by checking the source machine's collector, its upload receipts, the ingest batches in the database, and the processing queue, in that order. Use when someone says "my session isn't in Sherlock/Sesh", coverage numbers drop, or a machine stops reporting.
---

# Missing session RCA

Collector commands and receipt semantics: `docs/collector-receipts.md`.

## Rules

- Read-only by default. Never delete the capture cursor or queue, and never
  manufacture receipts. Backfill only the named session, with the owner's yes.
- Identify sessions by ids. Do not read the session's content to debug delivery.
- Owner exclusions and excluded projects are deliberate gaps, not bugs. Check
  them first (README "Exclude a project").

## 1. Which stage lost it?

| Symptom | Stage to check first |
| --- | --- |
| Nothing from one machine since a date | Collector installed and current: jolly-roger fleet check-ins (`supabase/queries/fleet_status.sql` in jolly-roger) |
| One session missing | The machine's collector: step 2 |
| In Sherlock but not in Sesh | Sesh sync: a Sesh issue, not a Sherlock one |
| Present but late or incomplete | The processing queue: `worker-backlog` skill |

## 2. On the source machine (Codex)

```sh
export PYTHONPATH="${CODEX_HOME:-$HOME/.codex}/sherlock/runtime"
python3 -m sherlock_collector.cli inventory --session-id NATIVE_UUID
```

Inventory is read-only:
- Exit 0 means every source byte has a matching receipt.
- Exit 1 means coverage is incomplete. The reasons (missing file, unsupported
  path, discovery limit, missing acknowledgement) are distinct.

Only with a yes, run `backfill --session-id NATIVE_UUID`, then `drain`, then
`inventory` again. Backfill completion is local capture, not proof of delivery.

The Claude Code collector writes a status file in its state folder (usually `~/.claude/sherlock/telemetry/`),
for example `collector-status.json` (`runs_without_progress`, `last_progress_at`).

## 3. In the database (read-only, 1-day window, `LIMIT`)

- `telemetry.ingest_batches` by `observed_native_session_id`: did a batch commit,
  and do its byte ranges and hashes cover the file?
- `processing.telemetry_jobs` for that batch: queued, failed, or done?
- Old collector versions deleted their local acknowledgements, so check old
  sessions directly against `telemetry.ingest_batches`.

## Known causes

- Hook-only capture missed Claude transcripts. Reconciliation fixed this (COR-4920).
- The collector upload stalled during a Supabase Storage outage. Uploads retry; check the queue drained afterwards.
- An old collector pin on the machine. Collector fixes reach machines only through the Jolly Roger pin.

## Report

Session id and machine, the stage where it was lost, the evidence (exit codes,
batch ids, job status), and the fix, with whether it needs the owner's or a pin change.
