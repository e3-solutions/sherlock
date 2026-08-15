from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Iterable, Sequence

from .rollout import CaptureResult, RolloutCapturer


def capture_and_spawn_drain(
    capturer: RolloutCapturer,
    rollout_paths: Iterable[Path | str],
    drain_command: Sequence[str],
) -> CaptureResult:
    """Durably capture local bytes, then detach a drain without awaiting network."""
    try:
        return capturer.capture(rollout_paths)
    finally:
        try:
            subprocess.Popen(
                list(drain_command),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                close_fds=True,
            )
        except OSError:
            # Capture is already durable. A later hook is a recovery signal.
            pass
