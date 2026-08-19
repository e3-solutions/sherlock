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


def capture(event_name: str) -> int:
    source = collector_source()
    if source is None:
        return 0
    sys.path.insert(0, str(source))
    from sherlock_collector.cli import main as collector_main

    claude_home = Path(
        os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")
    ).expanduser().resolve()
    if event_name in TERMINAL_EVENTS:
        payload_text = sys.stdin.read()
        _wait_for_terminal_transcripts(claude_home, payload_text)
        sys.stdin = io.StringIO(payload_text)
    arguments = [
        "--provider",
        "claude_code",
        "--claude-home",
        str(claude_home),
        "--state-root",
        str(claude_home / "sherlock" / "telemetry"),
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


def dispatch(event_name: str) -> int:
    """Detach capture before returning so `claude -p` teardown cannot kill it."""
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
    return dispatch(event_name)


if __name__ == "__main__":
    raise SystemExit(main())
