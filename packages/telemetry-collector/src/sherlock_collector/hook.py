from __future__ import annotations

import fcntl
import json
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Sequence

from .claude_hook import (
    TERMINAL_EVENTS,
    observation_identity,
    referenced_transcript,
    write_observation,
)
from .config import default_claude_home, default_codex_home, default_state_root
from .discovery import (
    DEFAULT_LOOKBACK_SECONDS,
    discover_claude_transcripts,
    discover_rollouts,
)
from .rollout import (
    DEFAULT_MAX_FILES,
    DEFAULT_MAX_SYNC_BYTES,
    CaptureResult,
    RolloutCapturer,
    SourceSnapshot,
)
from .spool import DurableSpool, _atomic_json, secure_lock


CODEX_HOOK_EVENTS = {
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "PostCompact",
    "SubagentStart",
    "SubagentStop",
    "Stop",
}
CLAUDE_HOOK_EVENTS = {
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "SessionEnd",
}
HOOK_EVENTS = CODEX_HOOK_EVENTS | CLAUDE_HOOK_EVENTS
POST_TOOL_DEBOUNCE_SECONDS = 30
POST_TOOL_STATE_VERSION = 1
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
    deferred_files: int = 0
    deferred_bytes: int = 0
    locked: bool = False
    skipped: str | None = None


def _tool_name(payload: Mapping[str, object]) -> str:
    value = payload.get("tool_name")
    return value if isinstance(value, str) else ""


def is_coordination_tool(name: str) -> bool:
    normalized = name.strip().lower().replace("-", "_")
    return normalized.rsplit(".", 1)[-1] in COORDINATION_TOOLS


def _post_tool_capture_due(path: Path, now_ns: int) -> bool:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return True
    if not isinstance(value, dict):
        return True
    last_capture_ns = value.get("last_capture_ns")
    if (
        value.get("state_version") != POST_TOOL_STATE_VERSION
        or isinstance(last_capture_ns, bool)
        or not isinstance(last_capture_ns, int)
    ):
        return True
    elapsed_ns = now_ns - last_capture_ns
    return elapsed_ns < 0 or elapsed_ns >= POST_TOOL_DEBOUNCE_SECONDS * 1_000_000_000


def _spawn_drain(
    drain_command: Sequence[str],
    drain_environment: Mapping[str, str] | None,
) -> None:
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
    max_files: int | None = None,
    max_sync_bytes: int | None = None,
    priority_workload_class: str | None = None,
    backlog_workload_class: str | None = None,
    source_snapshots: Mapping[str, SourceSnapshot] | None = None,
) -> CaptureResult:
    """Durably capture local bytes, then detach a drain without awaiting network."""
    outcome: CaptureResult | None = None
    try:
        outcome = capturer.capture(
            rollout_paths,
            native_session_ids=native_session_ids,
            parent_native_session_ids=parent_native_session_ids,
            best_effort=best_effort,
            priority_count=priority_count,
            max_files=max_files if max_files is not None else DEFAULT_MAX_FILES,
            max_sync_bytes=(
                max_sync_bytes
                if max_sync_bytes is not None
                else DEFAULT_MAX_SYNC_BYTES
            ),
            priority_workload_class=priority_workload_class,
            backlog_workload_class=backlog_workload_class,
            source_snapshots=source_snapshots,
        )
    finally:
        # A concurrent capture winner already starts its own drain. Avoid a
        # process fan-out when tool-heavy sessions trigger overlapping hooks.
        queued_work = bool(capturer.spool.list_pending()) or any(
            capturer.spool.processing.glob("*.json")
        )
        if outcome is None or (
            not outcome.locked and (outcome.enqueued > 0 or queued_work)
        ):
            _spawn_drain(drain_command, drain_environment)
    return outcome


def _capture_hook(
    event_name: str,
    payload: Mapping[str, object],
    *,
    codex_home: Path | str | None = None,
    claude_home: Path | str | None = None,
    state_root: Path | str | None = None,
    provider: str = "codex",
    raw_payload: bytes | None = None,
    drain_command: Sequence[str],
    drain_environment: Mapping[str, str] | None = None,
) -> HookResult:
    if event_name not in HOOK_EVENTS:
        return HookResult(event_name, skipped="unsupported_hook")
    if provider not in {"codex", "claude_code"}:
        return HookResult(event_name, skipped="unsupported_provider")
    home = Path(
        (claude_home or default_claude_home())
        if provider == "claude_code"
        else (codex_home or default_codex_home())
    ).expanduser().resolve()
    root = Path(state_root or default_state_root(home)).expanduser().resolve()
    discovery = (
        discover_claude_transcripts(
            home,
            hook_payload=payload,
            lookback_seconds=(
                DEFAULT_LOOKBACK_SECONDS if event_name == "SessionStart" else None
            ),
        )
        if provider == "claude_code"
        else discover_rollouts(home, hook_payload=payload)
    )
    environment = os.environ.copy()
    if drain_environment:
        environment.update(drain_environment)
    hook_outcome = CaptureResult()
    hook_observation: Path | None = None
    hook_errors = 0
    if (
        provider == "claude_code"
        and event_name in TERMINAL_EVENTS
        and raw_payload
    ):
        try:
            hook_observation = write_observation(
                root,
                event_name,
                payload,
                raw_payload,
                transcript_path=referenced_transcript(home, event_name, payload),
            )
            observation_paths = [
                hook_observation,
                *(
                    path
                    for path in sorted(
                        (root / "claude-hook-events").glob("*.jsonl")
                    )
                    if path != hook_observation
                ),
            ]
            native_ids: dict[str, str] = {}
            parent_ids: dict[str, str] = {}
            for path in observation_paths:
                native_id, parent_id = observation_identity(path)
                if native_id is not None:
                    native_ids[str(path.resolve())] = native_id
                if parent_id is not None:
                    parent_ids[str(path.resolve())] = parent_id
            hook_outcome = RolloutCapturer(
                root,
                DurableSpool(root / "queue"),
                source_provider="claude_code",
                source_kind="hook",
                state_name="claude-hook",
                capture_unterminated_tail=False,
            ).capture(
                observation_paths,
                native_session_ids=native_ids,
                parent_native_session_ids=parent_ids,
                best_effort=True,
                priority_count=1,
            )
        except (OSError, ValueError):
            hook_errors += 1
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
            allowed_root=(
                home / "projects"
                if provider == "claude_code"
                and not (home / "projects").is_symlink()
                and (home / "projects").is_dir()
                else None
            ),
        ),
        discovery.paths,
        drain_command,
        native_session_ids=discovery.native_session_ids,
        parent_native_session_ids=discovery.parent_native_session_ids,
        source_snapshots=discovery.source_snapshots,
        drain_environment=environment,
        best_effort=True,
        priority_count=discovery.priority_count,
        backlog_workload_class=(
            "backfill"
            if provider == "claude_code" and event_name == "SessionStart"
            else None
        ),
    )
    if (
        outcome.locked
        and not hook_outcome.locked
        and hook_outcome.enqueued > 0
    ):
        _spawn_drain(drain_command, environment)
    return HookResult(
        event_name=event_name,
        discovered=len(discovery.paths) + (1 if hook_observation else 0),
        enqueued=outcome.enqueued + hook_outcome.enqueued,
        captured_bytes=outcome.captured_bytes + hook_outcome.captured_bytes,
        discovery_errors=len(discovery.errors),
        capture_errors=outcome.errors + hook_outcome.errors + hook_errors,
        deferred_files=outcome.deferred_files + hook_outcome.deferred_files,
        deferred_bytes=outcome.deferred_bytes + hook_outcome.deferred_bytes,
        locked=outcome.locked or hook_outcome.locked,
    )


def run_hook(
    event_name: str,
    payload: Mapping[str, object],
    *,
    codex_home: Path | str | None = None,
    claude_home: Path | str | None = None,
    state_root: Path | str | None = None,
    provider: str = "codex",
    raw_payload: bytes | None = None,
    drain_command: Sequence[str],
    drain_environment: Mapping[str, str] | None = None,
) -> HookResult:
    provider_events = (
        CLAUDE_HOOK_EVENTS if provider == "claude_code" else CODEX_HOOK_EVENTS
    )
    if provider not in {"codex", "claude_code"}:
        return HookResult(event_name, skipped="unsupported_provider")
    if event_name not in provider_events:
        return HookResult(event_name, skipped="unsupported_hook")
    home = Path(
        (claude_home or default_claude_home())
        if provider == "claude_code"
        else (codex_home or default_codex_home())
    ).expanduser().resolve()
    root = Path(state_root or default_state_root(home)).expanduser().resolve()

    arguments = {
        "codex_home": codex_home,
        "claude_home": claude_home,
        "state_root": root,
        "provider": provider,
        "raw_payload": raw_payload,
        "drain_command": drain_command,
        "drain_environment": drain_environment,
    }
    if event_name != "PostToolUse" or is_coordination_tool(_tool_name(payload)):
        return _capture_hook(event_name, payload, **arguments)

    state_stem = f"{provider}-post-tool-capture"
    state_path = root / f"{state_stem}.json"
    with secure_lock(root / f"{state_stem}.lock") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return HookResult(event_name, skipped="busy")
        now_ns = time.time_ns()
        if not _post_tool_capture_due(state_path, now_ns):
            return HookResult(event_name, skipped="debounced")
        result = _capture_hook(event_name, payload, **arguments)
        if not result.locked:
            _atomic_json(
                state_path,
                {
                    "state_version": POST_TOOL_STATE_VERSION,
                    "last_capture_ns": now_ns,
                },
            )
        return result
