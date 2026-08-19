from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Sequence

from .config import default_claude_home, default_codex_home, default_state_root
from .discovery import discover_claude_transcripts, discover_rollouts
from .rollout import CaptureResult, RolloutCapturer
from .spool import DurableSpool


HOOK_EVENTS = {
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "SessionEnd",
}
COORDINATION_TOOLS = {
    "spawn_agent",
    "wait_agent",
    "followup_task",
    "send_message",
    "send_message_to_agent",
    "interrupt_agent",
    "list_agents",
    "wait",
}


@dataclass(frozen=True)
class HookResult:
    event_name: str
    discovered: int = 0
    enqueued: int = 0
    captured_bytes: int = 0
    discovery_errors: int = 0
    capture_errors: int = 0
    locked: bool = False
    skipped: str | None = None


def _tool_name(payload: Mapping[str, object]) -> str:
    value = payload.get("tool_name")
    return value if isinstance(value, str) else ""


def is_coordination_tool(name: str) -> bool:
    normalized = name.strip().lower().replace("-", "_")
    return normalized.rsplit(".", 1)[-1] in COORDINATION_TOOLS


def capture_and_spawn_drain(
    capturer: RolloutCapturer,
    rollout_paths: Iterable[Path | str],
    drain_command: Sequence[str],
    *,
    native_session_ids: Mapping[str, str] | None = None,
    parent_native_session_ids: Mapping[str, str] | None = None,
    drain_environment: Mapping[str, str] | None = None,
    best_effort: bool = False,
    priority_count: int = 0,
) -> CaptureResult:
    """Durably capture local bytes, then detach a drain without awaiting network."""
    try:
        return capturer.capture(
            rollout_paths,
            native_session_ids=native_session_ids,
            parent_native_session_ids=parent_native_session_ids,
            best_effort=best_effort,
            priority_count=priority_count,
        )
    finally:
        try:
            subprocess.Popen(
                list(drain_command),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                close_fds=True,
                env=(
                    dict(drain_environment)
                    if drain_environment is not None
                    else None
                ),
            )
        except OSError:
            # Capture is already durable. A later hook is a recovery signal.
            pass


def run_hook(
    event_name: str,
    payload: Mapping[str, object],
    *,
    codex_home: Path | str | None = None,
    claude_home: Path | str | None = None,
    state_root: Path | str | None = None,
    provider: str = "codex",
    drain_command: Sequence[str],
    drain_environment: Mapping[str, str] | None = None,
) -> HookResult:
    if event_name not in HOOK_EVENTS:
        return HookResult(event_name, skipped="unsupported_hook")
    if provider not in {"codex", "claude_code"}:
        return HookResult(event_name, skipped="unsupported_provider")
    if (
        provider == "codex"
        and event_name == "PostToolUse"
        and not is_coordination_tool(_tool_name(payload))
    ):
        return HookResult(event_name, skipped="ordinary_tool")
    home = Path(
        (claude_home or default_claude_home())
        if provider == "claude_code"
        else (codex_home or default_codex_home())
    ).expanduser().resolve()
    root = Path(state_root or default_state_root(home)).expanduser().resolve()
    discovery = (
        discover_claude_transcripts(home, hook_payload=payload)
        if provider == "claude_code"
        else discover_rollouts(home, hook_payload=payload)
    )
    environment = os.environ.copy()
    if drain_environment:
        environment.update(drain_environment)
    outcome = capture_and_spawn_drain(
        RolloutCapturer(
            root,
            DurableSpool(root / "queue"),
            source_provider=provider,
            source_kind="transcript" if provider == "claude_code" else "rollout",
            state_name=(
                "claude-transcript" if provider == "claude_code" else "rollout"
            ),
            capture_unterminated_tail=provider != "claude_code",
        ),
        discovery.paths,
        drain_command,
        native_session_ids=discovery.native_session_ids,
        parent_native_session_ids=discovery.parent_native_session_ids,
        drain_environment=environment,
        best_effort=True,
        priority_count=discovery.priority_count,
    )
    return HookResult(
        event_name=event_name,
        discovered=len(discovery.paths),
        enqueued=outcome.enqueued,
        captured_bytes=outcome.captured_bytes,
        discovery_errors=len(discovery.errors),
        capture_errors=outcome.errors,
        locked=outcome.locked,
    )
