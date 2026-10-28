"""Durable reminders for hook-named sources a hook could not capture.

A hook names the transcript or rollout it fired for. Capture takes a
non-blocking lock, so when another capture holds it (parallel subagents, a
concurrent reconcile) the hook used to drop that source: nothing named it
again until a SessionStart lookback or the periodic reconciler, which could not
reach it either (COR-5023). The hook now leaves a marker; every later capture
(hook or reconcile) puts marked sources first and removes a marker once its
source is captured to the end, blocked by owner policy, or gone.

Markers hold the path and session ids only, never source bytes.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping

from .spool import _atomic_json, utc_now

MARKER_VERSION = 1
# The reconciler window is 31 days; a marker older than this cannot help.
MAX_MARKER_AGE_SECONDS = 31 * 24 * 60 * 60
# Bounds the priority work one capture takes from markers, well below the
# reconciler's file budget so markers can never starve its backlog.
MAX_MARKERS_PER_CAPTURE = 8
# A marker whose source was attempted this many times without finishing (for
# example a file that ends in a partial line forever) is dropped; the periodic
# reconciler still covers that file from its own backlog.
MAX_MARKER_ATTEMPTS = 12


@dataclass(frozen=True)
class PendingSource:
    marker: Path
    path: str
    native_session_id: str | None
    parent_native_session_id: str | None
    attempts: int = 0
    modified_ns: int = 0


def marker_directory(state_root: Path, state_name: str) -> Path:
    return Path(state_root) / f"{state_name}-pending"


def _marker_path(directory: Path, path: str) -> Path:
    return directory / f"{hashlib.sha256(path.encode()).hexdigest()}.json"


def remember(
    state_root: Path,
    state_name: str,
    paths: Iterable[str],
    native_session_ids: Mapping[str, str],
    parent_native_session_ids: Mapping[str, str],
) -> int:
    directory = marker_directory(state_root, state_name)
    written = 0
    for path in dict.fromkeys(str(value) for value in paths):
        value = {
            "marker_version": MARKER_VERSION,
            "path": path,
            "native_session_id": native_session_ids.get(path),
            "parent_native_session_id": parent_native_session_ids.get(path),
            "recorded_at": utc_now(),
        }
        try:
            _atomic_json(_marker_path(directory, path), value)
        except OSError:
            continue
        written += 1
    return written


def load(
    state_root: Path,
    state_name: str,
    *,
    allowed_root: Path | str | None,
    limit: int = MAX_MARKERS_PER_CAPTURE,
    now: float | None = None,
) -> list[PendingSource]:
    """Return the oldest usable markers; discard ones that can never be used."""
    directory = marker_directory(state_root, state_name)
    if not directory.is_dir() or allowed_root is None:
        return []
    prefix = str(allowed_root).rstrip(os.sep) + os.sep
    current = time.time() if now is None else now
    entries: list[tuple[int, PendingSource]] = []
    for marker in directory.glob("*.json"):
        try:
            modified_ns = marker.stat().st_mtime_ns
            value = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            _discard(marker)
            continue
        path = value.get("path") if isinstance(value, dict) else None
        attempts = value.get("attempts", 0) if isinstance(value, dict) else 0
        if (
            not isinstance(path, str)
            or not path.startswith(prefix)
            or value.get("marker_version") != MARKER_VERSION
            or not isinstance(attempts, int)
            or attempts >= MAX_MARKER_ATTEMPTS
            or current - modified_ns / 1e9 > MAX_MARKER_AGE_SECONDS
        ):
            _discard(marker)
            continue
        entries.append(
            (
                modified_ns,
                PendingSource(
                    marker=marker,
                    path=path,
                    native_session_id=_text(value.get("native_session_id")),
                    parent_native_session_id=_text(
                        value.get("parent_native_session_id")
                    ),
                    attempts=attempts,
                    modified_ns=modified_ns,
                ),
            )
        )
    entries.sort(key=lambda item: (item[0], item[1].path))
    return [entry for _, entry in entries[: max(0, limit)]]


def count(state_root: Path, state_name: str) -> int:
    directory = marker_directory(state_root, state_name)
    return len(list(directory.glob("*.json"))) if directory.is_dir() else 0


def settle(
    entries: Iterable[PendingSource],
    *,
    visited: set[str],
    completed: set[str],
    source_issues: Mapping[str, str],
    blocked_reasons: frozenset[str] | set[str],
) -> int:
    """Remove markers whose source needs no further capture; age the rest.

    A marker rewritten after it was loaded (a newer hook named the source
    again while this capture ran) is left for the next capture.
    """
    removed = 0
    for entry in entries:
        try:
            if entry.marker.stat().st_mtime_ns != entry.modified_ns:
                continue
        except FileNotFoundError:
            continue
        except OSError:
            continue
        issue = source_issues.get(entry.path)
        if (
            entry.path in completed
            or (issue is not None and issue in blocked_reasons)
            or not os.path.lexists(entry.path)
        ):
            _discard(entry.marker)
            removed += 1
        elif entry.path in visited:
            attempts = entry.attempts + 1
            if attempts >= MAX_MARKER_ATTEMPTS:
                _discard(entry.marker)
                removed += 1
                continue
            try:
                value = json.loads(entry.marker.read_text(encoding="utf-8"))
                value["attempts"] = attempts
                _atomic_json(entry.marker, value)
            except (OSError, ValueError, TypeError, AttributeError):
                _discard(entry.marker)
                removed += 1
    return removed


def _discard(marker: Path) -> None:
    try:
        marker.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None
