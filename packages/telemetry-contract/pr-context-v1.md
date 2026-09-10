# Explicit session PR context, v1

A link declares that a specific native session concerns a GitHub PR. It is **collector-reported PR context with GitHub identity checked**, not proof of authorship, uploader authentication, or attribution of all session events, time, tokens, or cost. The current collector endpoint accepts declared collector identity. Checking GitHub identity does not authenticate the claimed person/session relationship.

A session can have zero, one, or multiple linked PRs. Ending work does not retract a link. Use a retraction only to correct a particular erroneous link event; link/retract history and raw inputs remain available for audit. Starting SHA/commit associations remain separate from explicit intent. The compact UI shows PR numbers; hover text identifies each association source.

## Sidecar and envelope

Each immutable UTF-8 JSONL sidecar contains one event. Native Codex rollout and Claude transcript bytes are never edited. The producer stores sidecars under `<state-root>/pr-context/events/<event-id>.jsonl` and uses the existing durable spool, gzip payload, Storage, committed receipts, normalization, and worker pipeline.

Link:

```json
{"type":"sherlock.pr-context.v1","event_id":"00000000-0000-4000-8000-000000000006","operation":"link","provider":"codex","native_session_id":"00000000-0000-4000-8000-000000000004","occurred_at":"2026-09-09T15:00:00Z","repository":"owner/repo","pull_request_number":91}
```

Retraction:

```json
{"type":"sherlock.pr-context.v1","event_id":"00000000-0000-4000-8000-000000000007","operation":"retract","provider":"codex","native_session_id":"00000000-0000-4000-8000-000000000004","occurred_at":"2026-09-09T15:05:00Z","link_event_id":"00000000-0000-4000-8000-000000000006"}
```

The `sherlock.rollout-batch.v1` envelope uses `source_kind=collector`, `source_provider` equal to the event provider (`codex` or `claude_code`), `source_version=sherlock.pr-context.v1`, and `observed_native_session_id` equal to the event session. Parent session metadata is absent. Source stream identity hashes the schema, provider, exact native session ID, and event UUID; generation key is the event UUID, sequence and offset start are zero. Provider is part of the stream identity to avoid cross-provider collisions in existing spool/Storage paths.

Event UUIDs are canonical lowercase UUIDs. Native session IDs are opaque and case-sensitive; the CLI accepts up to 512 ASCII letters, digits, `.`, `_`, `:`, and `-`, beginning with a letter or digit. Claude subagent native IDs need not be UUIDs. Repository input is an explicit GitHub `owner/repository` name, not a URL. PR number is a positive signed 32-bit integer (at most 2147483647). Times are timezone-aware RFC3339 timestamps. Retracts reference a different event UUID and cannot retarget a session, provider, collector, or workspace. Consumers validate record identity against its envelope and resolve the session only within that exact scope. Context arriving before its native session remains pending; it must not create a session or attach to a similarly named session.

## Manual producer (both providers)

Use the same installed collector configuration and state root used to capture that session. Global arguments precede `pr-context`. Both provider and native session ID are mandatory; there is no latest-session selection or branch/worktree/global active-state inference.

The `sherlock-collector` console command is available when the Python package is
installed. The standard plugin installers instead copy the runtime; invoke it
directly (with the upgraded runtime) without a global package install:

```sh
PYTHONPATH="${CODEX_HOME:-$HOME/.codex}/sherlock/runtime" \
  python3 -m sherlock_collector.cli --provider codex pr-context link \
  --session-id EXACT_NATIVE_SESSION_ID --repository owner/repo --pr-number 91 --drain

PYTHONPATH="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sherlock/runtime" \
  python3 -m sherlock_collector.cli --provider claude_code pr-context link \
  --session-id EXACT_NATIVE_SESSION_ID --repository owner/repo --pr-number 91 --drain
```

From a checkout, replace the runtime path with `packages/telemetry-collector/src`.
Use that same module invocation for `create`, `retract`, and `drain` below.

```sh
sherlock-collector --provider codex pr-context retract \
  --session-id 00000000-0000-4000-8000-000000000004 \
  --link-event-id 00000000-0000-4000-8000-000000000006 --drain
```

Use the returned `event_id` when correcting a link. `--event-id UUID` makes manual retries idempotent. Repeating an identical declaration with that ID requeues the exact same raw bytes and recorded time; any changed content is rejected locally. An optional `--occurred-at RFC3339` supports explicit replay. Use a new UUID for a genuinely separate declaration.

If available, a native file whose name matches the selected session is checked against its provider-native header. `--transcript PATH` requires a particular native file beneath the selected provider home to match. Mismatches and cross-provider files fail closed. A missing native file is allowed as a manual declaration (`identity_check=collector-declared`) so PR context can arrive before session normalization. A local header check (`native-file-checked`) is an accident-prevention check, not an authenticated actor guarantee. Parent/subagent links are never inherited.

Omit `--drain` to queue offline. Normal collector drains deliver pending batches; `sherlock-collector --provider codex drain` explicitly retries delivery. With `--drain`, successful enqueue returns exit zero even if the delivery result reports a requeued or dead-letter batch: `queued` means locally durable, not verified or visible. Inspect `delivery`/collector health and server projection state separately. Sidecars survive acknowledgement. If interrupted after sidecar persistence but before enqueue, repeat `link`/`retract` with the same event ID and arguments; never edit the saved file. Retained sidecars and their queued transport metadata are bound to the installed collector email, installation ID, and destination endpoint. Every HTTP drain checks that binding before delivery, including offline retries; mismatched records remain queued until the original configuration is restored. This prevents accidental relabeling by another local configuration.

## PR creation integration

The collector wraps the actual successful GitHub CLI creation operation and queues a link to the returned PR. This works when work began before a PR existed, including review-only sessions. An agent integration supplies the **exact current native session ID** from its own provider invocation (or passes it as an explicit argument); do not derive it from shared checkout state. `gh` must already be installed and authenticated. Head and repository are explicit, including a fork-qualified head when needed.

```sh
sherlock-collector --provider codex pr-context create \
  --session-id 00000000-0000-4000-8000-000000000004 \
  --repository owner/repo --head contributor:feature \
  --title 'Implement feature' --body 'Description and validation' --draft --drain
```

The wrapper calls `gh pr create` with argument arrays, checks exit success and the exact returned `https://github.com/owner/repo/pull/NUMBER` URL, then emits the same link event as the manual producer. It does not parse transcript commands or treat an attempted command as a successful operation. No link is queued on GitHub CLI failure. If creation succeeds but local persistence fails, the error includes the created URL: use manual `link` for that PR rather than creating another PR. Remote PR creation and local enqueue cannot be one atomic transaction; after interruption, check GitHub before retrying creation. Existing PRs, review sessions, second PRs, and reopened PRs use manual `link`.

## Server interpretation and rollout

The server accepts only this narrowly versioned collector source. Context records produce no activity, tokens, or native session metadata changes. Store append-only declaration/retraction facts with source-record provenance and deduplicate retries. Keep verification observations separate. Retraction may arrive before its referenced link; it becomes effective only against the exact matching scope. Conflicting declarations invalidate the ambiguous event. A conflicting retraction suppresses every exactly scoped link it references rather than resurrecting previously retracted context. Snapshot visibility uses the ingestion/snapshot boundary, including retractions and verification, rather than trusting collector-reported `occurred_at` as a visibility boundary.

GitHub verification uses its direct PR endpoint after checking the workspace repository allowlist. Never fetch arbitrary URLs, fall back to a broad token search, or expose private repository metadata outside permitted scope. A configured repository can be checked even for closed, merged, reopened, or renamed PRs; GitHub canonical identity determines the verified association. Pending, inaccessible, rejected, or conflicting declarations must not be presented as verified links. Verification proves PR identity/access only.

Deploy the append-only schema and compatible ingest/worker handling before enabling producers or configured repository scope. The default verification scope is empty. Old native producers continue to work. Older ingest rejects collector context rather than misclassifying it; an early producer may therefore dead-letter context and require replay after server upgrade. Do not enable producers until server capability is verified. Preserve raw payloads and facts on rollback; disable new production without deleting historical audit data.

## Reproducible collector checks

```sh
PYTHONPATH=packages/telemetry-collector/src python3 -m unittest discover -s tests/collector
```

See [the local end-to-end workflow](../../tests/end-to-end/README.md) for
collector-to-dashboard acceptance coverage. Unit tests and local integration
results do not establish production behavior.
