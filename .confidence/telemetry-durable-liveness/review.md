# Independent integration review

Final verdict: **SHIP**.

The first review identified three blockers:

1. A broad recent-file fallback could let unrelated rollouts consume the capture budget.
2. A watchdog with only loop-start progress could restart a healthy worker during a slow blocking operation.
3. The collector fixture did not use the real object-shaped Codex subagent metadata or prove normalized worker topology.

The implementation was revised to select only the exact child, acknowledge successful blocking operations, poll database recovery waits in bounded ticks, and add realistic collector-to-normalizer regressions. A final review after narrowing the scan to active UTC session roots and making session metadata authoritative found no remaining blocker.

Residual risks are operational: a child file must exist when the one-shot hook scan runs, and an in-process timer cannot recover a completely blocked JavaScript event loop.
