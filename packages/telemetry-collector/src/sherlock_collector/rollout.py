from __future__ import annotations

import fcntl
import hashlib
import json
import os
import stat as stat_module
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import BinaryIO, Iterable, Mapping

from .contract import (
    FRAGMENT_BYTES,
    MAX_LOGICAL_RECORD_BYTES,
    MAX_RECORDS,
    MAX_SOURCE_BYTES,
    ContractError,
    build_source_batch,
)
from .exclusions import ExclusionPolicy, load_policy
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
    terminated: bool


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
    recovery_reason: str | None = None
    pending_fragment: dict | None = None


# Optional cursor fields stored outside the legacy stream entry shape.
STATE_EXTENSION_FIELDS = ("recovery_reason", "pending_fragment")


@dataclass(frozen=True)
class CaptureResult:
    enqueued: int = 0
    captured_bytes: int = 0
    locked: bool = False
    errors: int = 0
    deferred_files: int = 0
    deferred_bytes: int = 0


@dataclass(frozen=True)
class SourceSnapshot:
    """Identity and immutable end boundary observed while discovering a source."""

    device: int
    inode: int
    end_offset: int
    prefix_length: int
    prefix_sha256: str


def _stream_key(path: Path) -> str:
    return hashlib.sha256(str(path).encode()).hexdigest()


def source_prefix(handle: BinaryIO, size: int) -> tuple[int, str]:
    length = min(PREFIX_BYTES, size)
    handle.seek(0)
    source = handle.read(length)
    if len(source) != length:
        raise OSError("source changed while reading prefix")
    return length, hashlib.sha256(source).hexdigest()


def open_regular_under_root(
    allowed_root: Path | str,
    path: Path | str,
) -> BinaryIO:
    """Open a regular descendant using no-follow descriptor traversal."""
    root = Path(os.path.abspath(Path(allowed_root).expanduser()))
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = Path(os.path.abspath(candidate))
    try:
        relative = candidate.relative_to(root)
    except ValueError as error:
        raise ValueError("capture path is outside allowed_root") from error
    if not relative.parts:
        raise ValueError("capture path must name a file under allowed_root")

    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    # Nonblocking open lets fstat reject a raced FIFO without waiting for a writer.
    file_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    if hasattr(os, "O_CLOEXEC"):
        directory_flags |= os.O_CLOEXEC
        file_flags |= os.O_CLOEXEC
    directory_fds: list[int] = []
    file_fd: int | None = None
    try:
        current_fd = os.open(root, directory_flags)
        directory_fds.append(current_fd)
        for component in relative.parts[:-1]:
            current_fd = os.open(component, directory_flags, dir_fd=current_fd)
            directory_fds.append(current_fd)
        file_fd = os.open(relative.parts[-1], file_flags, dir_fd=current_fd)
        details = os.fstat(file_fd)
        if not stat_module.S_ISREG(details.st_mode):
            raise OSError("capture path is not a regular file")
        os.set_blocking(file_fd, True)
        handle = os.fdopen(file_fd, "rb")
        file_fd = None
        return handle
    finally:
        if file_fd is not None:
            os.close(file_fd)
        for descriptor in reversed(directory_fds):
            os.close(descriptor)


def _generation_key(
    path: Path,
    device: int,
    inode: int,
    prefix_sha256: str,
    generation_seq: int,
) -> str:
    value = f"{path}\0{device}\0{inode}\0{prefix_sha256}\0{generation_seq}"
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
        source_provider: str = "codex",
        source_kind: str = "rollout",
        source_version: str | None = None,
        state_name: str = "rollout",
        capture_unterminated_tail: bool = False,
        allowed_root: Path | str | None = None,
        enforce_sync_budget: bool = False,
        exclusion_policy: ExclusionPolicy | None = None,
        source_home: Path | str | None = None,
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
        self.spool = spool
        self.chunk_bytes = chunk_bytes
        self.max_object_bytes = max_object_bytes
        self.max_record_bytes = max_record_bytes
        self.collector_version = collector_version
        self.source_provider = source_provider
        self.source_kind = source_kind
        self.source_version = source_version
        self.enforce_sync_budget = enforce_sync_budget
        self.exclusion_policy = exclusion_policy
        # Provider home for resolving parent sessions under owner policy; the
        # capture root is used when the sources live in it.
        self.source_home = Path(source_home) if source_home is not None else None
        self.source_issues: dict[str, str] = {}
        self.visited_paths: set[str] = set()
        self._capture_enqueued = self._capture_bytes = 0
        self.capture_unterminated_tail = capture_unterminated_tail
        self.allowed_root_input = (
            Path(os.path.abspath(Path(allowed_root).expanduser()))
            if allowed_root is not None
            else None
        )
        if self.allowed_root_input is not None and (
            self.allowed_root_input.is_symlink() or not self.allowed_root_input.is_dir()
        ):
            raise ValueError("allowed_root must be a directory")
        self.allowed_root = (
            self.allowed_root_input.resolve(strict=True)
            if self.allowed_root_input is not None
            else None
        )
        self.state_path = self.state_root / f"{state_name}-state.json"
        self.state_backup_path = self.state_root / f"{state_name}-state.previous.json"
        self.lock_path = self.state_root / f"{state_name}-sync.lock"

    def capture(
        self,
        paths: Iterable[Path | str],
        *,
        native_session_ids: Mapping[str, str] | None = None,
        parent_native_session_ids: Mapping[str, str] | None = None,
        max_files: int = DEFAULT_MAX_FILES,
        max_sync_bytes: int = DEFAULT_MAX_SYNC_BYTES,
        best_effort: bool = False,
        priority_count: int = 0,
        priority_workload_class: str | None = None,
        backlog_workload_class: str | None = None,
        source_snapshots: Mapping[str, SourceSnapshot] | None = None,
    ) -> CaptureResult:
        with secure_lock(self.lock_path) as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return CaptureResult(locked=True)
            self.source_issues = {}
            self.visited_paths = set()
            self._capture_enqueued = self._capture_bytes = 0
            states, candidate_cursor = self._load_state()
            policy = self.exclusion_policy or load_policy()
            enqueued = captured = errors = 0
            all_paths = list(
                dict.fromkeys(str(self._canonical_path(item)) for item in paths)
            )
            snapshots = {
                str(self._canonical_path(path)): snapshot
                for path, snapshot in (source_snapshots or {}).items()
            }
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
                self.visited_paths.add(raw_path)
                blocked = policy.blocked_reason(
                    self.source_provider,
                    (native_session_ids or {}).get(raw_path),
                    (parent_native_session_ids or {}).get(raw_path),
                    source_home=self.source_home or self.allowed_root,
                    source_path=path,
                )
                if blocked:
                    # Local owner policy: keep the cursor, capture nothing.
                    self.source_issues[raw_path] = blocked
                    continue
                before_enqueued, before_captured = self._capture_enqueued, self._capture_bytes
                try:
                    self._capture_path(
                        path,
                        states,
                        native_session_ids or {},
                        parent_native_session_ids or {},
                        max_sync_bytes - captured,
                        candidate_cursor,
                        (
                            priority_workload_class
                            if raw_path in priority_paths
                            else backlog_workload_class
                        ),
                        snapshots.get(raw_path),
                    )
                except (ContractError, OSError, ValueError) as error:
                    self.source_issues[raw_path] = f"{type(error).__name__}: {error}"
                    if not best_effort:
                        raise
                    errors += 1
                finally:
                    # Include durable chunks written before a later record failed.
                    enqueued += self._capture_enqueued - before_enqueued
                    captured += self._capture_bytes - before_captured
            next_cursor = (
                (candidate_cursor + visited_backlog) % len(backlog_paths)
                if backlog_paths
                else 0
            )
            self._save_state(states, next_cursor, update_backup=True)
            deferred_files, deferred_bytes = self._deferred_snapshots(
                all_paths,
                snapshots,
                states,
            )
            return CaptureResult(
                enqueued,
                captured,
                False,
                errors,
                deferred_files,
                deferred_bytes,
            )

    def _capture_path(
        self,
        path: Path,
        states: dict[str, StreamState],
        native_session_ids: Mapping[str, str],
        parent_native_session_ids: Mapping[str, str],
        byte_budget: int,
        candidate_cursor: int,
        workload_class: str | None,
        snapshot: SourceSnapshot | None,
    ) -> tuple[int, int]:
        if self.allowed_root is None and not path.is_file():
            return 0, 0
        try:
            handle = self._open_source(path)
        except FileNotFoundError:
            return 0, 0
        with handle:
            key = _stream_key(path)
            state = states.get(key)
            details = os.fstat(handle.fileno())
            stable_end = details.st_size
            if snapshot is not None:
                if (
                    details.st_dev != snapshot.device
                    or details.st_ino != snapshot.inode
                    or details.st_size < snapshot.end_offset
                ):
                    raise OSError("source changed after discovery")
                observed_prefix = source_prefix(handle, snapshot.end_offset)
                if observed_prefix != (
                    snapshot.prefix_length,
                    snapshot.prefix_sha256,
                ):
                    raise OSError("source prefix changed after discovery")
                stable_end = snapshot.end_offset
            initial_empty_growth = (
                state is not None
                and state.prefix_length == 0
                and state.offset == 0
                and state.path == str(path)
                and state.device == details.st_dev
                and state.inode == details.st_ino
                and stable_end > 0
            )
            fingerprint_size = (
                stable_end
                if state is None or initial_empty_growth
                else min(state.prefix_length, stable_end)
            )
            prefix_length, prefix_sha = source_prefix(handle, fingerprint_size)
            if initial_empty_growth:
                state.prefix_length = prefix_length
                state.prefix_sha256 = prefix_sha
            replaced = state is None or not self._same_generation(
                state, path, details, prefix_length, prefix_sha
            )
            legacy_tail = False
            if state is not None and not replaced and state.offset and not self.capture_unterminated_tail:
                handle.seek(state.offset - 1)
                legacy_tail = handle.read(1) != b"\n"
            if legacy_tail:
                # Earlier collectors split this record already. Keep its generation
                # and continue from the durable cursor without replaying history.
                state.recovery_reason = "legacy_unterminated_cursor_continued"
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
            enqueued = captured = 0
            while state.offset < stable_end and captured < byte_budget:
                remaining_budget = byte_budget - captured
                try:
                    if state.pending_fragment is not None:
                        raise _OversizedNativeRecord("resume pending native record")
                    source = self._read_chunk(
                        handle,
                        state.offset,
                        stable_end,
                        min(self.chunk_bytes, remaining_budget),
                        remaining_budget,
                    )
                except _OversizedNativeRecord:
                    # Hash the whole native range without loading its JSON envelope.
                    # Fragment publication can span runs; the logical cursor waits.
                    plan = self._native_record_fragment_plan(
                        handle,
                        state.offset,
                        stable_end,
                    )
                    if not plan.terminated and not self.capture_unterminated_tail:
                        self.source_issues[str(path)] = "incomplete_trailing_record"
                        break
                    pending = state.pending_fragment
                    if pending is not None and pending["plan"] != asdict(plan):
                        raise OSError("pending native source record changed before resume")
                    first_fragment = pending["next_fragment"] if pending else 0
                    # A soft hook budget permits one canonical fragment. Reconcile
                    # honors the strict budget and reports too-small budgets explicitly.
                    fragment_budget = remaining_budget if self.enforce_sync_budget else max(
                        remaining_budget, FRAGMENT_BYTES
                    )
                    if plan.end_offset - plan.start_offset <= MAX_SOURCE_BYTES:
                        raise ContractError(
                            f"native source record exceeds {self.max_object_bytes} bytes"
                        )
                    fragment_enqueued, fragment_captured = self._enqueue_fragments(
                        handle,
                        key,
                        state,
                        plan,
                        native_session_ids.get(str(path)),
                        parent_native_session_ids.get(str(path)),
                        workload_class,
                        first_fragment=first_fragment,
                        byte_budget=fragment_budget,
                    )
                    after = os.fstat(handle.fileno())
                    if (
                        after.st_dev != details.st_dev
                        or after.st_ino != details.st_ino
                        or after.st_size < stable_end
                    ):
                        raise OSError("native source file changed while fragmenting")
                    next_fragment = first_fragment + fragment_enqueued
                    if next_fragment == plan.fragment_count:
                        state.offset = plan.end_offset
                        state.pending_fragment = None
                    elif fragment_enqueued:
                        state.pending_fragment = {
                            "plan": asdict(plan),
                            "next_fragment": next_fragment,
                        }
                    states[key] = state
                    self._save_state(states, candidate_cursor)
                    enqueued += fragment_enqueued
                    captured += fragment_captured
                    if state.offset != plan.end_offset:
                        self.source_issues[str(path)] = (
                            "native_record_fragmentation_in_progress" if fragment_enqueued
                            else "record_exceeds_remaining_run_budget"
                        )
                        break
                    continue
                if not source:
                    handle.seek(max(state.offset, stable_end - 1))
                    self.source_issues[str(path)] = (
                        "incomplete_trailing_record" if handle.read(1) != b"\n"
                        else "record_exceeds_remaining_run_budget"
                    )
                    break
                manifest, stored = build_source_batch(
                    source,
                    source_stream_key=key,
                    generation_key=state.generation_key,
                    generation_seq=state.generation_seq,
                    start_offset=state.offset,
                    source_provider=self.source_provider,
                    source_kind=self.source_kind,
                    observed_native_session_id=native_session_ids.get(str(path)),
                    observed_parent_native_session_id=parent_native_session_ids.get(
                        str(path)
                    ),
                    source_version=self.source_version,
                    codex_version=(
                        self.source_version
                        if self.source_provider == "codex"
                        else None
                    ),
                    collector_version=self.collector_version,
                )
                self.spool.enqueue(
                    manifest,
                    stored,
                    workload_class=workload_class,
                )
                self._capture_enqueued += 1
                self._capture_bytes += len(source)
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
        terminated = False
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
                    f"native source record exceeds {self.max_record_bytes} bytes"
                )
            if newline >= 0:
                terminated = True
                break
        length = end - start
        if length <= self.max_object_bytes:
            raise ContractError("could not locate an oversized native source record")
        return NativeRecordFragmentPlan(
            start_offset=start,
            end_offset=end,
            sha256=digest.hexdigest(),
            fragment_count=(length + FRAGMENT_BYTES - 1) // FRAGMENT_BYTES,
            terminated=terminated,
        )

    def _enqueue_fragments(
        self,
        handle,
        source_stream_key: str,
        state: StreamState,
        plan: NativeRecordFragmentPlan,
        observed_native_session_id: str | None,
        observed_parent_native_session_id: str | None,
        workload_class: str | None,
        *,
        first_fragment: int = 0,
        byte_budget: int,
    ) -> tuple[int, int]:
        record_bytes = plan.end_offset - plan.start_offset
        selected_start = first_fragment * FRAGMENT_BYTES
        selected_end = selected_start
        last_fragment = first_fragment
        while last_fragment < plan.fragment_count:
            end = min((last_fragment + 1) * FRAGMENT_BYTES, record_bytes)
            if end - selected_start > byte_budget:
                break
            selected_end = end
            last_fragment += 1
        if last_fragment == first_fragment:
            return 0, 0
        with tempfile.TemporaryFile(mode="w+b", dir=self.state_root) as staged:
            handle.seek(plan.start_offset)
            digest = hashlib.sha256()
            remaining = record_bytes
            while remaining:
                source = handle.read(min(SCAN_BYTES, remaining))
                if not source:
                    raise OSError("native source record changed while staging")
                digest.update(source)
                relative_start = record_bytes - remaining
                # Stage only this run's fragments while rehashing the entire
                # original range. Scratch usage is bounded by the run budget.
                begin = max(selected_start - relative_start, 0)
                end = min(selected_end - relative_start, len(source))
                if begin < end:
                    staged.write(source[begin:end])
                remaining -= len(source)
            if digest.hexdigest() != plan.sha256:
                raise OSError("native source record changed while staging")

            captured = 0
            for fragment_index in range(first_fragment, last_fragment):
                relative_start = fragment_index * FRAGMENT_BYTES
                start = plan.start_offset + relative_start
                end = min(start + FRAGMENT_BYTES, plan.end_offset)
                staged.seek(relative_start - selected_start)
                source = staged.read(end - start)
                if len(source) != end - start:
                    raise OSError("staged native source record is incomplete")
                manifest, stored = build_source_batch(
                    source,
                    source_stream_key=source_stream_key,
                    generation_key=state.generation_key,
                    generation_seq=state.generation_seq,
                    start_offset=start,
                    source_provider=self.source_provider,
                    source_kind=self.source_kind,
                    observed_native_session_id=observed_native_session_id,
                    observed_parent_native_session_id=observed_parent_native_session_id,
                    source_version=self.source_version,
                    codex_version=(
                        self.source_version if self.source_provider == "codex" else None
                    ),
                    collector_version=self.collector_version,
                    native_record_fragment={
                        "native_record_start_offset": plan.start_offset,
                        "native_record_end_offset": plan.end_offset,
                        "native_record_sha256": plan.sha256,
                        "fragment_index": fragment_index,
                        "fragment_count": plan.fragment_count,
                    },
                )
                self.spool.enqueue(
                    manifest,
                    stored,
                    workload_class=workload_class,
                )
                self._capture_enqueued += 1
                self._capture_bytes += len(source)
                captured += len(source)
        return last_fragment - first_fragment, captured

    def _canonical_path(self, value: Path | str) -> Path:
        path = Path(value).expanduser()
        if self.allowed_root is None:
            return path.resolve()
        if not path.is_absolute():
            path = self.allowed_root / path
        # abspath removes '.' and '..' without following candidate symlinks.
        path = Path(os.path.abspath(path))
        relative = None
        for root in (self.allowed_root_input, self.allowed_root):
            if root is None:
                continue
            try:
                relative = path.relative_to(root)
            except ValueError:
                continue
            break
        if relative is None:
            raise ValueError("capture path is outside allowed_root")
        if not relative.parts:
            raise ValueError("capture path must name a file under allowed_root")
        return self.allowed_root / relative

    def _open_source(self, path: Path) -> BinaryIO:
        if self.allowed_root is None:
            return path.open("rb")
        relative = path.relative_to(self.allowed_root)
        return open_regular_under_root(
            self.allowed_root_input,
            self.allowed_root_input / relative,
        )

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

    def _read_chunk(
        self,
        handle,
        start: int,
        stable_end: int,
        limit: int,
        byte_budget: int,
    ) -> bytes:
        handle.seek(start)
        remaining = stable_end - start
        candidate = handle.read(min(limit, remaining))
        if len(candidate) == remaining:
            if self.capture_unterminated_tail or candidate.endswith(b"\n"):
                return self._limit_records(candidate)
            newline = candidate.rfind(b"\n")
            return (
                self._limit_records(candidate[: newline + 1])
                if newline >= 0
                else b""
            )
        if candidate.endswith(b"\n"):
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
                f"native source record exceeds {self.max_object_bytes} bytes"
            )
        selected = complete if newline < 0 else complete[: newline + 1]
        if len(selected) > byte_budget:
            return b""
        if newline < 0 and not self.capture_unterminated_tail:
            return b""
        return self._limit_records(selected)

    def snapshot_offset(self, path: Path, snapshot: SourceSnapshot, state: StreamState) -> int:
        """Only match a frontier to the generation inspected at discovery."""
        if (state.path, state.device, state.inode) != (str(path), snapshot.device, snapshot.inode):
            return 0
        if state.prefix_length == snapshot.prefix_length:
            matches = state.prefix_sha256 == snapshot.prefix_sha256
        elif state.prefix_length < snapshot.prefix_length:
            try:
                with self._open_source(path) as handle:
                    details = os.fstat(handle.fileno())
                    matches = (details.st_dev, details.st_ino) == (snapshot.device, snapshot.inode) and source_prefix(handle, state.prefix_length) == (state.prefix_length, state.prefix_sha256)
            except (OSError, ValueError):
                matches = False
        else:
            matches = False
        return min(state.offset, snapshot.end_offset) if matches else 0

    def _deferred_snapshots(
        self,
        all_paths: Iterable[str],
        snapshots: Mapping[str, SourceSnapshot],
        states: Mapping[str, StreamState],
    ) -> tuple[int, int]:
        deferred_files = deferred_bytes = 0
        for raw_path in all_paths:
            snapshot = snapshots.get(raw_path)
            if snapshot is None:
                continue
            state = states.get(_stream_key(Path(raw_path)))
            offset = 0
            if state is not None:
                offset = self.snapshot_offset(Path(raw_path), snapshot, state)
            remaining = snapshot.end_offset - offset
            if remaining > 0:
                deferred_files += 1
                deferred_bytes += remaining
        return deferred_files, deferred_bytes

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
        extensions = raw.get("stream_extensions", {})
        if not isinstance(extensions, dict) or not all(
            isinstance(value, dict) and set(value) <= set(STATE_EXTENSION_FIELDS)
            for value in extensions.values()
        ):
            raise ValueError("invalid rollout stream extensions")
        return (
            {
                key: StreamState(**{**value, **extensions.get(key, {})})
                for key, value in raw["streams"].items()
            },
            cursor,
        )

    def _save_state(
        self,
        states: Mapping[str, StreamState],
        candidate_cursor: int,
        update_backup: bool = False,
    ) -> None:
        # Stream entries keep the exact shape older runtimes construct with
        # StreamState(**entry); newer optional fields live beside them. A rollback
        # then ignores (and drops) the extensions instead of failing every capture.
        streams = {}
        extensions = {}
        for key, state in states.items():
            entry = asdict(state)
            extra = {
                field: entry.pop(field)
                for field in STATE_EXTENSION_FIELDS
                if entry.get(field) is not None
            }
            for field in STATE_EXTENSION_FIELDS:
                entry.pop(field, None)
            streams[key] = entry
            if extra:
                extensions[key] = extra
        value = {
            "state_version": 1,
            "candidate_cursor": candidate_cursor,
            "streams": streams,
        }
        if extensions:
            value["stream_extensions"] = extensions
        _atomic_json(
            self.state_path,
            value,
        )
        if update_backup:
            _atomic_json(self.state_backup_path, value)
