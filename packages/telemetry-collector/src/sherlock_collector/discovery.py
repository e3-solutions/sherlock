from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping
from uuid import UUID

from .config import default_claude_home, default_codex_home


DEFAULT_LOOKBACK_SECONDS = 24 * 60 * 60
DEFAULT_DATABASE_LIMIT = 8
DEFAULT_ROWS_PER_DATABASE = 128


@dataclass(frozen=True)
class DiscoveryResult:
    paths: tuple[Path, ...]
    native_session_ids: Mapping[str, str]
    parent_native_session_ids: Mapping[str, str] = field(default_factory=dict)
    priority_count: int = 0
    errors: tuple[str, ...] = ()


def native_database_candidates(
    codex_home: Path | str | None = None,
    *,
    limit: int = DEFAULT_DATABASE_LIMIT,
) -> list[Path]:
    home = Path(codex_home or default_codex_home()).expanduser().resolve()
    candidates: dict[Path, int] = {}
    for root in (home, home / "sqlite"):
        for pattern in ("state_*.sqlite", "state.sqlite"):
            for item in root.glob(pattern):
                try:
                    path = item.resolve()
                    if not path.is_file():
                        continue
                    activity = path.stat().st_mtime_ns
                    wal = Path(f"{path}-wal")
                    if wal.is_file():
                        activity = max(activity, wal.stat().st_mtime_ns)
                    candidates[path] = activity
                except OSError:
                    continue
    ordered = sorted(
        candidates,
        key=lambda item: (candidates[item], str(item)),
        reverse=True,
    )
    return ordered[: max(1, limit)]


def _columns(connection: sqlite3.Connection) -> set[str]:
    return {str(row[1]) for row in connection.execute("pragma table_info(threads)")}


def _timestamps(columns: set[str]) -> tuple[tuple[str, str, int], ...]:
    if {"updated_at_ms", "updated_at"}.issubset(columns):
        return (
            ("updated_at * 1000", "updated_at", 1000),
            ("updated_at_ms", "updated_at_ms", 1),
        )
    if "updated_at_ms" in columns:
        return (("updated_at_ms", "updated_at_ms", 1),)
    if "updated_at" in columns:
        return (("updated_at * 1000", "updated_at", 1000),)
    raise ValueError("threads has no supported updated timestamp")


def _recent_rows(database: Path, cutoff_ms: int, limit: int) -> list[dict[str, object]]:
    connection = sqlite3.connect(
        f"{database.as_uri()}?mode=ro",
        uri=True,
        timeout=0.05,
    )
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("pragma query_only = on")
        connection.execute("pragma busy_timeout = 50")
        columns = _columns(connection)
        required = {"id", "rollout_path"}
        if not required.issubset(columns):
            raise ValueError("threads is missing id or rollout_path")
        archived = "coalesce(archived, 0) = 0" if "archived" in columns else "1 = 1"
        thread_source = (
            "coalesce(thread_source, '') in ('', 'user', 'subagent')"
            if "thread_source" in columns
            else "1 = 1"
        )
        rows: dict[str, dict[str, object]] = {}
        for selected_updated, indexed_updated, divisor in _timestamps(columns):
            query = f"""
                select id, rollout_path, {selected_updated} as updated_at_ms
                  from threads
                 where {indexed_updated} >= ? and {archived} and {thread_source}
                 order by {indexed_updated} desc, id desc
                 limit ?
            """
            for row in connection.execute(
                query,
                (cutoff_ms // divisor, max(1, int(limit))),
            ):
                value = dict(row)
                rows[str(value["id"])] = value
        return sorted(
            rows.values(),
            key=lambda row: (int(row.get("updated_at_ms") or 0), str(row["id"])),
            reverse=True,
        )[: max(1, int(limit))]
    finally:
        connection.close()


def discover_rollouts(
    codex_home: Path | str | None = None,
    *,
    hook_payload: Mapping[str, object] | None = None,
    lookback_seconds: int = DEFAULT_LOOKBACK_SECONDS,
    rows_per_database: int = DEFAULT_ROWS_PER_DATABASE,
) -> DiscoveryResult:
    home = Path(codex_home or default_codex_home()).expanduser().resolve()
    cutoff_ms = int(time.time() * 1000) - max(1, lookback_seconds) * 1000
    discovered: dict[Path, tuple[int, str | None]] = {}
    payload_paths: list[Path] = []
    errors: list[str] = []
    payload = hook_payload or {}
    payload_session = payload.get("session_id")
    for key in ("rollout_path", "transcript_path"):
        raw_path = payload.get(key)
        if isinstance(raw_path, str) and raw_path:
            try:
                path = _rollout_path(home, raw_path)
                if path is not None:
                    discovered[path] = (
                        int(path.stat().st_mtime_ns // 1_000_000),
                        _native_session_id(payload_session),
                    )
                    payload_paths.append(path)
            except OSError:
                continue
    for database in native_database_candidates(home):
        try:
            rows = _recent_rows(database, cutoff_ms, rows_per_database)
        except (OSError, sqlite3.Error, ValueError) as error:
            errors.append(f"{database.name}: {error}")
            continue
        for row in rows:
            raw_path = row.get("rollout_path")
            if not isinstance(raw_path, str) or not raw_path:
                continue
            try:
                path = _rollout_path(home, raw_path)
                if path is None:
                    continue
            except OSError:
                continue
            updated = int(row.get("updated_at_ms") or 0)
            session_id = _native_session_id(row.get("id"))
            previous = discovered.get(path)
            if previous is None or updated > previous[0]:
                discovered[path] = (updated, session_id)
    ordered = sorted(
        discovered,
        key=lambda item: (discovered[item][0], str(item)),
        reverse=True,
    )
    prioritized = list(dict.fromkeys(payload_paths))
    prioritized.extend(path for path in ordered if path not in payload_paths)
    native_ids = {
        str(path): session_id
        for path, (_, session_id) in discovered.items()
        if session_id is not None
    }
    return DiscoveryResult(
        paths=tuple(prioritized),
        native_session_ids=native_ids,
        priority_count=len(set(payload_paths)),
        errors=tuple(errors),
    )


def discover_claude_transcripts(
    claude_home: Path | str | None = None,
    *,
    hook_payload: Mapping[str, object] | None = None,
) -> DiscoveryResult:
    """Resolve only transcript paths explicitly supplied by Claude Code hooks."""
    home = Path(claude_home or default_claude_home()).expanduser().resolve()
    payload = hook_payload or {}
    session_id = _text_identity(payload.get("session_id"))
    agent_id = _text_identity(payload.get("agent_id"))
    paths: list[Path] = []
    native_ids: dict[str, str] = {}
    parent_ids: dict[str, str] = {}

    candidates = (
        (payload.get("transcript_path"), session_id, None),
        (payload.get("agent_transcript_path"), agent_id, session_id),
    )
    for raw_path, native_id, parent_id in candidates:
        if not isinstance(raw_path, str) or not raw_path:
            continue
        path = _claude_transcript_path(home, raw_path)
        if path is None or path in paths:
            continue
        paths.append(path)
        if native_id is not None:
            native_ids[str(path)] = native_id
        if parent_id is not None and parent_id != native_id:
            parent_ids[str(path)] = parent_id

    return DiscoveryResult(
        paths=tuple(paths),
        native_session_ids=native_ids,
        parent_native_session_ids=parent_ids,
        priority_count=len(paths),
    )


def _native_session_id(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return str(UUID(value))
    except ValueError:
        return None


def _text_identity(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return (
        normalized
        if normalized and len(normalized.encode("utf-8")) <= 512
        else None
    )


def _rollout_path(codex_home: Path, value: str) -> Path | None:
    try:
        path = Path(value).expanduser().resolve()
    except (OSError, RuntimeError):
        return None
    if not path.name.startswith("rollout-") or path.suffix != ".jsonl":
        return None
    for root in (codex_home / "sessions", codex_home / "archived_sessions"):
        try:
            path.relative_to(root)
        except ValueError:
            continue
        return path if path.is_file() else None
    return None


def _claude_transcript_path(claude_home: Path, value: str) -> Path | None:
    try:
        path = Path(value).expanduser().resolve()
        path.relative_to(claude_home / "projects")
    except (OSError, RuntimeError, ValueError):
        return None
    if path.suffix != ".jsonl" or not path.is_file():
        return None
    return path
