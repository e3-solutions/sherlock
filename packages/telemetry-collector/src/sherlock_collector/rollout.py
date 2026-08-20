from __future__ import annotations

import fcntl
import hashlib
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Mapping

from .contract import (
    FRAGMENT_BYTES,
    MAX_LOGICAL_RECORD_BYTES,
    MAX_RECORDS,
    MAX_SOURCE_BYTES,
    ContractError,
    build_rollout_batch,
)
from .spool import DurableSpool, _atomic_json, secure_lock

DEFAULT_CHUNK_BYTES = 512 * 1024
DEFAULT_MAX_FILES = 64
DEFAULT_MAX_SYNC_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_OBJECT_BYTES = MAX_SOURCE_BYTES
PREFIX_BYTES = 4096
SCAN_BYTES = 1024 * 1024


class _OversizedNativeRecord(ContractError):
    pass


@dataclass(frozen=True)
class NativeRecordFragmentPlan:
    start_offset: int
    end_offset: int
    sha256: str
    fragment_count: int


@dataclass
class StreamState:
    path: str
    device: int
    inode: int
    prefix_length: int
    prefix_sha256: str
    generation_seq: int
    generation_key: str
    offset: int


@dataclass(frozen=True)
class CaptureResult:
    enqueued: int = 0
    captured_bytes: int = 0
    locked: bool = False
    errors: int = 0


def _stream_key(path: Path) -> str:
    return hashlib.sha256(str(path.resolve()).encode()).hexdigest()


def _prefix(handle, size: int) -> tuple[int, str]:
    length = min(PREFIX_BYTES, size)
    handle.seek(0)
    return length, hashlib.sha256(handle.read(length)).hexdigest()


def _generation_key(
    path: Path,
    device: int,
    inode: int,
    prefix_sha256: str,
    generation_seq: int,
) -> str:
    value = f"{path.resolve()}\0{device}\0{inode}\0{prefix_sha256}\0{generation_seq}"
    return hashlib.sha256(value.encode()).hexdigest()


class RolloutCapturer:
    def __init__(
        self,
        state_root: Path | str,
        spool: DurableSpool,
        *,
        chunk_bytes: int = DEFAULT_CHUNK_BYTES,
        max_object_bytes: int = DEFAULT_MAX_OBJECT_BYTES,
        max_record_bytes: int = MAX_LOGICAL_RECORD_BYTES,
        collector_version: str = "0.1.0",
    ):
        if not (
            0 < chunk_bytes <= max_object_bytes <= MAX_SOURCE_BYTES
            and MAX_SOURCE_BYTES <= max_record_bytes <= MAX_LOGICAL_RECORD_BYTES
        ):
            raise ValueError(
                "capture byte limits are invalid or exceed the rollout contract"
            )
        self.state_root = Path(state_root)
        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.state_root, 0o700)
        self.state_path = self.state_root / "rollout-state.json"
        self.state_backup_path = self.state_root / "rollout-state.previous.json"
        self.lock_path = self.state_root / "rollout-sync.lock"
        self.spool = spool
        self.chunk_bytes = chunk_bytes
        self.max_object_bytes = max_object_bytes
        self.max_record_bytes = max_record_bytes
        self.collector_version = collector_version

    def capture(
        self,
        paths: Iterable[Path | str],
        *,
        native_session_ids: Mapping[str, str] | None = None,
        max_files: int = DEFAULT_MAX_FILES,
        max_sync_bytes: int = DEFAULT_MAX_SYNC_BYTES,
        best_effort: bool = False,
        priority_count: int = 0,
    ) -> CaptureResult:
        with secure_lock(self.lock_path) as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return CaptureResult(locked=True)
            states, candidate_cursor = self._load_state()
            enqueued = captured = errors = 0
            all_paths = list(dict.fromkeys(str(Path(item).resolve()) for item in paths))
            priority_count = min(max(0, priority_count), len(all_paths), max_files)
            priority_paths = all_paths[:priority_count]
            backlog_paths = sorted(all_paths[priority_count:])
            if backlog_paths:
                candidate_cursor %= len(backlog_paths)
                rotated = (
                    backlog_paths[candidate_cursor:] + backlog_paths[:candidate_cursor]
                )
                selected_paths = priority_paths + rotated[: max_files - priority_count]
            else:
                selected_paths = priority_paths
            visited_backlog = 0
            for raw_path in selected_paths:
                if captured >= max_sync_bytes:
                    break
                if raw_path not in priority_paths:
                    visited_backlog += 1
                path = Path(raw_path)
                try:
                    path_enqueued, path_captured = self._capture_path(
                        path,
                        states,
                        native_session_ids or {},
                        max_sync_bytes - captured,
                        candidate_cursor,
                    )
                except (ContractError, OSError, ValueError):
                    if not best_effort:
                        raise
                    errors += 1
                    continue
                enqueued += path_enqueued
                captured += path_captured
            next_cursor = (
                (candidate_cursor + visited_backlog) % len(backlog_paths)
                if backlog_paths
                else 0
            )
            self._save_state(states, next_cursor, update_backup=True)
            return CaptureResult(enqueued, captured, False, errors)

    def _capture_path(
        self,
        path: Path,
        states: dict[str, StreamState],
        native_session_ids: Mapping[str, str],
        byte_budget: int,
        candidate_cursor: int,
    ) -> tuple[int, int]:
        if not path.is_file():
            return 0, 0
        with path.open("rb") as handle:
            key = _stream_key(path)
            state = states.get(key)
            details = os.fstat(handle.fileno())
            initial_empty_growth = (
                state is not None
                and state.prefix_length == 0
                and state.offset == 0
                and state.path == str(path)
                and state.device == details.st_dev
                and state.inode == details.st_ino
                and details.st_size > 0
            )
            fingerprint_size = (
                details.st_size
                if state is None or initial_empty_growth
                else min(state.prefix_length, details.st_size)
            )
            prefix_length, prefix_sha = _prefix(handle, fingerprint_size)
            if initial_empty_growth:
                state.prefix_length = prefix_length
                state.prefix_sha256 = prefix_sha
            replaced = state is None or not self._same_generation(
                state, path, details, prefix_length, prefix_sha
            )
            if replaced:
                sequence = 0 if state is None else state.generation_seq + 1
                state = StreamState(
                    path=str(path),
                    device=details.st_dev,
                    inode=details.st_ino,
                    prefix_length=prefix_length,
                    prefix_sha256=prefix_sha,
                    generation_seq=sequence,
                    generation_key=_generation_key(
                        path,
                        details.st_dev,
                        details.st_ino,
                        prefix_sha,
                        sequence,
                    ),
                    offset=0,
                )
            stable_end = details.st_size
            enqueued = captured = 0
            while state.offset < stable_end and captured < byte_budget:
                remaining_budget = byte_budget - captured
                try:
                    source = self._read_chunk(
                        handle,
                        state.offset,
                        stable_end,
                        min(self.chunk_bytes, remaining_budget),
                    )
                except _OversizedNativeRecord:
                    # max_sync_bytes is a batch-selection budget. One logical
                    # record may exceed it because every deterministic fragment
                    # must be durable before the logical cursor can advance.
                    plan = self._native_record_fragment_plan(
                        handle,
                        state.offset,
                        stable_end,
                    )
                    if plan.end_offset - plan.start_offset <= MAX_SOURCE_BYTES:
                        raise ContractError(
                            f"native rollout record exceeds {self.max_object_bytes} bytes"
                        )
                    fragment_enqueued, fragment_captured = self._enqueue_fragments(
                        handle,
                        key,
                        state,
                        plan,
                        native_session_ids.get(str(path)),
                    )
                    after = os.fstat(handle.fileno())
                    if (
                        after.st_dev != details.st_dev
                        or after.st_ino != details.st_ino
                        or after.st_size < stable_end
                    ):
                        raise OSError("native rollout file changed while fragmenting")
                    state.offset = plan.end_offset
                    states[key] = state
                    self._save_state(states, candidate_cursor)
                    enqueued += fragment_enqueued
                    captured += fragment_captured
                    continue
                if not source:
                    break
                manifest, stored = build_rollout_batch(
                    source,
                    source_stream_key=key,
                    generation_key=state.generation_key,
                    generation_seq=state.generation_seq,
                    start_offset=state.offset,
                    observed_native_session_id=native_session_ids.get(str(path)),
                    collector_version=self.collector_version,
                )
                self.spool.enqueue(manifest, stored)
                state.offset = manifest.end_offset
                states[key] = state
                self._save_state(states, candidate_cursor)
                enqueued += 1
                captured += len(source)
            states[key] = state
            return enqueued, captured

    def _native_record_fragment_plan(
        self,
        handle,
        start: int,
        stable_end: int,
    ) -> NativeRecordFragmentPlan:
        handle.seek(start)
        digest = hashlib.sha256()
        end = start
        while end < stable_end:
            chunk = handle.read(min(SCAN_BYTES, stable_end - end))
            if not chunk:
                break
            newline = chunk.find(b"\n")
            selected = chunk if newline < 0 else chunk[: newline + 1]
            digest.update(selected)
            end += len(selected)
            if end - start > self.max_record_bytes:
                raise ContractError(
                    f"native rollout record exceeds {self.max_record_bytes} bytes"
                )
            if newline >= 0:
                break
        length = end - start
        if length <= self.max_object_bytes:
            raise ContractError("could not locate an oversized native rollout record")
        return NativeRecordFragmentPlan(
            start_offset=start,
            end_offset=end,
            sha256=digest.hexdigest(),
            fragment_count=(length + FRAGMENT_BYTES - 1) // FRAGMENT_BYTES,
        )

    def _enqueue_fragments(
        self,
        handle,
        source_stream_key: str,
        state: StreamState,
        plan: NativeRecordFragmentPlan,
        observed_native_session_id: str | None,
    ) -> tuple[int, int]:
        captured = 0
        digest = hashlib.sha256()
        for fragment_index in range(plan.fragment_count):
            start = plan.start_offset + fragment_index * FRAGMENT_BYTES
            end = min(start + FRAGMENT_BYTES, plan.end_offset)
            handle.seek(start)
            source = handle.read(end - start)
            if len(source) != end - start:
                raise OSError("native rollout record changed while fragmenting")
            digest.update(source)
            manifest, stored = build_rollout_batch(
                source,
                source_stream_key=source_stream_key,
                generation_key=state.generation_key,
                generation_seq=state.generation_seq,
                start_offset=start,
                observed_native_session_id=observed_native_session_id,
                collector_version=self.collector_version,
                native_record_fragment={
                    "native_record_start_offset": plan.start_offset,
                    "native_record_end_offset": plan.end_offset,
                    "native_record_sha256": plan.sha256,
                    "fragment_index": fragment_index,
                    "fragment_count": plan.fragment_count,
                },
            )
            self.spool.enqueue(manifest, stored)
            captured += len(source)
        if digest.hexdigest() != plan.sha256:
            raise OSError("native rollout record changed while fragmenting")
        return plan.fragment_count, captured

    @staticmethod
    def _same_generation(
        state: StreamState,
        path: Path,
        stat: os.stat_result,
        prefix_length: int,
        prefix_sha: str,
    ) -> bool:
        return (
            state.path == str(path)
            and state.device == stat.st_dev
            and state.inode == stat.st_ino
            and stat.st_size >= state.offset
            and state.prefix_length == prefix_length
            and state.prefix_sha256 == prefix_sha
        )

    def _read_chunk(self, handle, start: int, stable_end: int, limit: int) -> bytes:
        handle.seek(start)
        remaining = stable_end - start
        candidate = handle.read(min(limit, remaining))
        if len(candidate) == remaining or candidate.endswith(b"\n"):
            return self._limit_records(candidate)
        newline = candidate.rfind(b"\n")
        if newline >= 0:
            return self._limit_records(candidate[: newline + 1])
        # One native record exceeds the normal chunk size. Keep it whole rather than
        # splitting or truncating source evidence.
        overflow_limit = min(self.max_object_bytes, remaining)
        overflow = handle.read(overflow_limit - len(candidate))
        complete = candidate + overflow
        newline = complete.find(b"\n", len(candidate))
        if newline < 0 and remaining > overflow_limit:
            raise _OversizedNativeRecord(
                f"native rollout record exceeds {self.max_object_bytes} bytes"
            )
        return self._limit_records(complete if newline < 0 else complete[: newline + 1])

    @staticmethod
    def _limit_records(source: bytes) -> bytes:
        search_from = 0
        last_newline = -1
        for _ in range(MAX_RECORDS):
            last_newline = source.find(b"\n", search_from)
            if last_newline < 0:
                return source
            search_from = last_newline + 1
        if search_from < len(source):
            return source[:search_from]
        return source

    def _load_state(self) -> tuple[dict[str, StreamState], int]:
        errors: list[Exception] = []
        for path in (self.state_path, self.state_backup_path):
            if not path.exists():
                continue
            try:
                result = self._read_state(path)
            except (
                OSError,
                UnicodeDecodeError,
                json.JSONDecodeError,
                TypeError,
                ValueError,
            ) as error:
                errors.append(error)
                continue
            if path == self.state_backup_path:
                self._save_state(*result)
            return result
        if errors:
            raise ValueError("rollout state and backup are unreadable") from errors[0]
        return {}, 0

    @staticmethod
    def _read_state(path: Path) -> tuple[dict[str, StreamState], int]:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("rollout state must be an object")
        if raw.get("state_version") != 1 or not isinstance(raw.get("streams"), dict):
            raise ValueError("unsupported rollout state")
        cursor = raw.get("candidate_cursor", 0)
        if not isinstance(cursor, int) or cursor < 0:
            raise ValueError("invalid rollout candidate cursor")
        return (
            {key: StreamState(**value) for key, value in raw["streams"].items()},
            cursor,
        )

    def _save_state(
        self,
        states: Mapping[str, StreamState],
        candidate_cursor: int,
        update_backup: bool = False,
    ) -> None:
        value = {
            "state_version": 1,
            "candidate_cursor": candidate_cursor,
            "streams": {key: asdict(value) for key, value in states.items()},
        }
        _atomic_json(
            self.state_path,
            value,
        )
        if update_backup:
            _atomic_json(self.state_backup_path, value)
