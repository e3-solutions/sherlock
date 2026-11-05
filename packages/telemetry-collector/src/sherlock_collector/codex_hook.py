"""Codex hook-only sessions: sessions Codex never writes a rollout for.

Codex side conversations are throwaway forks. Codex fires hooks for them with
``transcript_path: null``, and no rollout file or state-database row ever
exists, so the rollout scan cannot see them (COR-5208). For those sessions
only, the hook writes each ``SessionStart``, ``UserPromptSubmit`` and ``Stop``
payload as an immutable observation under ``codex-hook-events/`` and captures
it as ``codex``/``hook``. A session that names a transcript (even one not yet
on disk) or has a discovered rollout is never observed this way.

A fork's ``SessionStart`` leaves a marker in ``codex-hook-sessions/<id>.json``
with the parent it names, its working directory and git remote. Later events
are observed only when that marker exists and says ``fork``; other null-path
runs (``codex exec --ephemeral``, automation) leave no marker and are never
observed. Markers older than seven days are pruned. Fully captured
observations move to ``codex-hook-events/captured/``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping

from .claude_hook import _text
from .contract import ContractError, MAX_SOURCE_BYTES
from .discovery import DiscoveryResult
from .exclusions import (
    CODEX_HOOK_EVENTS as EVENTS_DIRECTORY,
    CODEX_HOOK_SESSIONS as SESSIONS_DIRECTORY,
    head_branch,
    origin_remote_url,
)
from .spool import _atomic_json


SCHEMA_VERSION = "sherlock.codex-hook.v1"
HOOK_ONLY_EVENTS = frozenset({"SessionStart", "UserPromptSubmit", "Stop"})
HOOK_ONLY_SESSION_SOURCES = frozenset({"fork"})
PARENT_KEYS = ("forked_from_id", "parent_thread_id")
MARKER_VERSION = 1
MARKER_RETENTION_SECONDS = 7 * 24 * 60 * 60
MAX_MARKER_BYTES = 64 * 1024
# Bound for the locally read git remote and branch; longer values are dropped.
MAX_GIT_TEXT_BYTES = 512


def _canonical_uuid(value: object) -> str | None:
    """The value itself when it is a lowercase canonical UUID, else None.

    Stricter than the Claude helper: the envelope's session id must equal the
    payload's byte for byte, so an uppercase spelling is not rewritten.
    """
    if not isinstance(value, str):
        return None
    try:
        canonical = str(uuid.UUID(value))
    except (ValueError, AttributeError):
        return None
    return value if value == canonical else None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _absolute(value: object) -> str | None:
    return value if isinstance(value, str) and os.path.isabs(value) else None


def _bounded(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    return value if len(value.encode("utf-8")) <= MAX_GIT_TEXT_BYTES else None


def parent_session_id(payload: Mapping[str, object]) -> str | None:
    """The parent a hook payload names itself (never inferred)."""
    for key in PARENT_KEYS:
        value = _text(payload.get(key))
        if value is not None:
            return value
    return None


def is_rolloutless(
    payload: Mapping[str, object],
    discovery: DiscoveryResult,
    *,
    fork_marked: bool = False,
) -> bool:
    """Whether this hook belongs to a Codex session that has no rollout.

    True only when ``transcript_path`` is null (or, for a fork-marked session,
    missing), ``session_id`` is a canonical UUID, and discovery found no
    rollout path or state-database row for that id. A transcript path string
    always means a normal session. It is not known whether Codex sends null or
    omits the key for forks, so a missing key counts only for forks.
    """
    if "transcript_path" in payload:
        if payload["transcript_path"] is not None:
            return False
    elif not fork_marked:
        return False
    session_id = _canonical_uuid(payload.get("session_id"))
    if session_id is None:
        return False
    if session_id in set(discovery.native_session_ids.values()):
        return False
    if any(session_id in path.name.lower() for path in discovery.paths):
        return False
    return not any(
        status.get("native_session_id") == session_id
        for status in discovery.source_statuses
    )


def _marker_path(state_root: Path, session_id: str) -> Path:
    return state_root / SESSIONS_DIRECTORY / f"{session_id}.json"


def remember_session(
    state_root: Path,
    payload: Mapping[str, object],
    *,
    now: float | None = None,
) -> Path | None:
    """Record a fork's SessionStart (source, parent, cwd, remote); prune old markers.

    Only fork sessions are recorded; other null-path runs leave no marker.
    """
    session_id = _canonical_uuid(payload.get("session_id"))
    if session_id is None or payload.get("source") not in HOOK_ONLY_SESSION_SOURCES:
        return None
    path = _marker_path(state_root, session_id)
    cwd = _absolute(payload.get("cwd"))
    _atomic_json(
        path,
        {
            "version": MARKER_VERSION,
            "native_session_id": session_id,
            "source": _text(payload.get("source")),
            "parent_native_session_id": parent_session_id(payload),
            "cwd": cwd,
            "repository_url": _bounded(origin_remote_url(cwd)),
            "recorded_at": _utc_now(),
        },
    )
    _prune_markers(state_root, time.time() if now is None else now, keep=path)
    return path


def _prune_markers(state_root: Path, now: float, *, keep: Path) -> None:
    cutoff = now - MARKER_RETENTION_SECONDS
    try:
        entries = list(os.scandir(state_root / SESSIONS_DIRECTORY))
    except OSError:
        return
    for entry in entries:
        if not entry.name.endswith(".json") or entry.path == str(keep):
            continue
        try:
            if entry.is_file(follow_symlinks=False) and entry.stat(
                follow_symlinks=False
            ).st_mtime < cutoff:
                os.unlink(entry.path)
        except OSError:
            continue


def session_marker(state_root: Path, session_id: object) -> dict | None:
    canonical = _canonical_uuid(session_id)
    if canonical is None:
        return None
    path = _marker_path(state_root, canonical)
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as handle:
            data = handle.read(MAX_MARKER_BYTES + 1)
        value = json.loads(data)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if (
        len(data) > MAX_MARKER_BYTES
        or not isinstance(value, dict)
        or value.get("version") != MARKER_VERSION
        or value.get("native_session_id") != canonical
    ):
        return None
    return value


def session_source(state_root: Path, session_id: object) -> str | None:
    """The source a hook-only session recorded at SessionStart, if any."""
    marker = session_marker(state_root, session_id)
    return _text(marker.get("source")) if marker else None


def fork_marked(
    state_root: Path,
    event_name: str,
    payload: Mapping[str, object],
) -> bool:
    """Whether the SessionStart (its payload, or the marker it left) says fork."""
    if event_name == "SessionStart":
        source = payload.get("source")
    else:
        source = session_source(state_root, payload.get("session_id"))
    return source in HOOK_ONLY_SESSION_SOURCES


def write_observation(
    state_root: Path,
    event_name: str,
    payload: Mapping[str, object],
    raw_payload: bytes,
    *,
    session_source: str | None,
) -> Path:
    """Write one immutable observation of a hook-only Codex event."""
    if event_name not in HOOK_ONLY_EVENTS:
        raise ValueError("unsupported Codex hook-only event")
    if not raw_payload:
        raise ValueError("Codex hook payload must not be empty")
    native_session_id = _canonical_uuid(payload.get("session_id"))
    if native_session_id is None:
        raise ValueError("Codex hook payload needs a canonical session_id")
    cwd = _absolute(payload.get("cwd"))
    observed_at = _utc_now()
    observation: dict[str, object] = {
        "type": "codex_hook",
        "schema_version": SCHEMA_VERSION,
        "collector_observed_at": observed_at,
        "timestamp": observed_at,
        "dispatch_event_name": event_name,
        "payload_sha256": hashlib.sha256(raw_payload).hexdigest(),
        "payload_base64": base64.b64encode(raw_payload).decode("ascii"),
        "native_session_id": native_session_id,
        "parent_native_session_id": parent_session_id(payload),
        "session_source": (
            session_source if session_source in HOOK_ONLY_SESSION_SOURCES else None
        ),
        "git": {
            "repository_url": _bounded(origin_remote_url(cwd)),
            "branch": _bounded(head_branch(cwd)),
        },
    }
    encoded = (
        json.dumps(observation, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    if len(encoded) > MAX_SOURCE_BYTES:
        raise ContractError("Codex hook observation exceeds source batch limits")
    path = state_root / EVENTS_DIRECTORY / f"{uuid.uuid4()}.jsonl"
    _atomic_json(path, observation)
    return path


def observation_identity(path: Path) -> tuple[str | None, str | None]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None, None
    if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION:
        return None, None
    return _text(value.get("native_session_id")), _text(
        value.get("parent_native_session_id")
    )
