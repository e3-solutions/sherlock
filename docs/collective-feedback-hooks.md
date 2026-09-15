# Collective feedback hooks

Locally tested before the September 15, 2026 user-authorized release. Deploy and verify the
Forum/Cosmos backend before publishing these packages. Publication is not proof of device receipt.

## Coverage and ownership

| Subscriber path | Context delivery | Distribution path to verify at release |
| --- | --- | --- |
| Codex session tracker | existing SessionStart launcher | codex-plugins marketplace; Linear resident updater copies default plugins |
| Claude session tracker | existing SessionStart launcher | Claude plugin package/updater |
| Sherlock / Codex | parent launcher's additionalContext, separate from captured telemetry stdout | Sherlock plugin marketplace/cache |
| Sherlock / Claude Code | parent stdout; identical stdin replayed to detached telemetry child | Sherlock Claude plugin marketplace/cache |

Linear remains the distributor for the Codex tracker, not a second Collective prompt producer.
No per-repository AGENTS.md injection is needed for these subscribed plugin paths. Do not infer
that all devices subscribe, have downloaded a version, or have trusted changed hooks from this
source inspection. Sherlock collector runtime and plugin cache are separate artifacts; updating
the dashboard or copied collector runtime alone does not update the plugin guidance.

The portable `scripts/collective_feedback.py` is intentionally mirrored inside each independently
packaged plugin. The cross-repository test enforces byte parity. No imports from another installed
plugin and no runtime downloads are needed.

## Local behavior

The released default enables guidance. Explicit `E3_COLLECTIVE_FEEDBACK_HOOK_ENABLED=0` restores
legacy tracker guidance and silent Sherlock behavior. Only absent or exact `1` enables the new
cue; `E3_COLLECTIVE_HOOK_ENABLED=0` overrides it. The cue is considered only for `SessionStart` sources
`startup`, `resume`, `clear`, and `compact`. Prompt, tool, Stop, subagent and separate
PreCompact/PostCompact events remain telemetry-only. No blocking Stop hook is added.

Codex delivers SessionStart(source=compact) before the continuation model request according to
[official hook documentation](https://learn.chatgpt.com/docs/hooks). Local process tests verify
our event routing and output, not every installed client version or model's future compliance.

Scope is an explicit payload cwd with a canonical E3 GitHub HTTPS/SSH origin. Unknown aliases,
missing cwd and lookalike hosts fail closed; repository scope is never account authentication.
Cosmos supplies identity and the Forum server enforces permissions. Existing logging scope is
unchanged even where its alias handling is broader.

Co-installed providers share a local SQLite debounce under `E3_COLLECTIVE_HOOK_STATE_DIR`
(default: the current user's .cache/e3-collective). It contains a hash of agent family,
session/source/transcript metadata plus a timestamp, never transcript content. A changed transcript
or different source/session immediately permits fresh context. Identical loads are suppressed
for 30 seconds. This is best-effort deduplication, NOT exactly-once delivery: without a shared
native context-load ID, rapid identical reloads may be suppressed and slow duplicate providers
may both emit. Do not treat cue delivery as proof an agent read, voted or submitted.

The hook only explains the workflow. It does not contact Cosmos/Forum, claim the backend is
enabled, vote, submit, widen access, approve, archive, delete, or schedule anything. The cue tells
agents to discover the real guide/status, preserve receipts, assess relevance, and finish normally
when unavailable/disabled/unauthorized or there is no useful contribution. Submission is private;
E3 sharing is separate consent including files; public approval is a distinct librarian action.
Concerns are independent of approval; pending by itself is not a quality defect.

## Reproduce local verification

From the codex-plugins worktree, with the companion Sherlock worktree available:

```sh
SHERLOCK_FEEDBACK_TEST_ROOT=/absolute/path/to/sherlock-feedback-hooks \
python3 -m pytest -q tests/test_collective_hooks.py tests/test_collective_feedback_hooks.py
```

Tests create disposable profiles/cache/state and synthetic E3 repos. They run declared hook
commands against packaged copies, block outbound Python connections, disable upload/update/
presence side effects, verify both provider orders/concurrency and check original telemetry
stdin. They do not install to the active user's profile or write to live Forum.

The opt-in Sherlock Claude replay uses the existing POSIX launcher platform: a detached
fork inherits the complete payload in memory. It has no temporary-file dependency and no
parent pipe write that can block on a slow reader. Tests include a delayed reader and a
payload larger than pipe capacity, with the parent required to return within two seconds.
This preview is not a new Windows hook implementation.

## Release and rollback boundaries

After explicit approval, separately verify backend deployment/readiness, companion Cosmos signing,
librarian configuration, package versioning, distribution, hook trust and fresh client receipts.
A backend tool being listed is not sufficient: it can be feature-disabled or deny the caller.
Do not confuse publishing a package with activating it on subscribed clients.

Rollback sets `E3_COLLECTIVE_FEEDBACK_HOOK_ENABLED=0` explicitly. The global Collective opt-out
suppresses all guidance. Unsetting the feedback flag now enables the released default. Backend
rollback disables feedback writes while retaining schema and archive-aware reads. Shared debounce
state is disposable, not Forum knowledge.
