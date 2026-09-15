"""Synchronization for tests that intentionally leave uploads queued."""

import json
import time
from pathlib import Path

from sherlock_collector.platform import nonblocking_lock


def wait_for_failed_drain(queue: Path) -> None:
    """Wait for the loopback upload failure and release of the drain's lock."""
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            pending = list((queue / "pending").glob("*.json"))
            finished = pending and all(
                json.loads(path.read_text(encoding="utf-8"))["metadata"].get(
                    "last_upload_failed_at"
                )
                for path in pending
            )
            if finished and not list((queue / "processing").glob("*.json")):
                with nonblocking_lock(queue / "drain.lock") as acquired:
                    if acquired:
                        return
        except (FileNotFoundError, PermissionError):
            pass
        time.sleep(0.02)
    raise AssertionError("Detached drain did not finish its loopback upload attempt")
