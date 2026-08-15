from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .config import default_codex_home


DEFAULT_LOOKBACK_SECONDS = 24 * 60 * 60
DEFAULT_DATABASE_LIMIT = 8
DEFAULT_ROWS_PER_DATABASE = 128


@dataclass(frozen=True)
class DiscoveryResult:
    paths: tuple[Path, ...]
    native_session_ids: Mapping[str, str]
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


def _timestamp(columns: set[str]) -> str:
    if {"updated_at_ms", "updated_at"}.issubset(columns):
        return "coalesce(updated_at_ms, updated_at * 1000)"
    if "updated_at_ms" in columns:
        return "updated_at_ms"
    if "updated_at" in columns:
        return "updated_at * 1000"
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
        updated = _timestamp(columns)
        archived = "coalesce(archived, 0) = 0" if "archived" in columns else "1 = 1"
        thread_source = (
            "coalesce(thread_source, '') in ('', 'user', 'subagent')"
            if "thread_source" in columns
            else "1 = 1"
        )
        query = f"""
            select id, rollout_path, {updated} as updated_at_ms
              from threads
             where {updated} >= ? and {archived} and {thread_source}
             order by {updated} desc, id desc
             limit ?
        """
        return [
            dict(row)
            for row in connection.execute(query, (cutoff_ms, max(1, int(limit))))
        ]
    finally:
        connection.close()


def discover_rollouts(
    codex_home: Path | str | None = None,
    *,
    hook_payload: Mapping[str, object] | None = None,
    lookback_seconds: int = DEFAULT_LOOKBACK_SECONDS,
    rows_per_database: int = DEFAULT_ROWS_PER_DATABASE,
) -> DiscoveryResult:
    cutoff_ms = int(time.time() * 1000) - max(1, lookback_seconds) * 1000
    discovered: dict[Path, tuple[int, str | None]] = {}
    errors: list[str] = []
    payload = hook_payload or {}
    payload_session = payload.get("session_id")
    for key in ("rollout_path", "transcript_path"):
        raw_path = payload.get(key)
        if isinstance(raw_path, str) and raw_path:
            try:
                path = Path(raw_path).expanduser().resolve()
                if path.is_file():
                    discovered[path] = (
                        int(path.stat().st_mtime_ns // 1_000_000),
                        payload_session if isinstance(payload_session, str) else None,
                    )
            except OSError:
                continue
    for database in native_database_candidates(codex_home):
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
                path = Path(raw_path).expanduser().resolve()
                if not path.is_file():
                    continue
            except OSError:
                continue
            updated = int(row.get("updated_at_ms") or 0)
            session_id = row.get("id") if isinstance(row.get("id"), str) else None
            previous = discovered.get(path)
            if previous is None or updated > previous[0]:
                discovered[path] = (updated, session_id)
    ordered = sorted(
        discovered,
        key=lambda item: (discovered[item][0], str(item)),
        reverse=True,
    )
    native_ids = {
        str(path): session_id
        for path, (_, session_id) in discovered.items()
        if session_id is not None
    }
    return DiscoveryResult(tuple(ordered), native_ids, tuple(errors))
