#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path


TERMINAL_EVENTS = {"Stop", "SubagentStop", "SessionEnd"}
TERMINAL_GRACE_SECONDS = 0.5
TERMINAL_POLL_SECONDS = 0.1
TERMINAL_QUIET_POLLS = 3
TERMINAL_MAX_WAIT_SECONDS = 1.5


def collector_source() -> Path | None:
    candidates = []
    if os.environ.get("SHERLOCK_COLLECTOR_SOURCE"):
        candidates.append(Path(os.environ["SHERLOCK_COLLECTOR_SOURCE"]))
    claude_home = Path(
        os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")
    )
    candidates.append(claude_home / "sherlock" / "runtime")
    candidates.append(
        Path(__file__).resolve().parents[3]
        / "packages"
        / "telemetry-collector"
        / "src"
    )
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if (resolved / "sherlock_collector" / "cli.py").is_file():
            return resolved
    return None


def capture(event_name: str, *, state_root: Path | None = None) -> int:
    source = collector_source()
    if source is None:
        return 0
    sys.path.insert(0, str(source))
    from sherlock_collector.cli import main as collector_main

    claude_home = Path(
        os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")
    ).expanduser().resolve()
    if event_name in TERMINAL_EVENTS:
        source_input = getattr(sys.stdin, "buffer", sys.stdin)
        payload_bytes = source_input.read()
        if isinstance(payload_bytes, str):
            payload_bytes = payload_bytes.encode("utf-8")
        payload_text = payload_bytes.decode("utf-8", errors="replace")
        _wait_for_terminal_transcripts(claude_home, payload_text)
        sys.stdin = io.TextIOWrapper(io.BytesIO(payload_bytes), encoding="utf-8")
    arguments = [
        "--provider",
        "claude_code",
        "--claude-home",
        str(claude_home),
        "--state-root",
        str(state_root if state_root is not None else claude_home / "sherlock" / "telemetry"),
        "--config",
        os.environ.get(
            "SHERLOCK_CONFIG_PATH",
            str(claude_home / "sherlock" / "collector.json"),
        ),
        "hook",
        event_name,
    ]
    try:
        return collector_main(arguments)
    except Exception as error:
        print(
            f"Sherlock telemetry capture failed ({type(error).__name__}): {error}",
            file=sys.stderr,
        )
        return 0


def _wait_for_terminal_transcripts(claude_home: Path, payload_text: str) -> None:
    """Give Claude's asynchronous transcript writer a bounded quiet window."""
    try:
        payload = json.loads(payload_text)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return
    if not isinstance(payload, dict):
        return
    projects = (claude_home / "projects").resolve()
    paths = []
    for key in ("transcript_path", "agent_transcript_path"):
        value = payload.get(key)
        if not isinstance(value, str) or not value.strip():
            continue
        candidate = Path(value).expanduser().resolve()
        try:
            candidate.relative_to(projects)
        except ValueError:
            continue
        paths.append(candidate)
    if not paths:
        return

    started = time.monotonic()
    time.sleep(TERMINAL_GRACE_SECONDS)
    previous = _path_signatures(paths)
    stable_polls = 0
    while time.monotonic() - started < TERMINAL_MAX_WAIT_SECONDS:
        time.sleep(TERMINAL_POLL_SECONDS)
        current = _path_signatures(paths)
        if current == previous:
            stable_polls += 1
            if stable_polls >= TERMINAL_QUIET_POLLS:
                return
        else:
            stable_polls = 0
            previous = current


def _path_signatures(paths: list[Path]) -> tuple[tuple[str, int, int] | None, ...]:
    signatures = []
    for path in paths:
        try:
            stat = path.stat()
        except OSError:
            signatures.append(None)
        else:
            signatures.append((str(path), stat.st_size, stat.st_mtime_ns))
    return tuple(signatures)


def dispatch(event_name: str, payload_bytes: bytes | None = None) -> int:
    """Detach capture before returning so `claude -p` teardown cannot kill it."""
    if payload_bytes is not None:
        # These plugin launchers target POSIX (their manifest uses sh). Fork
        # transfers already-read input in memory, without temporary disk or a
        # blocking parent pipe write. A slow collector cannot truncate replay
        # when the hook parent exits or reaches the host's timeout.
        try:
            child_pid = os.fork()
        except (OSError, AttributeError):
            return 0  # Process exhaustion cannot interrupt the user's session.
        if child_pid:
            return 0
        try:
            os.setsid()
            null_fd = os.open(os.devnull, os.O_RDWR)
            for fd in (0, 1, 2):
                os.dup2(null_fd, fd)
            if null_fd > 2:
                os.close(null_fd)
            # Match Popen(close_fds=True): extra inherited copies of the host's
            # output pipes must not keep hook completion waiting on this child.
            import resource

            descriptor_limit = resource.getrlimit(resource.RLIMIT_NOFILE)[1]
            if descriptor_limit == resource.RLIM_INFINITY:
                descriptor_limit = max(65536, os.sysconf("SC_OPEN_MAX"))
            os.closerange(3, descriptor_limit)
            sys.stdin = io.TextIOWrapper(io.BytesIO(payload_bytes), encoding="utf-8")
            capture(event_name)
        finally:
            os._exit(0)
    try:
        subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--capture", event_name],
            stdin=sys.stdin,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
            env=os.environ.copy(),
        )
    except (OSError, ValueError):
        pass
    return 0


def main() -> int:
    if len(sys.argv) >= 3 and sys.argv[1] == "--capture":
        return capture(sys.argv[2])
    event_name = sys.argv[1] if len(sys.argv) > 1 else ""
    if event_name == "SessionStart" and os.environ.get("E3_COLLECTIVE_FEEDBACK_HOOK_ENABLED", "1") == "1":
        source_input = getattr(sys.stdin, "buffer", sys.stdin)
        raw = source_input.read()
        raw_bytes = raw.encode("utf-8") if isinstance(raw, str) else raw
        try:
            from collective_feedback import feedback_context

            context = feedback_context(json.loads(raw_bytes), event_name=event_name, agent="claude")
            if context:
                print(context, flush=True)
        except Exception:
            pass
        # Child stdout is discarded, so guidance is emitted above. Detached
        # capture inherits bytes in memory, not a parent-owned replay resource.
        return dispatch(event_name, payload_bytes=raw_bytes)
    return dispatch(event_name)


if __name__ == "__main__":
    raise SystemExit(main())
