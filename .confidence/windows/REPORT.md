# Confidence Report: Native Windows Sherlock support

Mode: critical

Task type: feature

## Outcome

Complete: native Windows installation and collection verified, with a reviewable PR and no merge. Implementation commit b91e22b3499137b61c70a02971880ba1215f97fb passed full CI run 34699863776; subsequent changes only clarify documentation and record this evidence.

## Goal

Install and run Sherlock natively on Windows with no WSL requirement while preserving Unix collection and telemetry durability.

## Changes

- Added native PowerShell entrypoints with a shared Python installer, atomic identity preflight, durable runtime/marketplace updates and verified provider registration.
- Added standard-library Windows locks, protected ACLs validated by binary SID/ACE structure, durable file replacement, held-handle containment and detached drains while preserving Unix behavior.
- Added real Windows provider CLI, PowerShell 5.1, process/durability and Unix matrix CI; documented supported installation and verification limits.

## Proof

| ID | Claim | Status | Evidence | Captured runs | Artifacts |
| --- | --- | --- | --- | --- | --- |
| P1 | Collector imports and CLI startup work on native Windows. | pass | Native Windows Python 3.11 collector startup and imports pass in the platform job. | support: final-ci-remote (exit 0) | .github/workflows/collector-platforms.yml, docs/windows.md, .confidence/windows/native-windows.md |
| P2 | Real process locks exclude competitors and recover after owner death. | pass | Real subprocess contention admits one drain owner; terminating the owner releases the lock and permits recovery on Windows and Unix. | support: final-ci-remote (exit 0), diagnostic: macos-final (exit 0) | .github/workflows/collector-platforms.yml, docs/windows.md, .confidence/windows/native-windows.md |
| P3 | Atomic state/spool writes and reinstall retain valid durable files with Windows open-handle semantics. | pass | Native Windows existing-destination writes and non-delete-sharing reader tests preserve valid old/new files; installer backup recovery and reinstall tests retain identity and queue bytes. | support: final-ci-remote (exit 0), diagnostic: windows-acl-failed (exit 1), diagnostic: macos-final (exit 0) | .github/workflows/collector-platforms.yml, docs/windows.md, .confidence/windows/native-windows.md |
| P4 | Append/replacement generation identity captures bytes without gaps. | pass | Append and same-size replacement tests preserve exact generation bytes, including unavailable inode fallback; native held-handle file identity is exercised on Windows. | support: final-ci-remote (exit 0), diagnostic: macos-final (exit 0) | .github/workflows/collector-platforms.yml, docs/windows.md, .confidence/windows/native-windows.md |
| P5 | Crash recovery preserves exact source bytes and durable queue. | pass | Killed-drain recovery and exact payload checks preserve queued bytes; installed provider smoke checks source bytes and modification time remain unchanged. | support: final-ci-remote (exit 0), diagnostic: macos-final (exit 0) | .github/workflows/collector-platforms.yml, docs/windows.md, .confidence/windows/native-windows.md |
| P6 | Detached drain survives the hook parent. | pass | Real hook parent exits before the detached drain uploads to a local HTTP server; subprocess proof runs on all three operating systems. | support: final-ci-remote (exit 0), diagnostic: macos-final (exit 0) | .github/workflows/collector-platforms.yml, docs/windows.md, .confidence/windows/native-windows.md |
| P7 | PowerShell 5.1 installs and reinstalls preserving identity and queues. | pass | Windows PowerShell 5.1 bootstrap and real provider install/reinstall run from a checkout with spaces and use provider homes with spaces. Invalid identity preflight writes no home/marketplace; runtime reinstall retains installation ID and queued bytes. | support: final-ci-remote (exit 0) | .github/workflows/collector-platforms.yml, docs/windows.md, .confidence/windows/native-windows.md |
| P8 | Exact installed native provider hook commands execute correctly. | pass | Real Codex 0.154.0 and Claude Code 2.1.269 register plugins on Windows, then exact installed native commands spool synthetic immutable UTF-8 source bytes. This is provider registration plus command execution, not an authenticated model turn. | support: final-ci-remote (exit 0) | .github/workflows/collector-platforms.yml, docs/windows.md, .confidence/windows/native-windows.md |
| P9 | Codex app-server pipe transport and trust verification work portably. | pass | Native pipe transport exercises buffered notifications, EOF and timeout handling; real Codex app-server trusts seven scoped hooks after selected-command validation. | support: final-ci-remote (exit 0), diagnostic: actual-codex-macos (exit 0) | .github/workflows/collector-platforms.yml, docs/windows.md, .confidence/windows/native-windows.md |
| P10 | Existing macOS/Linux collector and installer behavior remains intact. | pass | Full collector regressions run on macOS and Linux; full repository CI covers dashboard, Deno, database and oversized-provider integration. Independent review found no remaining code blocker. | support: final-ci-remote (exit 0), diagnostic: macos-final (exit 0) | .github/workflows/collector-platforms.yml, docs/windows.md, .confidence/windows/native-windows.md |

## Tests

Passed:

- final-ci-remote: immutable GitHub run head, completion, all three platform jobs, required Windows steps and full repository Test job checked explicitly. Captured outside the local Git workspace; it verifies remote commit b91e22b, independent of this evidence-only commit.
- Native Windows: 14 process/durability tests, 3 trust-transport tests and 8 installer tests; no skips in those suites.
- Real Windows Codex 0.154.0 and Claude Code 2.1.269 installed and reinstalled from a spaced checkout; exact installed commands captured immutable UTF-8 bytes.
- Final macOS matrix: 147 tests, five native-Windows skips; Linux matrix and full dashboard/Deno/database/end-to-end CI also passed.
- macos-final: local 146-test regression before the final native-EXE shim addition, five platform skips; actual-codex-macos: seven hooks trusted through the real CLI.

Failed:

- None

Not run:

- None

## Simplicity

Code gate: pass

Test gate: pass

Independent proof-design and adversarial-review roles approved the isolated OS boundary and focused behavior tests. No compatibility framework or third-party runtime dependency was added. Native process, byte, ACL and provider evidence checks external behavior; fixture shim tests complement real CLI execution.

## Review gate

Required: true
Reason: Critical feature changes concurrency, filesystem permissions/durability and provider trust across operating systems.

Roles:

- test_designer
- adversarial_reviewer

Findings and dispositions:

- Independent gpt-5.6-sol reviewer designed process/crash/provider boundary tests before implementation review.
- Review found backup-only runtime recovery gap; fixed before native verification.
- Review prompted held-handle reparse/directory attribute validation, removing the second path lookup.
- Final launcher review found no code blocker and required real Claude verification; the subsequent native Windows install/reinstall and exact hook-command test passed, satisfying that condition.

## Risks

- Authenticated interactive provider/model sessions, production ingestion/dashboard arrival and specific VPN behavior were not exercised; CI uses isolated homes and synthetic loopback data.
- Windows durability and ACL support is scoped to local NTFS storage; network shares and FAT/exFAT are outside the tested contract.
- Provider interface compatibility is proven for pinned Codex 0.154.0 and Claude Code 2.1.269, not every prior/future release.
- A non-delete-sharing Windows reader may cause safe replacement failure and require retry; no universal power-loss atomicity guarantee is claimed.
- Confidence helper doctor reported a bundled manifest version mismatch; evidence runner and report validator are independently checked for successful execution. Historical failed runs are diagnostic only.

## User decisions

- Prepare a reviewable PR without merging. No production deployment or authenticated user session was requested for this verification.

## Rollback

Disable the Sherlock plugin in the affected provider and install a prior compatible release if needed. Preserve collector.json and sherlock/telemetry to retain installation identity and pending uploads. No database migration or raw-data rewrite is required.
