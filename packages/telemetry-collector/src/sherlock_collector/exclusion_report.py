"""Best-effort reporting of excluded session ids to Sherlock.

Local exclusions stop capture and upload, but sessions uploaded before they
were excluded already sit in Sherlock. Reporting their ids lets Sherlock hide
those copies (and their subagents and forks) everywhere. Only session ids are
sent, never project paths or any other part of the policy. Sherlock stores
reported ids additively, so an emptied or damaged local policy never un-hides
anything, and a failed report is simply retried on a later drain.

The last successfully reported ids are remembered next to the spool; a drain
posts again only when the current set contains an id not reported yet.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import re
from pathlib import Path
from typing import Callable, Iterable, Mapping

from .spool import _atomic_json, secure_lock, utc_now


STATE_NAME = "exclusions-report.json"
LOCK_NAME = "exclusions-report.lock"
STATE_VERSION = 1
MAX_IDS_PER_REQUEST = 5000
_CANONICAL_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

# Drain result statuses.
NONE = "none"  # nothing excluded, nothing to report
UNCHANGED = "unchanged"  # every current id was already reported
REPORTED = "reported"
SKIPPED = "skipped"  # unreadable policy, busy, blocked endpoint, or no support


class ExclusionReportError(RuntimeError):
    def __init__(self, message: str, *, error_code: str | None = None):
        super().__init__(message)
        self.error_code = error_code


def normalized_session_ids(values: Iterable[object]) -> list[str]:
    """Lowercase canonical UUIDs, deduplicated and sorted; anything else dropped."""
    ids: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        candidate = value.strip().lower()
        if _CANONICAL_UUID.match(candidate):
            ids.add(candidate)
    return sorted(ids)


def ids_sha256(ids: Iterable[str]) -> str:
    return hashlib.sha256("\n".join(sorted(ids)).encode()).hexdigest()


def _reported_ids(path: Path) -> frozenset[str]:
    try:
        raw = json.loads(path.read_bytes())
    except (OSError, ValueError):
        return frozenset()
    if not isinstance(raw, dict) or raw.get("version") != STATE_VERSION:
        return frozenset()
    ids = raw.get("ids")
    if not isinstance(ids, list):
        return frozenset()
    normalized = normalized_session_ids(ids)
    # A state whose ids do not match its own digest is ignored, so a damaged
    # file can only cause a repeat report, never a skipped one.
    if raw.get("sha256") != ids_sha256(normalized):
        return frozenset()
    return frozenset(normalized)


def report_exclusions(
    state_root: Path,
    session_ids: Iterable[object],
    send: Callable[[list[str]], Mapping[str, object]],
) -> str:
    """Report ids not reported before; return a drain status, never raise."""
    ids = normalized_session_ids(session_ids)
    if not ids:
        return NONE
    state_root = Path(state_root)
    state_path = state_root / STATE_NAME
    try:
        with secure_lock(state_root / LOCK_NAME) as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return SKIPPED
            reported = _reported_ids(state_path)
            if set(ids) <= reported:
                return UNCHANGED
            for start in range(0, len(ids), MAX_IDS_PER_REQUEST):
                chunk = ids[start : start + MAX_IDS_PER_REQUEST]
                response = send(chunk)
                if (
                    not isinstance(response, Mapping)
                    or not isinstance(response.get("accepted"), int)
                    or not isinstance(response.get("total"), int)
                    or isinstance(response.get("accepted"), bool)
                    or isinstance(response.get("total"), bool)
                ):
                    raise ExclusionReportError(
                        "exclusions response must carry integer accepted and total",
                        error_code="invalid_response",
                    )
            stored = sorted(reported | set(ids))
            _atomic_json(
                state_path,
                {
                    "version": STATE_VERSION,
                    "sha256": ids_sha256(stored),
                    "count": len(stored),
                    "ids": stored,
                    "reported_at": utc_now(),
                },
            )
            return REPORTED
    except Exception as error:  # best-effort: never break the drain
        code = getattr(error, "error_code", None)
        return f"failed:{code or type(error).__name__}"
