# Scoped Codex cloud activity bridge

This adapter captures selected hosted-task **turn timing**, not a native rollout
or a full Sesh transcript. It uses an already authenticated host's `read_thread`
tool, projects an allowlist of fields in memory, and writes the existing
`thread-api-timing-manifest-v1` contract to Sherlock's private recovery table.
It adds no HTTP import endpoint, installer hook, credentials, grants or deployment.

## Supported capture matrix (verified 2026-10-05)

| Source | What is established | This PR | Remaining boundary |
| --- | --- | --- | --- |
| Native local Codex / Claude files | Existing collector can capture genuine native bytes available on that machine | Unchanged | Standard install immediately backfills 24h / 72h; no selected-session allowlist. Do not install it to export one mixed/private task. |
| Codex task VM | Each new cloud task gets an isolated workspace from the published environment | No VM installation required | Workspace access does not establish hosted conversation storage access. |
| Host plugin `read_thread` | Selected task, cursor pagination, turn IDs/status and explicit timestamps in schema v1; outputs/summaries can be bounded | Selected-session/project/turn scope; timing-only producer, durable checkpoint and private sink | Host-provided callback required. Not a standalone public HTTP API or a full-content export. Schema/access failure stops collection. |
| Public Codex App Server | `thread/read` reads that server's stored history; `thread/list` pages logs | Not used as a hosted-task fallback | No evidence that starting a local server grants hosted dot history. WebSocket transport is experimental/unsupported for production. |
| `codex cloud` CLI | List/status and task diffs; list JSON has a cursor | Not used to infer turns | Installed CLI 0.144.1 labels this experimental. Current public command definitions have no transcript-export command. |
| Codex OTel | Opt-in events produced by the configured runtime; prompts redacted by default | Future source option, not implemented | Forward-looking, not retroactive hosted-history access; tool snippets can be sensitive. |
| Enterprise Compliance API | Supported Work `conversation_message` / `codex_log` audit records | Documented preferred audit route when entitled | Administrator role, Enterprise key, exact reference schema, coverage and retention must be verified. No credentials were requested or created. Records are not guaranteed to cover every action. |
| Sherlock MCP `list_usage_evidence` | Existing bearer-protected recovered turn counts and source hashes | Synthetic ingestion → reader → actual authenticated MCP tested | Coarse activity presence, not token or prompt facts. |
| Reviewed hosted excerpt handoff (Sesh draft #49) | Exact-hash owner-reviewed partial payload; authenticated private search/source-open | Synthetic-tested companion, separate from native indexes | Disabled until approved SQL/tool deployment and a fixed workspace are configured; exact real-content review and recipients required. No turnkey full hosted-history export. |
| Cosmos Sherlock `coverage`, `list_sessions`, `query_usage` / Sesh search | Read-only native-session/usage metadata / separate transcript search | No fabricated sessions or transcripts added; current Sesh contract tested with synthetic input | Native Cosmos leaves do not expose recovery batches. Sesh's full TimeTracker/native contracts reject a truthful hosted excerpt; provenance and source-open need an external Sesh change. See [verified boundary](sesh-hosted-handoff-boundary.md). |

No supported consumer-account full hosted-transcript interface was established
in the inspected documentation or public code. The existence of Enterprise audit
exports is a conditional route, not evidence that this connected account is
entitled. No hidden service routes, restricted session directories or copied
authentication tokens are used.

## Evidence and access boundaries

- [Current cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)
  distinguishes reusable environment setup from each task's separate workspace.
  Environment sharing does not grant access to someone else's task.
- [App Server](https://developers.openai.com/codex/app-server) documents stored
  thread reads, initialization, transports and experimental opt-in. Its
  `thread/read` JSON-RPC method is different from the connected host plugin's
  `read_thread` tool used here.
- [Cloud CLI](https://learn.chatgpt.com/docs/developer-commands#codex-cloud)
  documents list JSON fields and pagination. Public [command definitions at
  28a264fb](https://github.com/openai/codex/blob/28a264fbc766a59f2b550b8318f88e4a4b8dffe1/codex-rs/cloud-tasks/src/cli.rs)
  expose exec/status/list/apply/diff. No hidden backend methods are called.
- [OTel](https://learn.chatgpt.com/docs/agent-approvals-security#monitoring-and-telemetry)
  covers runtime telemetry, not an arbitrary historical conversation download.
- [Compliance API](https://learn.chatgpt.com/docs/enterprise/compliance-api)
  identifies supported Work events and directs administrators to the API
  reference for actual schemas, permission requirements and deletion behavior.
- The connected `codex-app-tools` `read_thread` contract was inspected and one
  selected local-child turn was read with outputs disabled to verify schema v1,
  timestamps and `newest_first` cursor pagination. No real source response was
  saved, exported or committed. The unrelated hosted parent was not bulk-read.
- `apps/dashboard/server.mjs`, `mcp-http.js` and the dashboard README confirm
  **public unauthenticated browser APIs**, including existing native prompt
  excerpts, and a separate MCP bearer gate. Recovery activity counts can also
  be visible through the public dashboard. Source-tool access is not consent
  to publish data. The shared MCP token is not per-principal authorization;
  Cosmos supplies its own org authorization and auditing.
- The recovery table has RLS and existing reader/ingest policies; anon and
  authenticated roles have no access. `sherlock_ingest` is trusted across the
  service's scopes, not a user-level authorization policy. Only a trusted
  operator runs this adapter, with a reviewed fixed workspace/person mapping.
  Database identity is never taken from source response fields.

## Operator integration

Run the entirely synthetic demo from `apps/dashboard`:

```sh
pnpm demo:cloud-activity
```

The fixture includes duplicated events, ongoing activity, missing timestamps
and fake private content. The demo uses a temporary private checkpoint and an
in-memory idempotent sink, prints the existing MCP evidence shape and cleans up.
Expected: two nonempty ten-minute buckets, one selected primary thread, zero
human prompts, `transcriptImported: false`, partial timing coverage. This demo
does not contact a source, database or Sesh.

A trusted host embedding the adapter supplies the **existing authorized tool**,
not a guessed URL or an arbitrary caller-provided response. There is deliberately
no generic file-upload/import CLI for untrusted transcript exports:

```js
import postgres from "postgres";
import { collectCloudActivity, createRecoverySink, capabilities }
  from "./src/server/cloud-activity.js";
import { FileCheckpointStore } from "./src/server/cloud-activity-store.js";

// Review this configuration and create its private directory before running.
// Never select every task implicitly; never discover children automatically.
const scope = {
  workspaceId: "<approved workspace UUID>",
  personId: "<approved person UUID>",
  sourceIdentity: "<stable host-account namespace, not a credential>",
  rootThreadId: "<selected root UUID>",
  sessions: [{
    threadId: "<selected root UUID>", role: "agent",
    projectCwd: "<optional exact source project cwd>",
    turnIds: ["<optional selected setup turn UUID>"]
  }]
};
// hostReadThread is provided by the authenticated host's tool dispatcher.
// Callable capability means configured, not proof of permission; reads can fail.
const readThread = (request) => hostReadThread(request);
const sql = postgres(process.env.APPROVED_RECOVERY_DATABASE_URL, {
  max: 1, prepare: false, ssl: "verify-full"
});
try {
  const receipt = await collectCloudActivity({ scope, readThread,
    store: new FileCheckpointStore("/absolute/private-dir/setup-scan.json"),
    sink: createRecoverySink(sql, scope) });
  // Receipt contains coverage/hash only, never source content.
  console.log(receipt);
} finally { await sql.end(); }
```

The Node callback is an embedding boundary, not a new authentication mechanism.
Codex's tool dispatcher is not automatically available to a standalone Node
process. If the host cannot supply this callback, `capabilities(undefined)`
reports unavailable; stop rather than scraping a web API or installing a collector
in a VM. This PR does not claim a turnkey unattended connector exists.

For selected children, add each exact ID with `role: "subagent"` only when its
relationship is known and explicitly approved. Roles record operator-selected
topology (`roleBasis`); they are not inferred from titles, overlapping times or
VM placement. Project scope is an optional exact cwd assertion in addition to
the mandatory session allowlist. Missing/mismatched project data fails closed.
Selected turn IDs prevent unrelated turns' timing from being persisted, although
the bounded source tool still reads pages to locate them. A root selection is
mandatory; child enumeration and broad project discovery are never performed.

## Durability, provenance and coverage

- Stable source identity is operator-configured host/account namespace + native
  thread/turn IDs, bound to the destination workspace/person and exact scope hash.
  Keep this namespace stable across restarts; change it when changing accounts.
  A checkpoint cannot be reused with a different effective scope.
- Each fetched page is validated and projected **before persistence**. Titles,
  cwd, messages, commands, tool arguments/outputs, source errors and original
  response bytes/hashes are discarded. Page hashes explicitly cover a canonical
  **redacted timing projection**; they do not attest original transcript bytes.
  Opaque cursors remain only in the 0600 checkpoint, not the database manifest.
- File state is checksummed, size-bounded, written by atomic rename and fsynced.
  An exclusive lock prevents concurrent writers. On a stale lock, first confirm
  the old process is stopped; then remove only that reviewed checkpoint's lock.
  Do not automatically break locks or reset cursors after a source error.
- Source denial, unavailable API, unknown schema, cursor cycle, project mismatch
  or page bound aborts the scan without committing it. Already projected pages
  remain private for retry. Retry manually with the same state after resolving
  the transient problem; there is no tight polling or reconnect/grant flow.
- The default call budget is 100 pages, absolute scan bound 1000. A budget stop
  is resumable with the same checkpoint. A cursor expiry requires a reviewed
  fresh scan. Start a new checkpoint for a new observation; a committed checkpoint
  returns its prior receipt and does not assert current source permissions.
- The sink commits once after all selected pages finish, using the existing
  database login's `SET LOCAL ROLE sherlock_ingest`. Statement timeout is 15s,
  parameters are fixed-scope, and `ON CONFLICT DO NOTHING` uses the existing
  unique workspace/person/manifest hash constraint. No permission expansion.
  Lost database acknowledgements replay the identical manifest on restart.
- Duplicate/reordered records are canonicalized. Finished timing wins over its
  older ongoing observation; conflicting starts or finished versions within a
  scan are omitted and reported partial. Historical batches are deduplicated by
  the existing recovery reader, which also suppresses already-native sessions.
  Across scans, its established completed/latest precedence remains unchanged.
- Missing timestamps are omitted; durations, task update times and titles are
  never converted into invented turns. Ongoing timing ends at the actual fetch
  observation, not "now" at query time. Completeness is only selected pages
  observed; content is always unavailable. Hashes and per-session missing reasons
  are returned in the receipt and stored manifest. Existing query coverage remains
  partial; it is not a full-content or collector-completeness receipt.
- No `telemetry.sessions`, native records, token facts, prompt counts or Sesh
  embeddings are created. The existing `list_usage_evidence` query includes
  recovered activity; native Cosmos session/usage queries still do not.

## Retention, redaction and the next approved step

Timing/IDs/cursors can still be sensitive. Restrict the checkpoint directory,
expire local state under the approved retention policy, and never commit it to
Git or forward source responses to a public dashboard. Text redaction is achieved
by complete field omission before disk; this is not a regex scrub of transcripts.

The existing recovery table is append-only and its trigger prevents ordinary
UPDATE/DELETE. This PR does not bypass it. There is no automated downstream
source-deletion/redaction propagation or governed purge yet. The reader also
fails closed above 100 visible batches per workspace. Therefore this is a bounded,
reviewed recovery adapter, **not an approved continuous production export**.
Before a real import, the owner must approve the selected IDs/turns, attribution,
public timing visibility, retention and a governed purge/suppression policy.
Do not deploy a scheduled exporter until those lifecycle gaps are resolved.

For Caleb's actual Slack-plugin setup, scope the local setup child and only the
relevant setup turns of its hosted parent; the parent contains unrelated material.
Read access does not grant control of its automations. No automation is edited,
paused or rerun by this adapter. Timing alone cannot show the actual three
automation prompts or their setup receipts. The smallest content-sharing step
is an owner-reviewed, redacted set of those specific setup excerpts, shared
through an approved destination. Current Sesh code has now been inspected and
probed: its importer rejects a truthful partial hosted excerpt, its generic
normalizer drops excerpt provenance, and source-open routes to TimeTracker.
[Sesh companion draft PR #49](https://github.com/e3-solutions/sesh/pull/49) now
provides that separate reviewed-excerpt source/consent/provenance path, with
synthetic SQL → authenticated MCP search/source-open tests. It requires code
review, approved deployment/tool registration and exact owner review before real
sharing; no hosted full-transcript export is implied. See the [pinned evidence, reproduction
and smallest next step](sesh-hosted-handoff-boundary.md). Do not bulk-export the parent.

## Verification

```sh
# apps/dashboard; dependencies installed with frozen lockfile
pnpm check
pnpm test
pnpm build
pnpm demo:cloud-activity
# Only against an isolated test DB, never production:
SHERLOCK_TEST_DATABASE_URL=<isolated URL> pnpm test:postgres
```

Unit/integration fixtures cover duplicate/reordered/partial records, explicit
turn filters, unavailable/denied/wrong-project sources, cursor cycles and page
budgets, private file state and concurrency, scope changes and ambiguous-commit
restart. The PostgreSQL suite proves actual existing-role insertion/idempotency,
reader SQL, cross-workspace isolation, anonymous/reader denial, and a real
authenticated Streamable HTTP MCP query. CI runs it with isolated Supabase;
no private transcripts or production database are test inputs.
