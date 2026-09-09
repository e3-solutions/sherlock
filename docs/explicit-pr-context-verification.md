# Explicit PR context verification — 2026-09-09

The real local collector-to-dashboard workflow and native telemetry regression
suites pass on synthetic data. This establishes local implementation behavior;
it does not establish production behavior, authenticated attribution, production
token access, capacity, or migration locking. Neither PR was merged or deployed
by this verification.

## Tested implementation and environment

- Feature: COR-4126 / [PR #91](https://github.com/e3-solutions/sherlock/pull/91),
  implementation committed as `e2fb1071f01f2dcf7b21d69ba695d4207fec219c`.
- Refreshed main: `16e80ba5dd84184e5e33e71296d538159969bd9f`.
- Runtime: CI-pinned Deno 2.5.1 and Supabase CLI 2.114.0; local Node 26.5.0.
  CI uses Node 24.15.0 and its own clean stack.
- Dedicated `sherlock-pr81` Colima profile, explicit Docker socket, and existing
  `sherlock-pr81-local` network. Postgres and Storage were bound to loopback.
  Default Docker context and SSH configuration were not changed.
- The retained local schema contains both PR #81's additive migration and
  #91's migration. The stricter checked-identity constraint was aligned with the
  reviewed #91 migration before the final run. These results must therefore not
  be described as a fresh main-plus-#91-only schema run. CI is configured to
  create that independent clean stack.

## Results

| Check | Result |
| --- | --- |
| Explicit-context real HTTP end-to-end workflow | Passed; 3 native sessions, 22 successful/replayed receipts |
| Full collector unit suite | 149 passed |
| Dashboard non-database tests | 273 passed; syntax checks and production build passed |
| Current main schema plus explicit-context schema assertions | 160 passed: 146 existing and 14 new |
| Dashboard Postgres integrations | 30 passed |
| Normalizer, reducer, queue, frame-projector Postgres integrations | 9 passed |
| PostgreSQL disconnect/reconnect regression | Passed |
| 72,591,045-byte Codex and Claude native end-to-end tests | 2 passed |
| Feature end-to-end TypeScript entrypoint | Type check passed |
| Actual dashboard browser behavior | Parent verified interval/session drawer, checked link, provenance label, and unavailable non-links |

The final feature workflow retained workspace
`a7ea1fa0-7f52-44df-b9dc-18d1418561fa`. Its synthetic native and sidecar files are
in `/var/folders/8w/js9gvlp95l1_bz2rhh27gmv80000gp/T/sherlock-pr-context-3c94e3ef8fcf639b`.
The browser check used the earlier retained complete fixture workspace
`564304f9-5323-4ece-9865-aa139a79a7a5`. These are local fixture identifiers.

The workflow executes the real Python native capturer and PR-context CLI, durable
spool, ordinary HTTP drain, ingestion handler over a loopback TCP server, local
Supabase Storage, Postgres role boundaries and append-only facts, worker queue,
normalizer/reducer, frame activation, and actual dashboard day/interval HTTP
routes. Provider homes and collector environment are isolated so an existing
collector endpoint cannot override the local fixture configuration.

Nine direct-PR requests used deterministic GitHub boundary responses. A separate
read-only `gh api repos/e3-solutions/sherlock/pulls/91` request succeeded and its
live response passed the production direct-PR identity validator. This verifies
the CLI account's read access and validator behavior, not the production
worker's token. Closed/merged/reopened, redirect, inaccessible, identity-drift
and failure cases remain controlled fixtures; no live PR was created or changed
by this test.

## Acceptance evidence

- Codex and Claude native activity survive explicit context. Review-only native
  sessions contain no commits. A sidecar arriving first persists one fact and
  creates no session or activity; later native normalization binds by exact
  collector/provider/native identity.
- A real worker commit-to-PR lookup records PR #81 for starting SHA A. Dashboard
  responses retain that separate `pullRequest` while explicit `linkedPrs`
  contain #91/#92/#95. Context changes never promote or replace commit evidence.
- Multiple sessions share a synthetic checkout and reused branch name without
  sharing declarations. The direct PR fixture includes a fork head. Wrong
  provider, missing native session, and foreign workspace reports never bind to
  the target session. Invalid URL and native transcript/session selections fail
  in the producer.
- An HTTP 503 retains a durable sidecar and a subsequent ordinary drain succeeds.
  Exact HTTP replay adds no fact. Repeated declarations from distinct transport
  streams retain duplicate provenance. Conflicting event IDs retain conflict
  facts and suppress uncertain associations.
- Retractions received before their link suppress it. Late retraction removes
  its particular declaration. A conflicting retract neither resurrects its
  first target nor exposes its alternate target. Snapshots taken before each
  change continue to show only facts visible at that snapshot.
- Scope rejection makes no request to the broad-token GitHub boundary. Redirects
  use manual handling. Fresh observations respect retry eligibility. Closed,
  merged and reopened states remain valid identity observations; changed stable
  repository IDs are persisted as identity mismatch. Old snapshots retain the
  earlier checked observation.
- Cross-provider collision on the legacy native-session uniqueness key produces
  an explicit failed normalization without modifying the existing session.
  Native-file hashes, every returned Storage-object hash, activity counts, and
  full native session rows remain unchanged through context operations.

## Findings resolved during real integration

The first Ubuntu CI attempt passed the existing suites but exposed inherited
`LD_LIBRARY_PATH` from Python setup when Deno started the dashboard subprocess.
Deno correctly rejects loader-variable inheritance with its bounded executable
allowlist. The dashboard and optional GitHub child now receive explicit minimal
environments, as the Python child already did. A focused subprocess check with
an injected library path passed without broadening run permissions; the final
PR checks provide the independent clean-stack CI result.

The first complete pipeline attempt exposed an activation-proof assumption:
`backfill-frame-evidence.ts` expected every source record to yield a native
activity event. Correctly normalized context sidecars therefore blocked frame
activation. Collector context is now excluded from that activity-specific proof;
the final genuine pipeline passes without inventing events. This is why widening
the ingestion allowlist alone was insufficient.

The actual dashboard HTTP tests also enforce that unchecked declarations have
no URL, separately from UI anchor rendering. Independent adversarial review
found and corrected offline collector/destination drift, unsafe creation
ordering, response overflow, conflicting-retract resurrection, and a multi-event
sidecar lock-order hazard. See
[the adversarial review](explicit-pr-context-adversarial-review.md) for exact
mechanisms and focused test evidence.

## Reproduction and release boundary

The committed runner and fixtures are documented in
[the end-to-end README](../tests/end-to-end/README.md). From a repository checkout
with a dedicated local Supabase stack and all migrations applied:

```sh
node tests/end-to-end/run-pr-context.mjs
# Optional read-only GitHub endpoint validation:
SHERLOCK_TEST_LIVE_GITHUB=1 node tests/end-to-end/run-pr-context.mjs
supabase test db --local supabase/tests/database/schema.test.sql supabase/tests/database/pr_context.test.sql
```

CI now type-checks and runs the feature workflow after its existing native
end-to-end suites. A local VM that mounts only its original test directory must
receive copies of current schema test files inside that mount before invoking
the CLI; no additional host filesystem mount is needed. Local regression logs
are `/private/tmp/sherlock-pr91-{schema,dashboard-database,worker-database,reconnect,oversized}.log`.

See [compatibility verification](explicit-pr-context-compatibility-verification.md)
for old-main/new-schema and combined-PR evidence, and
[the coordinated rollout plan](explicit-pr-context-rollout.md) for production
approval gates. Read-only production inspection cannot prove unmerged code's
runtime behavior. Such proof still requires an explicitly authorized canary and
observation period; this task provides reviewable PRs and the plan, not that
production proof.
