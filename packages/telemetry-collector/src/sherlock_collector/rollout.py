from __future__ import annotations

import fcntl
import hashlib
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Mapping

from .contract import ContractError, MAX_RECORDS, build_rollout_batch
from .spool import DurableSpool, _atomic_json, secure_lock

DEFAULT_CHUNK_BYTES = 512 * 1024
DEFAULT_MAX_OBJECT_BYTES = 5 * 1024 * 1024
PREFIX_BYTES = 4096


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
        collector_version: str = "0.1.0",
    ):
        self.state_root = Path(state_root)
        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.state_root, 0o700)
        self.state_path = self.state_root / "rollout-state.json"
        self.lock_path = self.state_root / "rollout-sync.lock"
        self.spool = spool
        self.chunk_bytes = chunk_bytes
        self.max_object_bytes = max_object_bytes
        self.collector_version = collector_version

    def capture(
        self,
        paths: Iterable[Path | str],
        *,
        native_session_ids: Mapping[str, str] | None = None,
        max_files: int = 16,
        max_sync_bytes: int = 2 * DEFAULT_CHUNK_BYTES,
    ) -> CaptureResult:
        with secure_lock(self.lock_path) as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return CaptureResult(locked=True)
            states, candidate_cursor = self._load_state()
            enqueued = captured = 0
            all_paths = sorted({str(Path(item).resolve()) for item in paths})
            if all_paths:
                candidate_cursor %= len(all_paths)
                rotated = all_paths[candidate_cursor:] + all_paths[:candidate_cursor]
                selected_paths = rotated[:max_files]
            else:
                selected_paths = []
            visited_candidates = 0
            for raw_path in selected_paths:
                if captured >= max_sync_bytes:
                    break
                visited_candidates += 1
                path = Path(raw_path)
                if not path.is_file():
                    continue
                try:
                    handle = path.open("rb")
                except OSError:
                    continue
                with handle:
                    key = _stream_key(path)
                    state = states.get(key)
                    stat = os.fstat(handle.fileno())
                    initial_empty_growth = (
                        state is not None
                        and state.prefix_length == 0
                        and state.offset == 0
                        and state.path == str(path)
                        and state.device == stat.st_dev
                        and state.inode == stat.st_ino
                        and stat.st_size > 0
                    )
                    fingerprint_size = (
                        stat.st_size
                        if state is None or initial_empty_growth
                        else min(state.prefix_length, stat.st_size)
                    )
                    prefix_length, prefix_sha = _prefix(handle, fingerprint_size)
                    if initial_empty_growth:
                        state.prefix_length = prefix_length
                        state.prefix_sha256 = prefix_sha
                    replaced = state is None or not self._same_generation(
                        state, path, stat, prefix_length, prefix_sha
                    )
                    if replaced:
                        sequence = 0 if state is None else state.generation_seq + 1
                        state = StreamState(
                            path=str(path),
                            device=stat.st_dev,
                            inode=stat.st_ino,
                            prefix_length=prefix_length,
                            prefix_sha256=prefix_sha,
                            generation_seq=sequence,
                            generation_key=_generation_key(
                                path, stat.st_dev, stat.st_ino, prefix_sha, sequence
                            ),
                            offset=0,
                        )
                    stable_end = stat.st_size
                    while state.offset < stable_end and captured < max_sync_bytes:
                        remaining_budget = max_sync_bytes - captured
                        source = self._read_chunk(
                            handle,
                            state.offset,
                            stable_end,
                            min(self.chunk_bytes, remaining_budget),
                        )
                        if not source:
                            break
                        manifest, stored = build_rollout_batch(
                            source,
                            source_stream_key=key,
                            generation_key=state.generation_key,
                            generation_seq=state.generation_seq,
                            start_offset=state.offset,
                            observed_native_session_id=(native_session_ids or {}).get(
                                str(path)
                            ),
                            collector_version=self.collector_version,
                        )
                        self.spool.enqueue(manifest, stored)
                        state.offset = manifest.end_offset
                        states[key] = state
                        self._save_state(states, candidate_cursor)
                        enqueued += 1
                        captured += len(source)
                    states[key] = state
            next_cursor = (
                (candidate_cursor + visited_candidates) % len(all_paths)
                if all_paths
                else 0
            )
            self._save_state(states, next_cursor)
            return CaptureResult(enqueued, captured, False)

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
            raise ContractError(
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
        if not self.state_path.exists():
            return {}, 0
        raw = json.loads(self.state_path.read_text(encoding="utf-8"))
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
        self, states: Mapping[str, StreamState], candidate_cursor: int
    ) -> None:
        _atomic_json(
            self.state_path,
            {
                "state_version": 1,
                "candidate_cursor": candidate_cursor,
                "streams": {key: asdict(value) for key, value in states.items()},
            },
        )
