from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import time
import uuid
import zipfile
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import Future
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Sequence, cast

from .contract import (
    MAX_RECORDS,
    MAX_SOURCE_BYTES,
    SHA256_RE,
    BatchManifest,
    ContractError,
    build_rollout_batch,
    validate_committed_receipt,
    validate_stored_payload,
)
from .drain import TransientUploadError, UploadTransport
from .rollout import (
    DEFAULT_CHUNK_BYTES,
    DEFAULT_MAX_OBJECT_BYTES,
    RolloutCapturer,
    StreamState,
    _generation_key,
    _prefix,
    _stream_key,
)
from .spool import SpoolItem, utc_now


ARCHIVE_VERSION = "sherlock.codex-backfill.v1"
UPLOAD_STATE_VERSION = "sherlock.backfill-upload-state.v1"
ARCHIVE_MANIFEST_PATH = "manifest.json"
MAX_ARCHIVE_MANIFEST_BYTES = 32 * 1024 * 1024
MAX_BATCH_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_UPLOAD_WORKERS = 16
# Preserve cross-session request packing while letting short groups finish,
# report progress, and checkpoint promptly under high worker counts.
UPLOAD_SESSION_GROUP_SIZE = 8
DEFAULT_EXPORT_WORKERS = min(8, max(1, os.cpu_count() or 1))
SESSION_ID_RE = re.compile(
    r"(?:^|[-_])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
    r"[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$",
    re.IGNORECASE,
)


class BackfillError(ValueError):
    """A local archive is incomplete, unsafe, or violates its contract."""


class _OversizedNativeRecord(BackfillError):
    pass


@dataclass(frozen=True)
class RolloutFile:
    scope: str
    relative_path: str
    path: Path


@dataclass(frozen=True)
class NativeRecordFragmentPlan:
    start_offset: int
    end_offset: int
    sha256: str
    fragment_count: int


@dataclass(frozen=True)
class ExportResult:
    archive: str
    sessions: int
    batches: int
    source_bytes: int
    stored_bytes: int


@dataclass(frozen=True)
class UploadResult:
    archive: str
    sessions: int
    batches_uploaded: int
    batches_skipped: int
    source_bytes_uploaded: int
    state_path: str | None


def discover_all_rollouts(codex_home: Path | str) -> tuple[RolloutFile, ...]:
    """Return every regular rollout below Codex's active and archive roots."""
    home = Path(codex_home).expanduser().resolve()
    found: list[RolloutFile] = []

    def walk_error(error: OSError) -> None:
        raise BackfillError(f"cannot scan Codex history: {error}")

    for scope in ("sessions", "archived_sessions"):
        root = home / scope
        if not root.is_dir():
            continue
        for directory, directories, filenames in os.walk(
            root, followlinks=False, onerror=walk_error
        ):
            symlinked_directories = [
                item for item in directories if (Path(directory) / item).is_symlink()
            ]
            if symlinked_directories:
                raise BackfillError(
                    "refusing to silently skip symlinked session directory: "
                    f"{Path(directory) / sorted(symlinked_directories)[0]}"
                )
            directories[:] = sorted(directories)
            for filename in sorted(filenames):
                if not filename.startswith("rollout-") or not filename.endswith(
                    ".jsonl"
                ):
                    continue
                path = Path(directory) / filename
                try:
                    if path.is_symlink():
                        raise BackfillError(
                            f"refusing to silently skip symlinked rollout: {path}"
                        )
                    if not path.is_file():
                        raise BackfillError(f"rollout is not a regular file: {path}")
                    relative = path.relative_to(root).as_posix()
                except BackfillError:
                    raise
                except OSError as error:
                    raise BackfillError(
                        f"cannot inspect rollout {path}: {error}"
                    ) from error
                except ValueError as error:
                    raise BackfillError(
                        f"rollout escaped its source root: {path}"
                    ) from error
                found.append(RolloutFile(scope, relative, path.resolve()))
    return tuple(sorted(found, key=lambda item: (item.scope, item.relative_path)))


def _native_session_id(path: Path) -> str | None:
    match = SESSION_ID_RE.search(path.name)
    if not match:
        return None
    try:
        return str(uuid.UUID(match.group(1)))
    except ValueError:
        return None


def _load_stream_states(state_root: Path) -> Mapping[str, StreamState]:
    state_path = state_root / "rollout-state.json"
    backup_path = state_root / "rollout-state.previous.json"
    for path in (state_path, backup_path):
        if not path.is_file():
            continue
        try:
            states, _ = RolloutCapturer._read_state(path)
            return states
        except (
            OSError,
            UnicodeDecodeError,
            json.JSONDecodeError,
            TypeError,
            ValueError,
        ):
            continue
    return {}


def _index_stream_states(
    states: Mapping[str, StreamState],
) -> Mapping[tuple[int, int], tuple[tuple[str, StreamState], ...]]:
    indexed: dict[tuple[int, int], list[tuple[str, StreamState]]] = {}
    for stream_key, state in states.items():
        indexed.setdefault((state.device, state.inode), []).append((stream_key, state))
    return {
        identity: tuple(sorted(items, key=lambda item: (-item[1].offset, item[0])))
        for identity, items in indexed.items()
    }


def _read_chunk(
    handle,
    start: int,
    stable_end: int,
    *,
    chunk_bytes: int,
    max_object_bytes: int,
) -> bytes:
    handle.seek(start)
    remaining = stable_end - start
    candidate = handle.read(min(chunk_bytes, remaining))
    if len(candidate) == remaining or candidate.endswith(b"\n"):
        return _limit_records(candidate)
    newline = candidate.rfind(b"\n")
    if newline >= 0:
        return _limit_records(candidate[: newline + 1])
    overflow_limit = min(max_object_bytes, remaining)
    overflow = handle.read(overflow_limit - len(candidate))
    complete = candidate + overflow
    newline = complete.find(b"\n", len(candidate))
    if newline < 0 and remaining > overflow_limit:
        raise _OversizedNativeRecord(
            f"native rollout record exceeds {max_object_bytes} bytes"
        )
    return _limit_records(complete if newline < 0 else complete[: newline + 1])


def _native_record_fragment_plan(
    handle,
    start: int,
    stable_end: int,
    *,
    fragment_bytes: int,
) -> NativeRecordFragmentPlan:
    handle.seek(start)
    digest = hashlib.sha256()
    end = start
    while end < stable_end:
        chunk = handle.read(min(1024 * 1024, stable_end - end))
        if not chunk:
            break
        newline = chunk.find(b"\n")
        selected = chunk if newline < 0 else chunk[: newline + 1]
        digest.update(selected)
        end += len(selected)
        if newline >= 0:
            break
    length = end - start
    if length <= fragment_bytes:
        raise BackfillError("could not locate oversized native rollout record")
    return NativeRecordFragmentPlan(
        start_offset=start,
        end_offset=end,
        sha256=digest.hexdigest(),
        fragment_count=(length + fragment_bytes - 1) // fragment_bytes,
    )


def _limit_records(source: bytes) -> bytes:
    search_from = 0
    for _ in range(MAX_RECORDS):
        newline = source.find(b"\n", search_from)
        if newline < 0:
            return source
        search_from = newline + 1
    return source[:search_from] if search_from < len(source) else source


def _zip_info(name: str, *, compressed: bool) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED if compressed else zipfile.ZIP_STORED
    info.external_attr = 0o100600 << 16
    return info


def _write_json(archive: zipfile.ZipFile, path: str, value: object) -> None:
    encoded = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    archive.writestr(_zip_info(path, compressed=True), encoded)


def _batch_paths(spool_key: str) -> tuple[str, str]:
    prefix = f"batches/{spool_key[:2]}/{spool_key}"
    return f"{prefix}.manifest.json", f"{prefix}.jsonl.gz"


def _session_identity(
    path: Path,
    handle,
    details: os.stat_result,
    states: Mapping[str, StreamState],
    states_by_file: Mapping[tuple[int, int], tuple[tuple[str, StreamState], ...]],
) -> tuple[str, int, str]:
    current_stream_key = _stream_key(path)
    direct_state = states.get(current_stream_key)
    candidates = sorted(
        states_by_file.get((details.st_dev, details.st_ino), ()),
        key=lambda item: (item[0] != current_stream_key, -item[1].offset, item[0]),
    )
    for stream_key, state in candidates:
        if (
            state.device != details.st_dev
            or state.inode != details.st_ino
            or details.st_size < state.offset
        ):
            continue
        prefix_length, prefix_sha256 = _prefix(
            handle, min(state.prefix_length, details.st_size)
        )
        if (
            state.prefix_length == prefix_length
            and state.prefix_sha256 == prefix_sha256
        ):
            return stream_key, state.generation_seq, state.generation_key
    prefix_length, prefix_sha256 = _prefix(handle, details.st_size)
    generation_seq = 0 if direct_state is None else direct_state.generation_seq + 1
    return (
        current_stream_key,
        generation_seq,
        _generation_key(
            path,
            details.st_dev,
            details.st_ino,
            prefix_sha256,
            generation_seq,
        ),
    )


def export_archive(
    codex_home: Path | str,
    output: Path | str,
    *,
    state_root: Path | str | None = None,
    force: bool = False,
    chunk_bytes: int = DEFAULT_CHUNK_BYTES,
    max_object_bytes: int = DEFAULT_MAX_OBJECT_BYTES,
    workers: int = DEFAULT_EXPORT_WORKERS,
    collector_version: str = "0.1.0",
    progress: Callable[[int, int, str], None] | None = None,
) -> ExportResult:
    if not 0 < chunk_bytes <= max_object_bytes <= MAX_SOURCE_BYTES:
        raise BackfillError("invalid backfill chunk limits")
    if workers < 1 or workers > 32:
        raise BackfillError("workers must be between 1 and 32")
    home = Path(codex_home).expanduser().resolve()
    destination = Path(output).expanduser().resolve()
    if destination.exists() and not force:
        raise BackfillError(f"archive already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    rollouts = discover_all_rollouts(home)
    states = _load_stream_states(
        Path(state_root).expanduser().resolve()
        if state_root
        else home / "sherlock" / "telemetry"
    )
    states_by_file = _index_stream_states(states)
    temporary_handle = tempfile.NamedTemporaryFile(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
        delete=False,
    )
    temporary = Path(temporary_handle.name)
    temporary_handle.close()
    os.chmod(temporary, 0o600)
    sessions: list[dict[str, object]] = []
    written_batches: dict[str, BatchManifest] = {}
    total_source = total_stored = total_batches = 0
    try:
        with (
            ThreadPoolExecutor(
                max_workers=workers,
                thread_name_prefix="sherlock-backfill-compress",
            ) as compression_executor,
            zipfile.ZipFile(
                temporary,
                "w",
                allowZip64=True,
                compresslevel=6,
                strict_timestamps=True,
            ) as archive,
        ):
            for position, rollout in enumerate(rollouts, start=1):
                session = _export_rollout(
                    archive,
                    rollout,
                    states,
                    states_by_file,
                    written_batches,
                    compression_executor,
                    max_in_flight=workers,
                    chunk_bytes=chunk_bytes,
                    max_object_bytes=max_object_bytes,
                    collector_version=collector_version,
                )
                sessions.append(session)
                total_source += cast(int, session["source_byte_count"])
                total_stored += cast(int, session["stored_byte_count"])
                total_batches += cast(int, session["batch_count"])
                if progress:
                    progress(position, len(rollouts), rollout.relative_path)
            manifest = {
                "archive_version": ARCHIVE_VERSION,
                "created_at": utc_now(),
                "provider": "codex",
                "source_roots": ["sessions", "archived_sessions"],
                "session_count": len(sessions),
                "batch_count": total_batches,
                "source_byte_count": total_source,
                "stored_byte_count": total_stored,
                "sessions": sessions,
            }
            _write_json(archive, ARCHIVE_MANIFEST_PATH, manifest)
        if destination.exists() and not force:
            raise BackfillError(f"archive already exists: {destination}")
        os.replace(temporary, destination)
        os.chmod(destination, 0o600)
    finally:
        temporary.unlink(missing_ok=True)
    return ExportResult(
        str(destination), len(sessions), total_batches, total_source, total_stored
    )


def _export_rollout(
    archive: zipfile.ZipFile,
    rollout: RolloutFile,
    states: Mapping[str, StreamState],
    states_by_file: Mapping[tuple[int, int], tuple[tuple[str, StreamState], ...]],
    written_batches: dict[str, BatchManifest],
    compression_executor: ThreadPoolExecutor,
    *,
    max_in_flight: int,
    chunk_bytes: int,
    max_object_bytes: int,
    collector_version: str,
) -> dict[str, object]:
    session_key = hashlib.sha256(
        f"{rollout.scope}/{rollout.relative_path}".encode()
    ).hexdigest()
    with rollout.path.open("rb") as handle:
        before = os.fstat(handle.fileno())
        stream_key, generation_seq, generation_key = _session_identity(
            rollout.path, handle, before, states, states_by_file
        )
        source_hash = hashlib.sha256()
        batch_keys: list[str] = []
        stored_bytes = 0
        read_offset = 0
        fragment_plan: NativeRecordFragmentPlan | None = None
        pending: deque[Future[tuple[BatchManifest, bytes]]] = deque()

        def write_next_batch() -> None:
            nonlocal stored_bytes
            manifest, stored = pending.popleft().result()
            existing = written_batches.get(manifest.spool_key)
            if existing is not None:
                reason = (
                    "deterministic batch key collision"
                    if existing != manifest
                    else "multiple rollout paths resolve to the same source batch"
                )
                raise BackfillError(reason)
            manifest_path, payload_path = _batch_paths(manifest.spool_key)
            _write_json(archive, manifest_path, manifest.to_dict())
            archive.writestr(_zip_info(payload_path, compressed=False), stored)
            written_batches[manifest.spool_key] = manifest
            batch_keys.append(manifest.spool_key)
            stored_bytes += len(stored)

        while read_offset < before.st_size:
            fragment_metadata: dict[str, object] | None = None
            if fragment_plan is None:
                try:
                    source = _read_chunk(
                        handle,
                        read_offset,
                        before.st_size,
                        chunk_bytes=chunk_bytes,
                        max_object_bytes=max_object_bytes,
                    )
                except _OversizedNativeRecord:
                    fragment_plan = _native_record_fragment_plan(
                        handle,
                        read_offset,
                        before.st_size,
                        fragment_bytes=max_object_bytes,
                    )
                    handle.seek(read_offset)
                    source = handle.read(
                        min(
                            max_object_bytes,
                            fragment_plan.end_offset - read_offset,
                        )
                    )
            else:
                handle.seek(read_offset)
                source = handle.read(
                    min(max_object_bytes, fragment_plan.end_offset - read_offset)
                )
            if fragment_plan is not None:
                fragment_metadata = {
                    "native_record_start_offset": fragment_plan.start_offset,
                    "native_record_end_offset": fragment_plan.end_offset,
                    "native_record_sha256": fragment_plan.sha256,
                    "fragment_index": (
                        (read_offset - fragment_plan.start_offset) // max_object_bytes
                    ),
                    "fragment_count": fragment_plan.fragment_count,
                }
            if not source:
                raise BackfillError(
                    f"could not make progress reading {rollout.scope}/{rollout.relative_path}"
                )
            pending.append(
                compression_executor.submit(
                    build_rollout_batch,
                    source,
                    source_stream_key=stream_key,
                    generation_key=generation_key,
                    generation_seq=generation_seq,
                    start_offset=read_offset,
                    observed_native_session_id=_native_session_id(rollout.path),
                    collector_version=collector_version,
                    native_record_fragment=fragment_metadata,
                )
            )
            source_hash.update(source)
            read_offset += len(source)
            if (
                fragment_plan is not None
                and read_offset == fragment_plan.end_offset
            ):
                fragment_plan = None
            if len(pending) >= max_in_flight:
                write_next_batch()
        while pending:
            write_next_batch()
        if before.st_size == 0:
            empty_path = f"empty/{session_key}.jsonl"
            archive.writestr(_zip_info(empty_path, compressed=False), b"")
        after = os.fstat(handle.fileno())
    stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
    if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
        raise BackfillError(
            f"rollout changed during export: {rollout.scope}/{rollout.relative_path}"
        )
    return {
        "session_key": session_key,
        "scope": rollout.scope,
        "relative_path": rollout.relative_path,
        "observed_native_session_id": _native_session_id(rollout.path),
        "source_stream_key": stream_key,
        "generation_seq": generation_seq,
        "generation_key": generation_key,
        "source_byte_count": before.st_size,
        "source_sha256": source_hash.hexdigest(),
        "stored_byte_count": stored_bytes,
        "batch_count": len(batch_keys),
        "batch_keys": batch_keys,
        **({"empty_path": f"empty/{session_key}.jsonl"} if before.st_size == 0 else {}),
    }


def _read_json_member(
    archive: zipfile.ZipFile, name: str, maximum: int
) -> Mapping[str, object]:
    try:
        info = archive.getinfo(name)
    except KeyError as error:
        raise BackfillError(f"archive is missing {name}") from error
    if info.file_size > maximum:
        raise BackfillError(f"archive member is too large: {name}")
    try:
        value = json.loads(archive.read(info))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BackfillError(f"archive member is invalid JSON: {name}") from error
    if not isinstance(value, dict):
        raise BackfillError(f"archive member must be a JSON object: {name}")
    return value


def _archive_manifest(
    archive: zipfile.ZipFile,
) -> tuple[Mapping[str, object], str, set[str]]:
    names = [item.filename for item in archive.infolist()]
    if len(names) != len(set(names)):
        raise BackfillError("archive contains duplicate member names")
    if any(
        name.startswith("/") or ".." in Path(name).parts or "\\" in name
        for name in names
    ):
        raise BackfillError("archive contains an unsafe member name")
    try:
        info = archive.getinfo(ARCHIVE_MANIFEST_PATH)
    except KeyError as error:
        raise BackfillError(f"archive is missing {ARCHIVE_MANIFEST_PATH}") from error
    if info.file_size > MAX_ARCHIVE_MANIFEST_BYTES:
        raise BackfillError("archive manifest is too large")
    raw = archive.read(info)
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BackfillError("archive manifest is invalid JSON") from error
    if not isinstance(value, dict):
        raise BackfillError("archive manifest must be a JSON object")
    if value.get("archive_version") != ARCHIVE_VERSION:
        raise BackfillError("unsupported backfill archive version")
    if value.get("provider") != "codex" or value.get("source_roots") != [
        "sessions",
        "archived_sessions",
    ]:
        raise BackfillError("archive source identity is unsupported")
    sessions = value.get("sessions")
    if not isinstance(sessions, list) or value.get("session_count") != len(sessions):
        raise BackfillError("archive session_count does not match sessions")
    return value, hashlib.sha256(raw).hexdigest(), set(names)


def _string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise BackfillError(f"{field} must be a non-empty string")
    return value


def _integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise BackfillError(f"{field} must be a non-negative integer")
    return value


def _session_entries(manifest: Mapping[str, object]) -> list[Mapping[str, object]]:
    sessions = manifest["sessions"]
    assert isinstance(sessions, list)
    result: list[Mapping[str, object]] = []
    total_batches = total_source = total_stored = 0
    seen_paths: set[tuple[str, str]] = set()
    seen_batch_keys: set[str] = set()
    for index, raw in enumerate(sessions):
        if not isinstance(raw, dict):
            raise BackfillError(f"session {index} must be an object")
        scope = _string(raw.get("scope"), f"session {index}.scope")
        relative = _string(raw.get("relative_path"), f"session {index}.relative_path")
        if scope not in {"sessions", "archived_sessions"}:
            raise BackfillError(f"session {index}.scope is unsupported")
        if Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise BackfillError(f"session {index}.relative_path is unsafe")
        if (scope, relative) in seen_paths:
            raise BackfillError("archive contains duplicate session paths")
        seen_paths.add((scope, relative))
        for field in (
            "session_key",
            "source_stream_key",
            "generation_key",
            "source_sha256",
        ):
            value = raw.get(field)
            if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
                raise BackfillError(f"session {index}.{field} is not a SHA-256")
        _integer(raw.get("generation_seq"), f"session {index}.generation_seq")
        batch_keys = raw.get("batch_keys")
        if not isinstance(batch_keys, list) or any(
            not isinstance(key, str) or not SHA256_RE.fullmatch(key)
            for key in batch_keys
        ):
            raise BackfillError(f"session {index}.batch_keys is invalid")
        if raw.get("batch_count") != len(batch_keys):
            raise BackfillError(f"session {index}.batch_count does not match")
        duplicate_keys = seen_batch_keys.intersection(batch_keys)
        if duplicate_keys:
            raise BackfillError(
                f"archive references batch {sorted(duplicate_keys)[0]} more than once"
            )
        seen_batch_keys.update(batch_keys)
        total_batches += len(batch_keys)
        total_source += _integer(
            raw.get("source_byte_count"), f"session {index}.source_byte_count"
        )
        total_stored += _integer(
            raw.get("stored_byte_count"), f"session {index}.stored_byte_count"
        )
        if batch_keys and "empty_path" in raw:
            raise BackfillError(f"session {index} cannot have batches and empty_path")
        if not batch_keys:
            expected_empty = f"empty/{raw['session_key']}.jsonl"
            if raw.get("empty_path") != expected_empty:
                raise BackfillError(f"session {index}.empty_path is invalid")
            if raw.get("source_byte_count") != 0 or raw.get("stored_byte_count") != 0:
                raise BackfillError(f"session {index} empty byte counts must be zero")
        result.append(raw)
    expected = {
        "batch_count": total_batches,
        "source_byte_count": total_source,
        "stored_byte_count": total_stored,
    }
    for field, value in expected.items():
        if manifest.get(field) != value:
            raise BackfillError(f"archive {field} does not match its sessions")
    return result


def _validate_archive_members(
    names: set[str], sessions: list[Mapping[str, object]]
) -> None:
    expected = {ARCHIVE_MANIFEST_PATH}
    for session in sessions:
        keys = session["batch_keys"]
        assert isinstance(keys, list)
        for key in keys:
            assert isinstance(key, str)
            expected.update(_batch_paths(key))
        empty_path = session.get("empty_path")
        if empty_path is not None:
            expected.add(_string(empty_path, "empty_path"))
    missing = sorted(expected - names)
    unexpected = sorted(names - expected)
    if missing:
        raise BackfillError(f"archive is missing {missing[0]}")
    if unexpected:
        raise BackfillError(f"archive contains unexpected member {unexpected[0]}")


def _load_upload_state(path: Path, manifest_sha256: str) -> set[str]:
    if not path.exists():
        return set()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BackfillError(f"upload state is unreadable: {path}") from error
    if (
        not isinstance(value, dict)
        or value.get("state_version") != UPLOAD_STATE_VERSION
        or value.get("archive_manifest_sha256") != manifest_sha256
        or not isinstance(value.get("completed_batch_keys"), list)
    ):
        raise BackfillError("upload state does not match this archive")
    completed = value["completed_batch_keys"]
    if any(
        not isinstance(item, str) or not SHA256_RE.fullmatch(item) for item in completed
    ):
        raise BackfillError("upload state contains an invalid batch key")
    return set(completed)


def _save_upload_state(path: Path, manifest_sha256: str, completed: set[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    value = {
        "state_version": UPLOAD_STATE_VERSION,
        "archive_manifest_sha256": manifest_sha256,
        "updated_at": utc_now(),
        "completed_batch_keys": sorted(completed),
    }
    encoded = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        temporary.unlink(missing_ok=True)


def _validate_completed_sessions(
    completed: set[str], sessions: list[Mapping[str, object]]
) -> None:
    archive_keys: set[str] = set()
    for session in sessions:
        raw_keys = session["batch_keys"]
        assert isinstance(raw_keys, list)
        keys = {str(key) for key in raw_keys}
        archive_keys.update(keys)
        present = keys.intersection(completed)
        if present and present != keys:
            raise BackfillError(
                "upload state contains a partially checkpointed session"
            )
    unknown = completed - archive_keys
    if unknown:
        raise BackfillError(f"upload state contains unknown batch {sorted(unknown)[0]}")


def _batch_item(
    archive: zipfile.ZipFile, key: str, session: Mapping[str, object]
) -> tuple[SpoolItem, bytes]:
    manifest_path, payload_path = _batch_paths(key)
    raw_manifest = _read_json_member(archive, manifest_path, MAX_BATCH_MANIFEST_BYTES)
    try:
        manifest = BatchManifest.from_dict(raw_manifest)
    except ContractError as error:
        raise BackfillError(f"invalid batch manifest {key}: {error}") from error
    if manifest.spool_key != key:
        raise BackfillError(f"batch key does not match its manifest: {key}")
    expected = {
        "source_stream_key": session.get("source_stream_key"),
        "generation_seq": session.get("generation_seq"),
        "generation_key": session.get("generation_key"),
        "observed_native_session_id": session.get("observed_native_session_id"),
    }
    for field, value in expected.items():
        if getattr(manifest, field) != value:
            raise BackfillError(f"batch {key} has conflicting {field}")
    try:
        info = archive.getinfo(payload_path)
    except KeyError as error:
        raise BackfillError(f"archive is missing {payload_path}") from error
    if info.file_size != manifest.stored_byte_count:
        raise BackfillError(f"batch payload size does not match: {key}")
    stored = archive.read(info)
    try:
        source = validate_stored_payload(manifest, stored)
    except ContractError as error:
        raise BackfillError(f"invalid batch payload {key}: {error}") from error
    return (
        SpoolItem(
            manifest,
            stored,
            {
                "archive_version": ARCHIVE_VERSION,
                "session_key": session.get("session_key"),
            },
        ),
        source,
    )


def _upload_items(
    transport: UploadTransport, items: Sequence[SpoolItem], retries: int
) -> tuple[Mapping[str, object], ...]:
    for attempt in range(retries + 1):
        try:
            upload_many = getattr(transport, "upload_many", None)
            if callable(upload_many):
                raw_receipts = upload_many(items)
            else:
                raw_receipts = [transport.upload(item) for item in items]
            if len(raw_receipts) != len(items):
                raise BackfillError("upload receipt count does not match request")
            return tuple(
                validate_committed_receipt(item.manifest, receipt)
                for item, receipt in zip(items, raw_receipts, strict=True)
            )
        except TransientUploadError:
            if attempt >= retries:
                raise
            time.sleep(min(8.0, 0.5 * (2**attempt)))
    raise AssertionError("retry loop did not return")


@dataclass
class _SessionUploadProgress:
    uploaded: set[str]
    source_bytes: int = 0
    skipped: int = 0


class _BulkUploadBuffer:
    def __init__(self, transport: UploadTransport, retries: int):
        self.transport = transport
        self.retries = retries
        self.pending: list[tuple[SpoolItem, _SessionUploadProgress]] = []
        self.pending_request_bytes = 12
        self.pending_source_bytes = 0
        self.pending_manifest_bytes = 0
        self.max_batch_items = int(getattr(transport, "max_batch_items", 1))
        self.max_request_bytes = int(
            getattr(transport, "max_batch_request_bytes", 0)
        )
        self.max_source_bytes = int(
            getattr(transport, "max_batch_source_bytes", 0)
        )
        self.max_manifest_bytes = int(
            getattr(transport, "max_batch_manifest_bytes", 0)
        )

    def add(self, item: SpoolItem, owner: _SessionUploadProgress) -> None:
        bulk_manifest_size = getattr(self.transport, "bulk_manifest_size", None)
        if callable(bulk_manifest_size):
            item_manifest_bytes = int(bulk_manifest_size(item))
        else:
            item_manifest_bytes = len(
                json.dumps(
                    item.manifest.to_dict(), separators=(",", ":")
                ).encode("utf-8")
            )
        bulk_item_size = getattr(self.transport, "bulk_item_size", None)
        item_request_bytes = (
            int(bulk_item_size(item))
            if callable(bulk_item_size)
            else 8 + item_manifest_bytes + len(item.stored_payload)
        )
        item_source_bytes = item.manifest.source_byte_count
        if self.pending and (
            len(self.pending) >= self.max_batch_items
            or (
                self.max_request_bytes > 0
                and self.pending_request_bytes + item_request_bytes
                > self.max_request_bytes
            )
            or (
                self.max_source_bytes > 0
                and self.pending_source_bytes + item_source_bytes
                > self.max_source_bytes
            )
            or (
                self.max_manifest_bytes > 0
                and self.pending_manifest_bytes + item_manifest_bytes
                > self.max_manifest_bytes
            )
        ):
            self.flush()
        self.pending.append((item, owner))
        self.pending_request_bytes += item_request_bytes
        self.pending_source_bytes += item_source_bytes
        self.pending_manifest_bytes += item_manifest_bytes

    def flush(self) -> None:
        if not self.pending:
            return
        _upload_items(
            self.transport,
            [item for item, _owner in self.pending],
            self.retries,
        )
        for item, owner in self.pending:
            owner.uploaded.add(item.manifest.spool_key)
            owner.source_bytes += item.manifest.source_byte_count
        self.pending.clear()
        self.pending_request_bytes = 12
        self.pending_source_bytes = 0
        self.pending_manifest_bytes = 0


def _prepare_session_upload(
    archive: zipfile.ZipFile,
    session: Mapping[str, object],
    completed: set[str],
    buffer: _BulkUploadBuffer,
) -> _SessionUploadProgress:
    keys = session["batch_keys"]
    assert isinstance(keys, list)
    if keys and all(key in completed for key in keys):
        return _SessionUploadProgress(set(), skipped=len(keys))
    result = _SessionUploadProgress(set())
    stored_bytes = 0
    expected_offset = 0
    source_hash = hashlib.sha256()
    if not keys:
        empty_path = _string(session.get("empty_path"), "empty_path")
        try:
            empty_info = archive.getinfo(empty_path)
        except KeyError as error:
            raise BackfillError(f"archive is missing {empty_path}") from error
        if empty_info.file_size != 0:
            raise BackfillError(f"empty session member is not empty: {empty_path}")
    for key in keys:
        assert isinstance(key, str)
        item, source = _batch_item(archive, key, session)
        if item.manifest.start_offset != expected_offset:
            raise BackfillError(
                f"session {session.get('relative_path')} has a byte-range gap"
            )
        source_hash.update(source)
        expected_offset = item.manifest.end_offset
        stored_bytes += item.manifest.stored_byte_count
        if key in completed:
            continue
        buffer.add(item, result)
    expected_size = _integer(session.get("source_byte_count"), "source_byte_count")
    if expected_offset != expected_size:
        raise BackfillError(
            f"session {session.get('relative_path')} byte count does not match batches"
        )
    expected_stored = _integer(session.get("stored_byte_count"), "stored_byte_count")
    if stored_bytes != expected_stored:
        raise BackfillError(
            f"session {session.get('relative_path')} stored byte count does not match"
        )
    expected_hash = _string(session.get("source_sha256"), "source_sha256")
    if source_hash.hexdigest() != expected_hash:
        raise BackfillError(
            f"session {session.get('relative_path')} source hash does not match"
        )
    return result


def _upload_sessions(
    archive: zipfile.ZipFile,
    sessions: Sequence[Mapping[str, object]],
    completed: set[str],
    transport: UploadTransport,
    retries: int,
) -> tuple[tuple[set[str], int, int], ...]:
    buffer = _BulkUploadBuffer(transport, retries)
    results = [
        _prepare_session_upload(archive, session, completed, buffer)
        for session in sessions
    ]
    buffer.flush()
    return tuple(
        (result.uploaded, result.source_bytes, result.skipped)
        for result in results
    )


def _upload_session(
    archive: zipfile.ZipFile,
    session: Mapping[str, object],
    completed: set[str],
    transport: UploadTransport,
    retries: int,
) -> tuple[set[str], int, int]:
    return _upload_sessions(
        archive, [session], completed, transport, retries
    )[0]


def upload_archive(
    archive: Path | str,
    transport: UploadTransport,
    *,
    workers: int = MAX_UPLOAD_WORKERS,
    retries: int = 4,
    state_path: Path | str | None = None,
    resume: bool = True,
    progress: Callable[[int, int, str], None] | None = None,
) -> UploadResult:
    if workers < 1 or workers > MAX_UPLOAD_WORKERS:
        raise BackfillError(
            f"upload workers must be between 1 and {MAX_UPLOAD_WORKERS}"
        )
    if retries < 0 or retries > 10:
        raise BackfillError("retries must be between 0 and 10")
    archive_path = Path(archive).expanduser().resolve()
    if not archive_path.is_file():
        raise BackfillError(f"archive does not exist: {archive_path}")
    archive_handle = zipfile.ZipFile(archive_path, "r", allowZip64=True)
    try:
        manifest, manifest_hash, member_names = _archive_manifest(archive_handle)
        sessions = _session_entries(manifest)
        _validate_archive_members(member_names, sessions)
        checkpoint = (
            Path(state_path).expanduser().resolve()
            if state_path
            else archive_path.with_name(f"{archive_path.name}.upload-state.json")
        )
        completed = _load_upload_state(checkpoint, manifest_hash) if resume else set()
        _validate_completed_sessions(completed, sessions)
        completed_lock = threading.Lock()
        uploaded_total = skipped_total = source_total = finished = 0
        dirty_sessions = 0
        last_checkpoint_at = time.monotonic()

        session_groups = [
            sessions[index : index + UPLOAD_SESSION_GROUP_SIZE]
            for index in range(0, len(sessions), UPLOAD_SESSION_GROUP_SIZE)
        ]

        def run(
            group: Sequence[Mapping[str, object]],
        ) -> tuple[tuple[set[str], int, int], ...]:
            with completed_lock:
                snapshot = set(completed)
            return _upload_sessions(
                archive_handle, group, snapshot, transport, retries
            )

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(run, group): group for group in session_groups
            }
            try:
                for future in as_completed(futures):
                    group = futures[future]
                    results = future.result()
                    for session, result in zip(group, results, strict=True):
                        newly_completed, source_bytes, skipped = result
                        with completed_lock:
                            completed.update(newly_completed)
                            if newly_completed:
                                dirty_sessions += 1
                            checkpoint_due = dirty_sessions >= 25 or (
                                dirty_sessions > 0
                                and time.monotonic() - last_checkpoint_at >= 2.0
                            )
                            if resume and checkpoint_due:
                                _save_upload_state(
                                    checkpoint, manifest_hash, completed
                                )
                                dirty_sessions = 0
                                last_checkpoint_at = time.monotonic()
                        uploaded_total += len(newly_completed)
                        skipped_total += skipped
                        source_total += source_bytes
                        finished += 1
                        if progress:
                            progress(
                                finished,
                                len(sessions),
                                str(session.get("relative_path")),
                            )
            except Exception:
                for future in futures:
                    future.cancel()
                if resume and dirty_sessions:
                    _save_upload_state(checkpoint, manifest_hash, completed)
                raise
        if resume and (dirty_sessions or not checkpoint.exists()):
            _save_upload_state(checkpoint, manifest_hash, completed)
    finally:
        archive_handle.close()
    return UploadResult(
        str(archive_path),
        len(sessions),
        uploaded_total,
        skipped_total,
        source_total,
        str(checkpoint) if resume else None,
    )
