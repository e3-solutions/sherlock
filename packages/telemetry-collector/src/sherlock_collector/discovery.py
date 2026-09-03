from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping
from uuid import UUID

from .config import default_claude_home, default_codex_home
from .rollout import SourceSnapshot, open_regular_under_root, source_prefix


DEFAULT_LOOKBACK_SECONDS = 24 * 60 * 60
CLAUDE_DEFAULT_LOOKBACK_SECONDS = 72 * 60 * 60
DEFAULT_DATABASE_LIMIT = 8
DEFAULT_ROWS_PER_DATABASE = 128
CLAUDE_IDENTITY_SCAN_BYTES = 256 * 1024
CLAUDE_IDENTITY_SCAN_RECORDS = 64
CODEX_IDENTITY_SCAN_BYTES = 256 * 1024
CODEX_IDENTITY_SCAN_RECORDS = 64
CODEX_BACKFILL_MAX_FILES = 4096
CODEX_BACKFILL_MAX_BYTES = 512 * 1024 * 1024
CLAUDE_BACKFILL_MAX_FILES = 4096
CLAUDE_BACKFILL_MAX_BYTES = 512 * 1024 * 1024


@dataclass(frozen=True)
class DiscoveryResult:
    paths: tuple[Path, ...]
    native_session_ids: Mapping[str, str]
    parent_native_session_ids: Mapping[str, str] = field(default_factory=dict)
    priority_count: int = 0
    errors: tuple[str, ...] = ()
    invalid_count: int = 0
    omitted_count: int = 0
    excluded_by_cutoff: int = 0
    selected_bytes: int = 0
    source_snapshots: Mapping[str, SourceSnapshot] = field(default_factory=dict)


@dataclass(frozen=True)
class _ClaudeCandidate:
    mtime_ns: int
    path: Path
    native_id: str
    parent_id: str | None
    snapshot: SourceSnapshot


@dataclass(frozen=True)
class _CodexCandidate:
    mtime_ns: int
    path: Path
    native_id: str | None
    parent_id: str | None
    is_subagent: bool
    snapshot: SourceSnapshot


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
    scan_recent_files: bool = False,
    recent_file_parent_native_session_id: object | None = None,
    recent_file_native_session_id: object | None = None,
    only_matching_recent_files: bool = False,
) -> DiscoveryResult:
    home = Path(codex_home or default_codex_home()).expanduser().resolve()
    cutoff_ms = int(time.time() * 1000) - max(1, lookback_seconds) * 1000
    discovered: dict[Path, tuple[int, str | None]] = {}
    payload_paths: list[Path] = []
    errors: list[str] = []
    payload = hook_payload or {}
    payload_session = payload.get("session_id")
    payload_agent = payload.get("agent_id")
    priority_parent = _native_session_id(recent_file_parent_native_session_id)
    priority_native = _native_session_id(recent_file_native_session_id)
    source_snapshots: dict[str, SourceSnapshot] = {}
    invalid_count = 0
    selected_bytes = 0
    for key, native_id in (
        ("rollout_path", payload_session),
        ("transcript_path", payload_session),
        ("agent_transcript_path", payload_agent),
    ):
        raw_path = payload.get(key)
        if isinstance(raw_path, str) and raw_path:
            try:
                path = _rollout_path(home, raw_path)
                if path is not None:
                    discovered[path] = (
                        int(path.stat().st_mtime_ns // 1_000_000),
                        _native_session_id(native_id),
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
    if scan_recent_files:
        cutoff_ns = cutoff_ms * 1_000_000
        try:
            candidates, invalid_count = _recent_codex_candidates(
                home,
                cutoff_ns,
                active_sessions_only=only_matching_recent_files,
            )
        except OSError as error:
            errors.append(f"sessions discovery: {error}")
            candidates = []
        for candidate in candidates:
            matches_priority = (
                candidate.native_id == priority_native
                if priority_native is not None
                else (
                    priority_parent is not None
                    and candidate.is_subagent
                    and candidate.parent_id == priority_parent
                )
            )
            if only_matching_recent_files and not matches_priority:
                continue
            previous = discovered.get(candidate.path)
            native_id = (
                previous[1]
                if previous is not None and previous[1] is not None
                else candidate.native_id
            )
            discovered[candidate.path] = (
                max(candidate.mtime_ns // 1_000_000, previous[0] if previous else 0),
                native_id,
            )
            source_snapshots[str(candidate.path)] = candidate.snapshot
            selected_bytes += candidate.snapshot.end_offset
            if matches_priority:
                payload_paths.append(candidate.path)
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
        invalid_count=invalid_count,
        selected_bytes=selected_bytes,
        source_snapshots=source_snapshots,
    )


def discover_claude_transcripts(
    claude_home: Path | str | None = None,
    *,
    hook_payload: Mapping[str, object] | None = None,
    lookback_seconds: int | None = None,
    replay_session_id: str | None = None,
    modified_after_ns: int | None = None,
    modified_before_ns: int | None = None,
) -> DiscoveryResult:
    """Resolve hook-supplied and, when requested, recently written transcripts."""
    selectors = sum(
        (
            lookback_seconds is not None,
            replay_session_id is not None,
            modified_after_ns is not None or modified_before_ns is not None,
        )
    )
    if selectors > 1:
        raise ValueError("Claude transcript selectors are mutually exclusive")
    if (modified_after_ns is None) != (modified_before_ns is None):
        raise ValueError("Claude transcript date ranges require both bounds")
    if (
        modified_after_ns is not None
        and modified_before_ns is not None
        and modified_after_ns >= modified_before_ns
    ):
        raise ValueError("Claude transcript date range must be increasing")
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

    priority_count = len(paths)
    errors: list[str] = []
    invalid_count = 0
    omitted_count = 0
    excluded_by_cutoff = 0
    selected_bytes = 0
    source_snapshots: dict[str, SourceSnapshot] = {}
    if selectors:
        cutoff_ns = (
            time.time_ns() - max(1, lookback_seconds) * 1_000_000_000
            if lookback_seconds is not None
            else modified_after_ns or 0
        )
        try:
            candidates, invalid_count, excluded_by_cutoff = _recent_claude_candidates(
                home,
                cutoff_ns,
            )
        except OSError as error:
            errors.append(f"projects discovery: {error}")
            candidates = []
        for candidate in candidates:
            if (
                modified_before_ns is not None
                and candidate.mtime_ns >= modified_before_ns
            ):
                continue
            if replay_session_id is not None:
                candidate_session_id = (
                    candidate.parent_id
                    if candidate.parent_id is not None
                    else candidate.native_id
                )
                if replay_session_id != candidate_session_id:
                    continue
            path = candidate.path
            source_snapshots[str(path)] = candidate.snapshot
            selected_bytes += candidate.snapshot.end_offset
            if path not in paths:
                paths.append(path)
            native_ids.setdefault(str(path), candidate.native_id)
            if (
                candidate.parent_id is not None
                and candidate.parent_id != candidate.native_id
            ):
                parent_ids.setdefault(str(path), candidate.parent_id)

    return DiscoveryResult(
        paths=tuple(paths),
        native_session_ids=native_ids,
        parent_native_session_ids=parent_ids,
        priority_count=priority_count,
        errors=tuple(errors),
        invalid_count=invalid_count,
        omitted_count=omitted_count,
        excluded_by_cutoff=excluded_by_cutoff,
        selected_bytes=selected_bytes,
        source_snapshots=source_snapshots,
    )


def _recent_codex_candidates(
    codex_home: Path,
    cutoff_ns: int,
    *,
    active_sessions_only: bool = False,
) -> tuple[list[_CodexCandidate], int]:
    candidates: list[_CodexCandidate] = []
    invalid_count = 0
    roots = (
        _active_codex_session_roots(codex_home, cutoff_ns)
        if active_sessions_only
        else (codex_home / "sessions", codex_home / "archived_sessions")
    )
    for root in roots:
        if not root.exists():
            continue
        if root.is_symlink() or not root.is_dir():
            invalid_count += 1
            continue
        pending = [root]
        while pending:
            directory = pending.pop()
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if entry.is_dir(follow_symlinks=False):
                            pending.append(Path(entry.path))
                            continue
                        if (
                            not entry.is_file(follow_symlinks=False)
                            or not entry.name.startswith("rollout-")
                            or not entry.name.endswith(".jsonl")
                        ):
                            continue
                        try:
                            path = Path(entry.path)
                            with open_regular_under_root(root, path) as handle:
                                details = os.fstat(handle.fileno())
                                if details.st_mtime_ns < cutoff_ns:
                                    continue
                                prefix_length, prefix_sha256 = source_prefix(
                                    handle,
                                    details.st_size,
                                )
                                identity = _codex_rollout_identity(handle)
                        except (OSError, ValueError):
                            invalid_count += 1
                            continue
                        filename_id = _native_session_id(path.stem[-36:])
                        # The session metadata is authoritative. Some Codex rollout
                        # filenames contain more than one UUID, so the final UUID is
                        # not always the session ID.
                        native_id = identity[0] if identity else filename_id
                        candidates.append(
                            _CodexCandidate(
                                mtime_ns=details.st_mtime_ns,
                                path=path,
                                native_id=native_id,
                                parent_id=identity[1] if identity else None,
                                is_subagent=identity[2] if identity else False,
                                snapshot=SourceSnapshot(
                                    device=details.st_dev,
                                    inode=details.st_ino,
                                    end_offset=details.st_size,
                                    prefix_length=prefix_length,
                                    prefix_sha256=prefix_sha256,
                                ),
                            )
                        )
            except OSError:
                invalid_count += 1
    candidates.sort(key=lambda item: (-item.mtime_ns, str(item.path)))
    return candidates, invalid_count


def _active_codex_session_roots(
    codex_home: Path,
    cutoff_ns: int,
) -> tuple[Path, ...]:
    dates = {
        time.strftime("%Y/%m/%d", time.gmtime(timestamp))
        for timestamp in (cutoff_ns / 1_000_000_000, time.time())
    }
    return tuple(codex_home / "sessions" / value for value in sorted(dates))


def _codex_rollout_identity(handle) -> tuple[str | None, str | None, bool] | None:
    handle.seek(0)
    remaining = CODEX_IDENTITY_SCAN_BYTES
    for _ in range(CODEX_IDENTITY_SCAN_RECORDS):
        if remaining <= 0:
            break
        line = handle.readline(remaining + 1)
        if not line or len(line) > remaining:
            break
        remaining -= len(line)
        try:
            value = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not isinstance(value, dict) or value.get("type") != "session_meta":
            continue
        payload = value.get("payload")
        if not isinstance(payload, dict):
            return None
        native_id = _native_session_id(payload.get("id"))
        declared_id = _native_session_id(payload.get("session_id"))
        parent_id = _native_session_id(payload.get("parent_thread_id"))
        if parent_id is None and declared_id != native_id:
            parent_id = declared_id
        source = payload.get("source")
        is_subagent = isinstance(source, dict) and isinstance(
            source.get("subagent"), dict
        )
        return native_id, parent_id, is_subagent
    return None


def _recent_claude_candidates(
    claude_home: Path,
    cutoff_ns: int,
) -> tuple[list[_ClaudeCandidate], int, int]:
    projects = claude_home / "projects"
    if projects.is_symlink() or not projects.is_dir():
        return [], 0, 0
    candidates: list[_ClaudeCandidate] = []
    invalid_count = 0
    excluded_by_cutoff = 0
    with os.scandir(projects) as project_entries:
        for project_entry in project_entries:
            if not project_entry.is_dir(follow_symlinks=False):
                continue
            project = Path(project_entry.path)
            try:
                (
                    project_candidates,
                    project_invalid,
                    project_excluded,
                ) = _scan_claude_project(
                    projects,
                    project,
                    cutoff_ns,
                )
            except OSError:
                invalid_count += 1
                continue
            candidates.extend(project_candidates)
            invalid_count += project_invalid
            excluded_by_cutoff += project_excluded
    candidates.sort(key=lambda item: (-item.mtime_ns, str(item.path)))
    return candidates, invalid_count, excluded_by_cutoff


def _scan_claude_project(
    allowed_root: Path,
    project: Path,
    cutoff_ns: int,
) -> tuple[list[_ClaudeCandidate], int, int]:
    candidates: list[_ClaudeCandidate] = []
    invalid_count = 0
    excluded_by_cutoff = 0
    with os.scandir(project) as entries:
        for entry in entries:
            if entry.name.endswith(".jsonl"):
                shape = _direct_claude_identity(entry.name)
                if shape is None:
                    continue
                if not entry.is_file(follow_symlinks=False):
                    invalid_count += 1
                    continue
                invalid, excluded = _append_recent_claude_candidate(
                    candidates,
                    allowed_root,
                    entry,
                    cutoff_ns,
                    shape,
                )
                invalid_count += invalid
                excluded_by_cutoff += excluded
                continue
            parent_id = _native_session_id(entry.name)
            if parent_id is None or not entry.is_dir(follow_symlinks=False):
                continue
            subagents = Path(entry.path) / "subagents"
            try:
                if subagents.is_symlink() or not subagents.is_dir():
                    continue
                with os.scandir(subagents) as agent_entries:
                    for agent_entry in agent_entries:
                        if not agent_entry.is_file(follow_symlinks=False):
                            continue
                        agent_id = _agent_filename_identity(agent_entry.name)
                        if agent_id is None:
                            continue
                        invalid, excluded = _append_recent_claude_candidate(
                            candidates,
                            allowed_root,
                            agent_entry,
                            cutoff_ns,
                            (agent_id, parent_id),
                        )
                        invalid_count += invalid
                        excluded_by_cutoff += excluded
            except OSError:
                invalid_count += 1
    return candidates, invalid_count, excluded_by_cutoff


def _direct_claude_identity(name: str) -> tuple[str, str | None] | None:
    if name.startswith("agent-"):
        agent_id = _agent_filename_identity(name)
        return (agent_id, None) if agent_id is not None else None
    native_id = _native_session_id(Path(name).stem)
    return (native_id, None) if native_id is not None else None


def _agent_filename_identity(name: str) -> str | None:
    if not name.startswith("agent-") or not name.endswith(".jsonl"):
        return None
    return _text_identity(name[len("agent-") : -len(".jsonl")])


def _append_recent_claude_candidate(
    candidates: list[_ClaudeCandidate],
    allowed_root: Path,
    entry: os.DirEntry[str],
    cutoff_ns: int,
    expected_identity: tuple[str, str | None],
) -> tuple[int, int]:
    try:
        path = Path(entry.path)
        with open_regular_under_root(allowed_root, path) as handle:
            details = os.fstat(handle.fileno())
            if details.st_mtime_ns < cutoff_ns:
                return 0, 1
            identity = _claude_transcript_identity(
                handle,
                path.name,
                expected_identity,
            )
            snapshot_details = os.fstat(handle.fileno())
            prefix_length, prefix_sha256 = source_prefix(
                handle,
                snapshot_details.st_size,
            )
    except (OSError, ValueError):
        return 1, 0
    if identity is None:
        return 1, 0
    candidates.append(
        _ClaudeCandidate(
            mtime_ns=snapshot_details.st_mtime_ns,
            path=path,
            native_id=identity[0],
            parent_id=identity[1],
            snapshot=SourceSnapshot(
                device=snapshot_details.st_dev,
                inode=snapshot_details.st_ino,
                end_offset=snapshot_details.st_size,
                prefix_length=prefix_length,
                prefix_sha256=prefix_sha256,
            ),
        )
    )
    return 0, 0


def _claude_transcript_identity(
    handle,
    filename: str,
    expected_identity: tuple[str, str | None],
) -> tuple[str, str | None] | None:
    """Validate a bounded prefix against provider-native path identity."""
    expected_native_id, expected_parent_id = expected_identity
    declared_session_id: str | None = None
    declared_agent_id: str | None = None
    handle.seek(0)
    remaining = CLAUDE_IDENTITY_SCAN_BYTES
    for _ in range(CLAUDE_IDENTITY_SCAN_RECORDS):
        if remaining <= 0:
            break
        line = handle.readline(remaining + 1)
        if not line or len(line) > remaining:
            break
        remaining -= len(line)
        try:
            value = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not isinstance(value, dict):
            continue
        session_id = _text_identity(value.get("sessionId", value.get("session_id")))
        agent_id = _text_identity(value.get("agentId", value.get("agent_id")))
        if session_id is not None:
            if declared_session_id is not None and declared_session_id != session_id:
                return None
            declared_session_id = session_id
        if agent_id is not None:
            if declared_agent_id is not None and declared_agent_id != agent_id:
                return None
            declared_agent_id = agent_id

    if expected_parent_id is not None:
        if declared_agent_id not in (None, expected_native_id):
            return None
        if declared_session_id not in (None, expected_parent_id):
            return None
        return expected_native_id, expected_parent_id
    if filename.startswith("agent-"):
        if declared_agent_id != expected_native_id or declared_session_id is None:
            return None
        return expected_native_id, declared_session_id
    if declared_agent_id is not None or declared_session_id not in (
        None,
        expected_native_id,
    ):
        return None
    return expected_native_id, None


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
    return normalized if normalized and len(normalized.encode("utf-8")) <= 512 else None


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
